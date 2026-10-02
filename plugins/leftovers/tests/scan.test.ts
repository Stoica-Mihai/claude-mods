import { expect, test } from 'claude-code/testing'

import { attribute, describe, leftovers, parse, short } from '../hooks/scan'

const NOW = 1_000_000_000
const CALLS = [
  { at: NOW - 600_000, end: NOW - 599_000, command: 'nohup sleep 900 &' },
  { at: NOW - 60_000, end: NOW - 59_000, command: 'wezterm start -- claude' },
]

const STDOUT = [
  '5001\t774\t9000\t0\t590\tsleep 900',
  '5002\t5001\t9100\t1\t30\tbash -c tail -f log',
  '5003\t774\t9200\t0\t55\t/usr/bin/wezterm-gui start -- claude',
  '',
].join('\n')

test('parse reads each tagged process and names the Bash call that started it', async () => {
  const procs = parse(STDOUT, NOW, CALLS)
  expect(procs.map(proc => [proc.pid, proc.isAttached, proc.from])).toEqual([
    [5001, false, 'nohup sleep 900 &'],
    [5003, false, 'wezterm start -- claude'],
    [5002, true, 'wezterm start -- claude'],
  ])
  expect(procs[0]!.id).toBe('5001:9000')
  expect(procs[0]!.startedAt).toBe(NOW - 590_000)
})

test('a process started before any recorded call has no origin', async () => {
  expect(attribute(NOW - 700_000, CALLS)).toBeNull()
})

test('only detached processes are leftovers, and the ignore pattern hides matches', async () => {
  const procs = parse(STDOUT, NOW, CALLS)
  expect(leftovers(procs, null).map(proc => proc.pid)).toEqual([5001, 5003])
  expect(leftovers(procs, /wezterm/).map(proc => proc.pid)).toEqual([5001])
})

test('the note gives each leftover a pid and short name, one line per Bash call', async () => {
  const text = describe(leftovers(parse(STDOUT, NOW, CALLS), null))
  expect(text).toBe(
    [
      "Still running, detached, from this session's Bash calls:",
      '- 5001 sleep 900 (from: nohup sleep 900 &)',
      '- 5003 wezterm-gui start -- claude (from: wezterm start -- claude)',
      'Stop the ones no longer needed by pid, or tell the user why they stay. /leftovers lists them.',
    ].join('\n'),
  )
})

test('long command lines are cut short and processes from one call share its line', async () => {
  const flags = '--monitor-self --database=/home/u/.config/chromium/Crash Reports --annotation=channel=Arch'
  const call = 'node --check scripts/verify.mjs && .venv/bin/python scripts/page_server.py --run node scripts/verify.mjs'
  const procs = parse(
    `7001\t774\t1\t0\t0\t/usr/lib/chromium/chrome_crashpad_handler ${flags}\n7002\t774\t2\t0\t0\t/usr/lib/chromium/chrome_crashpad_handler ${flags}\n`,
    NOW,
    [{ at: NOW, end: NOW, command: call }],
  )
  const lines = describe(procs).split('\n')
  expect(lines).toHaveLength(3)
  expect(lines[1]).toBe(
    `- 7001 ${short(procs[0]!.args)}; 7002 ${short(procs[1]!.args)} (from: ${call.slice(0, 79)}…)`,
  )
  expect(short(procs[0]!.args)).toBe('chrome_crashpad_handler --monitor-self --database=/home/u/.…')
  expect(short(procs[0]!.args)).toHaveLength(60)
})
