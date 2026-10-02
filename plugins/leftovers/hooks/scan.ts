// Finding the processes this session's Bash calls started: every one carries the session's tag in its environment.

import type { LeftoversCall as Call, LeftoversProc as Proc } from '../types'

export const TAG = 'CLAUDE_LEFTOVERS_TAG'

// The tag's value: the session's key, then the ids of the Bash calls in flight when the process was started.
export const tagValue = (key: string, calls: Iterable<number>): string => `${key}:${[...calls].join(',')}`

// Prints one line per tagged process: pid, ppid, start ticks, attached (under Claude Code) 0/1, age in seconds,
// the call ids from its tag, argv. $PPID is the Claude Code process that ran this script; a process is attached
// while it descends from it.
export const SCAN_SCRIPT = `
CL=$PPID
for f in $(/usr/bin/grep -lzxE "${TAG}=$TAG_VALUE(:[0-9,]*)?" /proc/[0-9]*/environ 2>/dev/null); do
  p=\${f#/proc/}; p=\${p%/environ}
  [ "$p" = "$$" ] && continue
  stat=$(cat /proc/$p/stat 2>/dev/null) || continue
  set -- \${stat##*) }; ppid=$2; start=\${20}
  [ "$ppid" = "$$" ] && continue
  q=$ppid; attached=0
  while [ "$q" -gt 1 ] 2>/dev/null; do
    [ "$q" = "$CL" ] && { attached=1; break; }
    qs=$(cat /proc/$q/stat 2>/dev/null) || break
    set -- \${qs##*) }; q=$2
  done
  age=$(ps -o etimes= -p "$p" | tr -d ' ')
  ids=$(tr '\\0' '\\n' < /proc/$p/environ 2>/dev/null | sed -n "s/^${TAG}=[^:]*:\\{0,1\\}//p" | head -1)
  args=$(tr '\\0' ' ' < /proc/$p/cmdline 2>/dev/null)
  printf '%s\\t%s\\t%s\\t%s\\t%s\\t%s\\t%s\\n' "$p" "$ppid" "$start" "$attached" "$age" "$ids" "$args"
done
`

// The Bash call a process came from: the call its tag names, one of several when calls overlapped. A tag
// naming no call (an older version's) falls back to the latest call that began before the process started.
export function attribute(ids: number[], startedAt: number, calls: Call[]): string | null {
  const named = ids.flatMap(id => calls.filter(call => call.id === id).map(call => call.command))
  if (named.length > 0) return named.length === 1 ? named[0]! : `one of: ${named.join(' | ')}`
  const before = calls.filter(call => call.at <= startedAt + 1000)
  return before.length > 0 ? before[before.length - 1]!.command : null
}

export function parse(stdout: string, now: number, calls: Call[]): Proc[] {
  return stdout
    .split('\n')
    .filter(line => line.trim() !== '')
    .flatMap(line => {
      const [pid, ppid, start, attached, age, tagged = '', ...rest] = line.split('\t')
      const startedAt = now - Number(age) * 1000
      const ids = tagged.split(',').filter(id => id !== '').map(Number)
      if (!Number.isInteger(Number(pid)) || !Number.isFinite(startedAt)) return []
      return [
        {
          id: `${pid}:${start}`,
          pid: Number(pid),
          ppid: Number(ppid),
          isAttached: attached === '1',
          startedAt,
          args: rest.join('\t').trim(),
          from: attribute(ids, startedAt, calls),
        },
      ]
    })
    .sort((a, b) => a.startedAt - b.startedAt)
}

// Detached processes are the leftovers; attached ones still belong to a running background task.
export function leftovers(procs: Proc[], ignore: RegExp | null): Proc[] {
  return procs.filter(proc => !proc.isAttached && !(ignore?.test(proc.args) ?? false))
}

export const clip = (text: string, max: number): string => (text.length > max ? `${text.slice(0, max - 1)}…` : text)

// Processes grouped under the Bash call that started them, in the order the calls first appear.
export function byCall(procs: Proc[]): [string, Proc[]][] {
  const groups = new Map<string, Proc[]>()
  for (const proc of procs) {
    const from = proc.from ?? 'an earlier Bash call'
    groups.set(from, [...(groups.get(from) ?? []), proc])
  }
  return [...groups]
}

// The program's file name and the start of its arguments: enough to recognise it, never the whole command line.
export const short = (args: string): string => {
  const [program = '', ...rest] = args.split(' ')
  return clip([program.split('/').pop(), ...rest].join(' '), 60)
}

// One line per Bash call, listing the processes it left: pid and short name. Full command lines are in /leftovers.
export function describe(procs: Proc[]): string {
  const lines = byCall(procs).map(
    ([from, group]) => `- ${group.map(proc => `${proc.pid} ${short(proc.args)}`).join('; ')} (from: ${clip(from, 80)})`,
  )
  return [
    'Still running, detached, from this session\'s Bash calls:',
    ...lines,
    'Stop the ones no longer needed by pid, or tell the user why they stay. /leftovers lists them.',
  ].join('\n')
}
