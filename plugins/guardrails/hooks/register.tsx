import { atom, read, update } from 'claude-code'
import type { Register } from 'claude-code'

import type { GuardrailsBlock, GuardrailsTotals } from '../types'
import { check } from './rules'
import type { Block } from './rules'

const PANE = 'blocked'
const HISTORY_LIMIT = 500
const ZERO: GuardrailsTotals = { keywords: 0, patterns: 0, 'source-writes': 0, builds: 0 }

const session = atom({ plugin: 'guardrails', key: 'session' } as const, [])
const history = atom({ plugin: 'guardrails', key: 'history' } as const, [])
const totals = atom({ plugin: 'guardrails', key: 'totals' } as const, ZERO)

const time = (at: number): string => new Date(at).toTimeString().slice(0, 5)

const oneLine = (text: string): string => text.replace(/\s*\n\s*/g, ' ⏎ ')

export const register: Register = on => {
  // nproc fallback matches the shell hook's; unknown until session.start resolves it.
  let cores = 4

  on('session.start', async ($, e, next) => {
    await $.command.register({ name: 'blocked', description: 'Show the Bash commands the guardrails blocked' })

    const nproc = await $.process.run(['nproc']).catch(() => null)
    const parsed = Number(nproc?.stdout.trim())
    if (Number.isInteger(parsed) && parsed > 0) cores = parsed

    const stored = await $.store.get('history')
    const storedTotals = await $.store.get('totals')
    if (Array.isArray(stored)) await update($, history, () => stored as GuardrailsBlock[])
    if (storedTotals !== undefined) await update($, totals, () => ({ ...ZERO, ...(storedTotals as GuardrailsTotals) }))

    return next(e)
  })

  const denial = (blocks: Block[]): string => blocks.map(block => block.reason).join('\n\n')

  // Bookkeeping failures are swallowed: a hook that throws is skipped, which would let the command run.
  on('tool.call', { tool: 'Bash' }, async ($, e, next) => {
    const blocks = check(e.command, { cores })
    if (blocks.length === 0) return next(e)

    const record = { rules: blocks.map(block => block.rule), command: e.command, reason: denial(blocks) }
    try {
      const block: GuardrailsBlock = { at: await $.clock.now(), ...record }
      await update($, session, list => [...list, block])
      const kept = await update($, history, list => [...list, block].slice(-HISTORY_LIMIT))
      const counted = await update($, totals, sum => {
        const added = { ...sum }
        for (const rule of block.rules) added[rule] += 1
        return added
      })
      await $.store.set('history', kept)
      await $.store.set('totals', counted)
      $.ui.toast(`guardrails blocked: ${block.rules.join(', ')} — /blocked to review`)
    } catch {}

    return { deny: record.reason }
  }).catch(($, e, next) => {
    // Fails closed: if the hook itself failed, the rules still decide without the history.
    const blocks = check(e.command, { cores })
    return blocks.length === 0 ? next(e) : { deny: denial(blocks) }
  })

  on('command.run', { command: 'blocked' }, async $ => {
    const opened = await $.ui.open({ id: PANE, title: 'Blocked' })
    const thisSession = (await read($, session)).length
    const allTime = Object.values(await read($, totals)).reduce((a, b) => a + b, 0)
    const summary = `${thisSession} blocked this session, ${allTime} all time.`

    return { text: opened.isPlaced ? summary : `${summary} The pane is waiting: ${opened.reason}` }
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const { Box, Text } = $.ui.resolve(e)
    const thisSession = await read($, session)
    const list = await read($, history)
    const sums = await read($, totals)
    const allTime = Object.values(sums).reduce((a, b) => a + b, 0)
    const room = Math.max(1, (e.viewport?.rows ?? 24) - 6)
    const width = Math.max(20, e.props.bodyColumns - 26)
    const recent = list.slice(-room).reverse()

    return (
      <Box flexDirection="column">
        <Text bold>
          This session {thisSession.length} · all time {allTime}
        </Text>
        {recent.length === 0 && <Text dimColor>Nothing blocked yet.</Text>}
        {recent.map(block => (
          <Box key={`${block.at}-${block.command.slice(0, 16)}`}>
            <Text dimColor>{time(block.at)} </Text>
            <Text color="red">{block.rules.join(',').padEnd(14).slice(0, 14)} </Text>
            <Text wrap="truncate-end">{oneLine(block.command).slice(0, width)}</Text>
          </Box>
        ))}
        <Text dimColor>
          {Object.entries(sums)
            .map(([rule, count]) => `${rule} ${count}`)
            .join(' · ')}
        </Text>
      </Box>
    )
  })
}
