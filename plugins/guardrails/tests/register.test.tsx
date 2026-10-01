import type { On } from 'claude-code'
import { expect, mock, test } from 'claude-code/testing'

const PANE_PROPS = { title: 'Blocked', isFocused: false, bodyColumns: 100, placement: 'dock' } as never

const ALL_ON = {
  options: { blockWaitLoops: true, blockPrCreation: true, blockShellSourceWrites: true, blockUncontainedBuilds: true },
}

const bashTool = (on: On, seen: string[]) =>
  on('tool.call', { tool: 'Bash' }, (_$, e) => {
    seen.push(e.command)
    return { result: { stdout: '', stderr: '', interrupted: false } } as never
  })

test('installed with its defaults, the mod blocks nothing', async ($, on) => {
  mock.clock(on)
  mock.store(on)
  const seen: string[] = []
  bashTool(on, seen)

  await $.tool.call({ tool: 'Bash', command: 'git push && gh pr create' })
  await $.tool.call({ tool: 'Bash', command: 'sed -i s/a/b/ src/main.ts' })

  expect(seen).toEqual(['git push && gh pr create', 'sed -i s/a/b/ src/main.ts'])
})

test('only the rules switched on block', { options: { blockPrCreation: true } }, async ($, on) => {
  mock.clock(on)
  mock.store(on)
  const seen: string[] = []
  bashTool(on, seen)

  await $.tool.call({ tool: 'Bash', command: 'git push && gh pr create' })
  await $.tool.call({ tool: 'Bash', command: 'sed -i s/a/b/ src/main.ts' })

  expect(seen).toEqual(['sed -i s/a/b/ src/main.ts'])
})

test('a blocked command is denied with its reason and never reaches the tool', ALL_ON, async ($, on) => {
  mock.clock(on)
  mock.store(on)
  const seen: string[] = []
  bashTool(on, seen)

  const ran = await $.tool.call({ tool: 'Bash', command: 'git push && gh pr create' })

  expect(seen).toEqual([])
  expect(JSON.stringify(ran)).toContain('PR/MR creation is blocked')
})

test('the deny still holds when the history cannot be written', ALL_ON, async ($, on) => {
  const seen: string[] = []
  bashTool(on, seen)

  const ran = await $.tool.call({ tool: 'Bash', command: 'sed -i s/a/b/ src/main.ts' })

  expect(seen).toEqual([])
  expect(JSON.stringify(ran)).toContain('Editing a source file through Bash is blocked')
})

test('a harmless command passes through to the tool', ALL_ON, async ($, on) => {
  mock.clock(on)
  mock.store(on)
  const seen: string[] = []
  bashTool(on, seen)

  await $.tool.call({ tool: 'Bash', command: 'ls -la' })

  expect(seen).toEqual(['ls -la'])
})

test('/blocked and the pane report what was blocked', ALL_ON, async ($, on) => {
  mock.clock(on, { now: Date.UTC(2026, 9, 1, 21, 14) })
  mock.store(on)
  on('ui.open', () => ({ value: { isPlaced: true } }))
  bashTool(on, [])

  await $.tool.call({ tool: 'Bash', command: 'sed -i s/a/b/ src/main.ts' })
  await $.tool.call({ tool: 'Bash', command: 'until true; do :; done' })
  await $.tool.call({ tool: 'Bash', command: 'ls -la' })

  const ran = await $.command.run({ command: 'blocked', args: '' } as never)
  expect(ran.text).toBe('2 blocked this session, 2 all time.')

  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await $.ui.mount({ plugin: 'guardrails', surface, component: 'Pane', requestId: 'blocked', props: PANE_PROPS })
    expect(await ui.find({ type: 'Text', text: 'This session 2 · all time 2' })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: 'sed -i s/a/b/ src/main.ts' })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: 'keywords 1 · patterns 0 · source-writes 1 · builds 0' })).toBeDefined()
    await ui.unmount()
  }
})
