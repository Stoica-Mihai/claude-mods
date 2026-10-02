import type { On } from 'claude-code'
import { expect, mock, test } from 'claude-code/testing'

const PANE_PROPS = { title: 'Leftovers', isFocused: false, bodyColumns: 100, placement: 'dock' } as never

// The machine beneath the plugin: a scan answers with `world.stdout`, every other command is recorded.
const machine = (on: On, stdout: string) => {
  const world = {
    stdout,
    ran: [] as string[][],
    env: [] as [string, string | undefined][],
    toasts: [] as string[],
    prompts: [] as string[],
  }
  mock.clock(on, { now: 1_000_000_000 })
  on('env.set', (_$, e) => {
    world.env.push([e.name, e.value])
    return { value: undefined } as never
  })
  on('process.run', (_$, e) => {
    world.ran.push([...e.argv])
    const out = e.argv[0] === 'sh' ? world.stdout : ''
    return { value: { exitCode: 0, stdout: out, stderr: '', isStdoutTruncated: false, isStderrTruncated: false } } as never
  })
  // Every report comes with a toast; the kit has no conversation, so a note is observed through it.
  on('ui.toast', (_$, e) => {
    world.toasts.push(e.text)
    return { value: undefined } as never
  })
  on('prompt.submit', (_$, e) => {
    world.prompts.push(e.text)
    return { text: e.text } as never
  })
  on('tool.call', { tool: 'Bash' }, () => ({ result: { stdout: '', stderr: '', interrupted: false } }) as never)
  on('turn.complete', (_$, e) => ({ text: e.answer }) as never)
  return world
}

const LEFTOVER = '5001\t774\t9000\t0\t30\tsleep 900\n'
const ATTACHED = '5002\t4000\t9100\t1\t30\ttail -f log\n'
const TURN = { answer: 'done', durationMs: 10, isAborted: false, turnId: 't', reason: 'answer' } as never
const SUBAGENT_TURN = { answer: 'done', durationMs: 10, isAborted: false, turnId: 't', reason: 'answer', agentId: 'a1' } as never

test('the tag is set only while a Bash call runs', async ($, on) => {
  const world = machine(on, '')
  await $.tool.call({ tool: 'Bash', command: 'ls' })

  expect(world.env.map(([name, value]) => [name, value === undefined ? 'unset' : 'set'])).toEqual([
    ['CLAUDE_LEFTOVERS_TAG', 'set'],
    ['CLAUDE_LEFTOVERS_TAG', 'unset'],
  ])
})

test('follow-up: a turn ending with a leftover queues one turn naming it', { options: { onLeftover: 'follow-up' } }, async ($, on) => {
  // The mocked clock stands still, so the process is 0 seconds old: started during the call.
  const world = machine(on, '5001\t774\t9000\t0\t0\tsleep 900\n' + ATTACHED)
  await $.tool.call({ tool: 'Bash', command: 'nohup sleep 900 &' })

  await $.turn.complete(TURN)
  await $.turn.complete(TURN)

  expect(world.prompts).toHaveLength(1)
  expect(world.prompts[0]).toContain('- 5001 sleep 900 (from: nohup sleep 900 &)')
  expect(world.prompts[0]).not.toContain('5002')
})

test('note: the leftover is reported once, without a new turn', async ($, on) => {
  const world = machine(on, LEFTOVER)

  await $.turn.complete(TURN)
  await $.turn.complete(TURN)

  expect(world.prompts).toEqual([])
  expect(world.toasts).toEqual(['leftovers: 1 process still running — /leftovers'])
})

test("a subagent's turn, an attached process and a clean turn report nothing", { options: { onLeftover: 'follow-up' } }, async ($, on) => {
  const world = machine(on, LEFTOVER)
  await $.turn.complete(SUBAGENT_TURN)
  world.stdout = ATTACHED
  await $.turn.complete(TURN)
  world.stdout = ''
  await $.turn.complete(TURN)

  expect(world.prompts).toEqual([])
  expect(world.toasts).toEqual([])
})

test('an ignored leftover is never reported', { options: { onLeftover: 'follow-up', ignore: 'sleep 9' } }, async ($, on) => {
  const world = machine(on, LEFTOVER)
  await $.turn.complete(TURN)
  expect(world.prompts).toEqual([])
  expect(world.toasts).toEqual([])
})

test('off never reports', { options: { onLeftover: 'off' } }, async ($, on) => {
  const world = machine(on, LEFTOVER)
  await $.turn.complete(TURN)
  expect(world.prompts).toEqual([])
  expect(world.toasts).toEqual([])
})

test('/leftovers lists them, and Stop kills only the leftover it names', async ($, on) => {
  const world = machine(on, LEFTOVER + ATTACHED)
  on('ui.open', () => ({ value: { isPlaced: true } }))

  const ran = await $.command.run({ command: 'leftovers', args: '' } as never)
  expect(ran.text).toBe('1 left running, 1 under background tasks.')

  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await $.ui.mount({ plugin: 'leftovers', surface, component: 'Pane', requestId: 'leftovers', props: PANE_PROPS })
    expect(await ui.find({ type: 'Text', text: 'Left running (1)' })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: 'Under background tasks (1)' })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: 'sleep 900' })).toBeDefined()
    await ui.unmount()
  }

  const ui = await $.ui.mount({ plugin: 'leftovers', surface: 'terminal', component: 'Pane', requestId: 'leftovers', props: PANE_PROPS })
  world.ran.length = 0
  await ui.press({ key: 'stop-5001' })
  expect(world.ran.filter(argv => argv[0] === 'kill')).toEqual([['kill', '5001']])
})
