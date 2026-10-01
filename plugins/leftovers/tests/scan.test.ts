import { expect, test } from 'claude-code/testing'

import { attribute, describe, leftovers, parse } from '../hooks/scan'

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

test('the note names each leftover by pid with its command and origin', async () => {
  const text = describe(leftovers(parse(STDOUT, NOW, CALLS), null), NOW)
  expect(text).toContain('- pid 5001, running 9m: sleep 900\n  started by: nohup sleep 900 &')
  expect(text).toContain('- pid 5003, running under a minute: /usr/bin/wezterm-gui start -- claude')
  expect(text).toContain('Stop each one that is no longer needed by its pid')
})
