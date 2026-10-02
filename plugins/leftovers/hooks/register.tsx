import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { LeftoversScan } from '../types'
import { byCall, clip, describe, leftovers, parse, SCAN_SCRIPT, short } from './scan'

const PANE = 'leftovers'
const CALL_LIMIT = 200

const key = atom({ plugin: 'leftovers', key: 'key' } as const, '')
const calls = atom({ plugin: 'leftovers', key: 'calls' } as const, [])
const reported = atom({ plugin: 'leftovers', key: 'reported' } as const, [])
const scan = atom({ plugin: 'leftovers', key: 'scan' } as const, { at: 0, procs: [], error: null })

// Bash calls in flight: the tag is set while any runs, so their children inherit it and nothing else does.
let inFlight = 0
let ignore: RegExp | null = null

async function tagValue($: EngineInterface): Promise<string> {
  const current = await read($, key)
  if (current !== '') return current
  return update($, key, value => (value === '' ? crypto.randomUUID() : value))
}

async function rescan($: EngineInterface): Promise<LeftoversScan> {
  const now = await $.clock.now()
  const value = await tagValue($)
  const history = [...(await read($, calls))]
  const result = await $.process
    .run(['sh', '-c', SCAN_SCRIPT], { env: { TAG_VALUE: value }, timeoutMs: 10000 })
    .then(ran => ({ procs: parse(ran.stdout, now, history), error: null }))
    .catch((error: unknown) => ({ procs: [], error: error instanceof Error ? error.message : String(error) }))
  const next: LeftoversScan = { at: now, ...result }
  await update($, scan, () => next)
  return next
}

// Stops one process by pid, after checking it is still the tagged, detached process the scan saw.
async function stop($: EngineInterface, id: string): Promise<void> {
  const before = await rescan($)
  const proc = before.procs.find(one => one.id === id && !one.isAttached)
  if (proc === undefined) return
  await $.process.run(['kill', String(proc.pid)]).catch(() => null)
  await rescan($)
}

async function stopAll($: EngineInterface): Promise<void> {
  const before = await rescan($)
  for (const proc of leftovers(before.procs, null)) {
    await $.process.run(['kill', String(proc.pid)]).catch(() => null)
  }
  await rescan($)
}

export const register: Register = (on, options) => {
  const mode = options.onLeftover === 'follow-up' || options.onLeftover === 'off' ? options.onLeftover : 'note'
  const pattern = typeof options.ignore === 'string' ? options.ignore : ''
  try {
    ignore = pattern === '' ? null : new RegExp(pattern)
  } catch {
    ignore = null
  }

  on('session.start', async ($, e, next) => {
    await $.command.register({ name: 'leftovers', description: 'List the processes Bash calls left running' })
    await tagValue($)
    return next(e)
  })

  on('tool.call', { tool: 'Bash' }, async ($, e, next) => {
    const at = await $.clock.now()
    await update($, calls, list => [...list, { at, end: null, command: e.command }].slice(-CALL_LIMIT))
    inFlight += 1
    if (inFlight === 1) await $.env.set('CLAUDE_LEFTOVERS_TAG', await tagValue($))
    try {
      return await next(e)
    } finally {
      inFlight -= 1
      if (inFlight === 0) await $.env.set('CLAUDE_LEFTOVERS_TAG', undefined)
      const end = await $.clock.now()
      await update($, calls, list => list.map(call => (call.at === at && call.end === null ? { ...call, end } : call)))
    }
  })

  // A main turn that ends with new leftovers: follow-up queues a turn for Claude to deal with them, note tells it
  // at its next turn. Mods cannot hook the settings Stop event, so the turn itself cannot be held open.
  on('turn.complete', async ($, e, next) => {
    const result = await next(e)
    if (mode === 'off' || e.agentId !== undefined || e.isAborted) return result

    const found = await rescan($)
    const seen = new Set(await read($, reported))
    const fresh = leftovers(found.procs, ignore).filter(proc => !seen.has(proc.id))
    if (fresh.length === 0) return result

    await update($, reported, list => [...list, ...fresh.map(proc => proc.id)])
    const text = describe(fresh)
    $.ui.toast(`leftovers: ${fresh.length} process${fresh.length === 1 ? '' : 'es'} still running — /leftovers`)

    if (mode === 'follow-up') void $.prompt.submit({ text }).catch(() => null)
    else await $.session.append({ message: { type: 'user', content: [{ type: 'text', text }] } }).catch(() => null)
    return result
  })

  on('command.run', { command: 'leftovers' }, async $ => {
    const found = await rescan($)
    const opened = await $.ui.open({ id: PANE, title: 'Leftovers' })
    const detached = leftovers(found.procs, null).length
    const tasks = byCall(found.procs.filter(proc => proc.isAttached)).length
    const summary =
      found.error !== null
        ? `Could not list processes: ${found.error}`
        : `${detached} left running, ${tasks} background task${tasks === 1 ? '' : 's'}.`
    return { text: opened.isPlaced ? summary : `${summary} The pane is waiting: ${opened.reason}` }
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const { Box, Button, Text } = $.ui.resolve(e)
    const found = await read($, scan)
    const detached = found.procs.filter(proc => !proc.isAttached)
    const attached = found.procs.filter(proc => proc.isAttached)
    const tasks = byCall(attached)
    const width = Math.max(20, e.props.bodyColumns - 18)
    const time = found.at === 0 ? 'not scanned yet' : `scanned ${new Date(found.at).toTimeString().slice(0, 8)}`

    return (
      <Box flexDirection="column">
        <Box>
          <Text dimColor>{time} </Text>
          <Button key="refresh" label="Refresh" onPress={() => rescan($)} />
          <Text> </Text>
          <Button key="stop-all" label="Stop all" dimColor={detached.length === 0} onPress={() => stopAll($)} />
        </Box>
        {found.error !== null && <Text color="red">{found.error}</Text>}
        <Text bold>Left running ({detached.length})</Text>
        {detached.length === 0 && <Text dimColor>None.</Text>}
        {detached.map(proc => (
          <Box key={proc.id}>
            <Button key={`stop-${proc.pid}`} label="Stop" onPress={() => stop($, proc.id)} />
            <Text> {proc.pid} </Text>
            <Text wrap="truncate-end">{clip(short(proc.args), width)}</Text>
          </Box>
        ))}
        <Text bold>Under background tasks ({tasks.length})</Text>
        {tasks.length === 0 && <Text dimColor>None.</Text>}
        {tasks.map(([from, group]) => (
          <Box key={`task-${group[0]!.id}`}>
            <Text dimColor wrap="truncate-end">
              {clip(from, width)} · {group.length} process{group.length === 1 ? '' : 'es'}
            </Text>
          </Box>
        ))}
      </Box>
    )
  })
}
