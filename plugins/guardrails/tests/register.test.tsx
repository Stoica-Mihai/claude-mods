import type { On } from 'claude-code'
import { expect, mock, test } from 'claude-code/testing'

const PANE_PROPS = { title: 'Blocked', isFocused: false, bodyColumns: 100, placement: 'dock' } as never

const RULES = JSON.stringify({
  rules: [
    { kind: 'pattern', name: 'pr-creation', match: 'gh\\s+pr\\s+create', reason: 'Merge to main instead.' },
    { kind: 'pattern', name: 'wait-loops', match: '(^|[;&|(])\\s*until(\\s|;|$)', reason: 'Background it instead.' },
    { kind: 'source-writes', name: 'source-writes', reason: 'Use Edit.' },
  ],
})

const WITH_FILE = { options: { rulesFile: '~/rules.json' } }

const bashTool = (on: On, seen: string[]) =>
  on('tool.call', { tool: 'Bash' }, (_$, e) => {
    seen.push(e.command)
    return { result: { stdout: '', stderr: '', interrupted: false } } as never
  })

// Serves one rules file at /home/u/rules.json; `file.text` and `file.mtimeMs` can change mid-test.
const rulesFile = (on: On, text: string | null) => {
  const file = { text, mtimeMs: 1 }
  mock.env(on, { HOME: '/home/u' })
  on('fs.stat', (_$, e) =>
    e.path === '/home/u/rules.json' && file.text !== null
      ? ({ value: { kind: 'file', size: file.text.length, mtimeMs: file.mtimeMs, isLink: false } } as never)
      : ({ deny: `ENOENT: ${e.path}` } as never),
  )
  on('fs.read', (_$, e) =>
    e.path === '/home/u/rules.json' && file.text !== null ? ({ value: file.text } as never) : ({ deny: 'ENOENT' } as never),
  )
  return file
}

test('with no rules file set, nothing is blocked', async ($, on) => {
  mock.clock(on)
  mock.store(on)
  const seen: string[] = []
  bashTool(on, seen)

  await $.tool.call({ tool: 'Bash', command: 'git push && gh pr create' })
  await $.tool.call({ tool: 'Bash', command: 'sed -i s/a/b/ src/main.ts' })

  expect(seen).toEqual(['git push && gh pr create', 'sed -i s/a/b/ src/main.ts'])
})

test("the user's rules decide what is blocked", WITH_FILE, async ($, on) => {
  mock.clock(on)
  mock.store(on)
  rulesFile(on, RULES)
  const seen: string[] = []
  bashTool(on, seen)

  const ran = await $.tool.call({ tool: 'Bash', command: 'git push && gh pr create' })
  await $.tool.call({ tool: 'Bash', command: 'git push origin main' })

  expect(seen).toEqual(['git push origin main'])
  expect(JSON.stringify(ran)).toContain('Merge to main instead.')
})

test('an edited rules file is read again', WITH_FILE, async ($, on) => {
  mock.clock(on)
  mock.store(on)
  const file = rulesFile(on, RULES)
  const seen: string[] = []
  bashTool(on, seen)

  await $.tool.call({ tool: 'Bash', command: 'git push && gh pr create' })
  file.text = JSON.stringify({ rules: [] })
  file.mtimeMs = 2
  await $.tool.call({ tool: 'Bash', command: 'git push && gh pr create' })

  expect(seen).toEqual(['git push && gh pr create'])
})

test('a broken or missing rules file blocks nothing and says why', WITH_FILE, async ($, on) => {
  mock.clock(on)
  mock.store(on)
  on('ui.open', () => ({ value: { isPlaced: true } }))
  const file = rulesFile(on, '{ "rules": [ { "kind": "pattern", "name": "x", "match": "(", "reason": "r" } ] }')
  const seen: string[] = []
  bashTool(on, seen)

  await $.tool.call({ tool: 'Bash', command: 'echo (' })
  const broken = await $.command.run({ command: 'blocked', args: '' } as never)
  file.text = null
  file.mtimeMs = 3
  await $.tool.call({ tool: 'Bash', command: 'ls' })
  const missing = await $.command.run({ command: 'blocked', args: '' } as never)

  expect(seen).toEqual(['echo (', 'ls'])
  expect(broken.text).toContain('The rules file /home/u/rules.json has errors, so nothing is blocked: rule 1 (x):')
  expect(missing.text).toContain('has errors, so nothing is blocked: the file does not exist')
})

test('the deny still holds when the history cannot be written', WITH_FILE, async ($, on) => {
  rulesFile(on, RULES)
  const seen: string[] = []
  bashTool(on, seen)

  const ran = await $.tool.call({ tool: 'Bash', command: 'sed -i s/a/b/ src/main.ts' })

  expect(seen).toEqual([])
  expect(JSON.stringify(ran)).toContain('Use Edit. (src/main.ts)')
})

test('/blocked and the pane report the rules file and what was blocked', WITH_FILE, async ($, on) => {
  mock.clock(on, { now: Date.UTC(2026, 9, 1, 21, 14) })
  mock.store(on)
  on('ui.open', () => ({ value: { isPlaced: true } }))
  rulesFile(on, RULES)
  bashTool(on, [])

  await $.tool.call({ tool: 'Bash', command: 'sed -i s/a/b/ src/main.ts' })
  await $.tool.call({ tool: 'Bash', command: 'until true; do :; done' })
  await $.tool.call({ tool: 'Bash', command: 'ls -la' })

  const ran = await $.command.run({ command: 'blocked', args: '' } as never)
  expect(ran.text).toBe('3 rules from /home/u/rules.json. 2 blocked this session, 2 all time.')

  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await $.ui.mount({ plugin: 'guardrails', surface, component: 'Pane', requestId: 'blocked', props: PANE_PROPS })
    expect(await ui.find({ type: 'Text', text: '3 rules from /home/u/rules.json.' })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: 'This session 2 · all time 2' })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: 'sed -i s/a/b/ src/main.ts' })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: 'source-writes 1 · wait-loops 1' })).toBeDefined()
    await ui.unmount()
  }
})
