// Finding the processes this session's Bash calls started: every one carries the session's tag in its environment.

import type { LeftoversCall as Call, LeftoversProc as Proc } from '../types'

export const TAG = 'CLAUDE_LEFTOVERS_TAG'

// Prints one line per tagged process: pid, ppid, start ticks, attached (under Claude Code) 0/1, age in seconds, argv.
// $PPID is the Claude Code process that ran this script; a process is attached while it descends from it.
export const SCAN_SCRIPT = `
CL=$PPID
for f in $(/usr/bin/grep -lzx "${TAG}=$TAG_VALUE" /proc/[0-9]*/environ 2>/dev/null); do
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
  args=$(tr '\\0' ' ' < /proc/$p/cmdline 2>/dev/null)
  printf '%s\\t%s\\t%s\\t%s\\t%s\\t%s\\n' "$p" "$ppid" "$start" "$attached" "$age" "$args"
done
`

// The Bash call a process came from: the latest call that began before it started.
export function attribute(startedAt: number, calls: Call[]): string | null {
  const before = calls.filter(call => call.at <= startedAt + 1000)
  return before.length > 0 ? before[before.length - 1]!.command : null
}

export function parse(stdout: string, now: number, calls: Call[]): Proc[] {
  return stdout
    .split('\n')
    .filter(line => line.trim() !== '')
    .flatMap(line => {
      const [pid, ppid, start, attached, age, ...rest] = line.split('\t')
      const startedAt = now - Number(age) * 1000
      if (!Number.isInteger(Number(pid)) || !Number.isFinite(startedAt)) return []
      return [
        {
          id: `${pid}:${start}`,
          pid: Number(pid),
          ppid: Number(ppid),
          isAttached: attached === '1',
          startedAt,
          args: rest.join('\t').trim(),
          from: attribute(startedAt, calls),
        },
      ]
    })
    .sort((a, b) => a.startedAt - b.startedAt)
}

// Detached processes are the leftovers; attached ones still belong to a running background task.
export function leftovers(procs: Proc[], ignore: RegExp | null): Proc[] {
  return procs.filter(proc => !proc.isAttached && !(ignore?.test(proc.args) ?? false))
}

const age = (ms: number): string => {
  const minutes = Math.floor(ms / 60000)
  return minutes < 1 ? 'under a minute' : minutes < 60 ? `${minutes}m` : `${Math.floor(minutes / 60)}h${minutes % 60}m`
}

export function describe(procs: Proc[], now: number): string {
  const lines = procs.map(
    proc =>
      `- pid ${proc.pid}, running ${age(now - proc.startedAt)}: ${proc.args}` +
      (proc.from === null ? '' : `\n  started by: ${proc.from}`),
  )
  return [
    'These processes were started by Bash calls in this session and are still running, detached from Claude Code:',
    ...lines,
    'Stop each one that is no longer needed by its pid, or tell the user which you are leaving running and why. /leftovers lists them.',
  ].join('\n')
}
