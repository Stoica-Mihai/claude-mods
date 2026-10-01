import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { GuardrailsBlock, GuardrailsStatus } from '../types'
import { check, compile } from './rules'
import type { Block, Compiled } from './rules'

const PANE = 'blocked'
const HISTORY_LIMIT = 500

const session = atom({ plugin: 'guardrails', key: 'session' } as const, [])
const history = atom({ plugin: 'guardrails', key: 'history' } as const, [])
const totals = atom({ plugin: 'guardrails', key: 'totals' } as const, {})
const status = atom({ plugin: 'guardrails', key: 'status' } as const, { path: '', ruleCount: 0, errors: [] })

const time = (at: number): string => new Date(at).toTimeString().slice(0, 5)

const oneLine = (text: string): string => text.replace(/\s*\n\s*/g, ' ⏎ ')

const describe = ({ path, ruleCount, errors }: GuardrailsStatus): string =>
  path === ''
    ? 'No rules file is set, so nothing is blocked. Set rulesFile with /plugin configure guardrails@claude-mods.'
    : errors.length > 0
      ? `The rules file ${path} has errors, so nothing is blocked: ${errors.join('; ')}`
      : `${ruleCount} rule${ruleCount === 1 ? '' : 's'} from ${path}.`

// The module's view of the rules file; a reload starts these over and session.start fills them again.
let setting = ''
let rules: Compiled[] = []
let loadedAt: number | null = null
// Fallback until session.start measures it; only a contained rule's job cap reads it.
let cores = 4

// Reads the rules file again whenever its modification time changes; a missing or broken file blocks nothing.
async function load($: EngineInterface): Promise<void> {
  const home = (await $.env.get('HOME')) ?? ''
  const path = setting.startsWith('~/') ? `${home}${setting.slice(1)}` : setting
  if (path === '') {
    await update($, status, () => ({ path, ruleCount: 0, errors: [] }))
    return
  }

  const stat = await $.fs.stat(path).catch(() => null)
  const modified = stat?.mtimeMs ?? -1
  if (modified === loadedAt) return
  loadedAt = modified

  let compiled: ReturnType<typeof compile>
  if (stat === null) {
    compiled = { rules: [], errors: ['the file does not exist'] }
  } else {
    try {
      compiled = compile(JSON.parse(String(await $.fs.read(path))))
    } catch (error) {
      compiled = { rules: [], errors: [error instanceof Error ? error.message : String(error)] }
    }
  }
  rules = compiled.rules
  const loaded: GuardrailsStatus = { path, ruleCount: rules.length, errors: compiled.errors }
  await update($, status, () => loaded)
  if (loaded.errors.length > 0) $.ui.toast(`guardrails: ${describe(loaded)}`)
}

export const register: Register = (on, options) => {
  setting = typeof options.rulesFile === 'string' ? options.rulesFile.trim() : ''
  rules = []
  loadedAt = null

  on('session.start', async ($, e, next) => {
    await $.command.register({ name: 'blocked', description: 'Show the Bash commands the guardrails blocked' })

    const nproc = await $.process.run(['nproc']).catch(() => null)
    const parsed = Number(nproc?.stdout.trim())
    if (Number.isInteger(parsed) && parsed > 0) cores = parsed

    await load($).catch(() => {})

    const stored = await $.store.get('history')
    const storedTotals = await $.store.get('totals')
    if (Array.isArray(stored)) await update($, history, () => stored as GuardrailsBlock[])
    if (storedTotals !== undefined) await update($, totals, () => storedTotals as Record<string, number>)

    return next(e)
  })

  const denial = (blocks: Block[]): string => blocks.map(block => block.reason).join('\n\n')

  // Bookkeeping failures are swallowed: a hook that throws is skipped, which would let the command run.
  on('tool.call', { tool: 'Bash' }, async ($, e, next) => {
    await load($).catch(() => {})
    const blocks = check(e.command, rules, { cores })
    if (blocks.length === 0) return next(e)

    const record = { rules: blocks.map(block => block.rule), command: e.command, reason: denial(blocks) }
    try {
      const block: GuardrailsBlock = { at: await $.clock.now(), ...record }
      await update($, session, list => [...list, block])
      const kept = await update($, history, list => [...list, block].slice(-HISTORY_LIMIT))
      const counted = await update($, totals, sum => {
        const added = { ...sum }
        for (const rule of block.rules) added[rule] = (added[rule] ?? 0) + 1
        return added
      })
      await $.store.set('history', kept)
      await $.store.set('totals', counted)
      $.ui.toast(`guardrails blocked: ${block.rules.join(', ')} — /blocked to review`)
    } catch {}

    return { deny: record.reason }
  }).catch(($, e, next) => {
    // Fails closed: if the hook itself failed, the rules loaded last still decide, without the history.
    const blocks = check(e.command, rules, { cores })
    return blocks.length === 0 ? next(e) : { deny: denial(blocks) }
  })

  on('command.run', { command: 'blocked' }, async $ => {
    await load($).catch(() => {})
    const opened = await $.ui.open({ id: PANE, title: 'Blocked' })
    const thisSession = (await read($, session)).length
    const allTime = Object.values(await read($, totals)).reduce((a, b) => a + b, 0)
    const summary = `${describe(await read($, status))} ${thisSession} blocked this session, ${allTime} all time.`

    return { text: opened.isPlaced ? summary : `${summary} The pane is waiting: ${opened.reason}` }
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const { Box, Text } = $.ui.resolve(e)
    const thisSession = await read($, session)
    const list = await read($, history)
    const sums = await read($, totals)
    const state = await read($, status)
    const allTime = Object.values(sums).reduce((a, b) => a + b, 0)
    const room = Math.max(1, (e.viewport?.rows ?? 24) - 7)
    const nameWidth = Math.max(8, ...list.map(block => block.rules.join(',').length))
    const width = Math.max(20, e.props.bodyColumns - nameWidth - 8)
    const recent = list.slice(-room).reverse()

    return (
      <Box flexDirection="column">
        <Text color={state.errors.length > 0 ? 'red' : undefined} dimColor={state.errors.length === 0}>
          {describe(state)}
        </Text>
        <Text bold>
          This session {thisSession.length} · all time {allTime}
        </Text>
        {recent.length === 0 && <Text dimColor>Nothing blocked yet.</Text>}
        {recent.map(block => (
          <Box key={`${block.at}-${block.command.slice(0, 16)}`}>
            <Text dimColor>{time(block.at)} </Text>
            <Text color="red">{block.rules.join(',').padEnd(nameWidth)} </Text>
            <Text wrap="truncate-end">{oneLine(block.command).slice(0, width)}</Text>
          </Box>
        ))}
        {allTime > 0 && (
          <Text dimColor>
            {Object.entries(sums)
              .map(([rule, count]) => `${rule} ${count}`)
              .join(' · ')}
          </Text>
        )}
      </Box>
    )
  })
}
