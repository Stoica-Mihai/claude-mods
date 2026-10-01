// Bash command guardrails: each rule reads the command text and returns a denial reason or null.
// grep and sed match line by line, so every pattern here is applied per line to keep their semantics.

import type { GuardrailsRule as RuleName } from '../types'

export type Block = { rule: RuleName; reason: string }

export type Context = { cores: number; isTmpfs: boolean; enabled: ReadonlySet<RuleName> }

const lines = (text: string): string[] => text.split('\n')

const anyLine = (text: string, re: RegExp): boolean => lines(text).some(line => re.test(line))

const allMatches = (text: string, re: RegExp): string[] =>
  lines(text).flatMap(line => [...line.matchAll(new RegExp(re.source, 'g'))].map(m => m[0]))

const perLine = (text: string, edit: (line: string) => string): string => lines(text).map(edit).join('\n')

// keywords: a blocked shell keyword in command position, not inside a string, flag or path.

const KEYWORD_HINTS: Record<string, string> = {
  until:
    'Wait-loops are blocked here. To wait for work you started: pass run_in_background and end your turn; you are re-invoked when it completes. To wait on external state Claude Code cannot observe (CI, a deploy, a remote queue): make one Bash call with a delay matched to how fast that state changes.',
}

export function keywords(command: string): string | null {
  for (const [keyword, hint] of Object.entries(KEYWORD_HINTS)) {
    if (anyLine(command, new RegExp(`(^|[;&|(]|&&|\\|\\|)\\s*${keyword}(\\s|;|$)`))) {
      return `blocked keyword: ${keyword} — ${hint}`
    }
  }
  return null
}

// patterns: a blocked command anywhere in the line, so `git push && gh pr create` is caught.

const BLOCKED_PATTERNS = [/gh\s+pr\s+create/, /glab\s+mr\s+create/, /gh\s+api.*(-X|--method)\s*POST.*pulls/]

const PATTERN_REASON = 'PR/MR creation is blocked here: land work by merging directly to the main branch.'

export function patterns(command: string): string | null {
  return BLOCKED_PATTERNS.some(re => anyLine(command, re)) ? PATTERN_REASON : null
}

// source-writes: mutating a source file through Bash, which skips Edit's read-before-write check.
// A speed bump for the habit, not a security boundary: it reads text, so expansion and scripts get through.

const WRITE_MECHANISMS = [
  /sed\s+[^|;]*(-[a-zA-Z]*i(\s|=|$)|--in-place)/,
  /perl\s+[^|;]*-[a-zA-Z]*i/,
  /awk\s+[^|;]*-i\s+inplace/,
  /(write_text|write_bytes|writeFileSync|appendFileSync|writeFile)\s*\(/,
  /open\s*\([^)]*[,]\s*['"][wax]/,
  /(curl|wget)\s+[^|;]*(-o|-O|--output)\s/,
  /patch\s+[^|;]*-p[0-9]/,
  /(^|[;&|]\s*)(cp|mv|install|tee|dd|sponge|rsync|ed|ex)\s/,
  /\s(tee|sponge)\s/,
  /\sdd\s+[^|;]*of=/,
  /truncate\s+-s/,
  /ln\s+[^|;]*-s[a-z]*f/,
]

// Matched against the command with quoted spans removed: the shell cannot redirect from inside quotes.
const REDIRECT = /[>]>?\s*[^&\s]/

const SOURCE_PATH =
  /([A-Za-z0-9_./~-]+\.(ts|tsx|mts|cts|js|jsx|mjs|cjs|json|jsonc|md|mdx|py|rs|go|sh|bash|css|scss|html|vue|svelte|yml|yaml|toml|spr|lua|c|h|cpp|sql|graphql)|[A-Za-z0-9_./~-]*(Makefile|Dockerfile|CMakeLists\.txt|Justfile|Rakefile|Gemfile|Procfile|\.gitignore|\.npmrc|\.env))\b/

const SOURCE_WRITE_REASON = `Editing a source file through Bash is blocked: Read it, then use Edit or Write.
Those are tracked — Edit refuses a file you have not Read — which is the point.
Scratch work under /tmp is unaffected.`

// Drops writes in appearance only: a /tmp path climbing back out, discards, fd duplication, scratch targets.
const neutralise = (line: string): string =>
  line
    .replace(/\/tmp\/\.\./g, '/climbs-out/..')
    .replace(/[0-9]*>>?\s*\/dev\/[a-z]+/g, '')
    .replace(/[0-9]*>&[0-9-]+/g, '')
    .replace(/[0-9]*>>?\s*"?'?\/tmp\/[^ "'|;&)]*/g, '')
    .replace(/(^|[;&|]\s*)(cp|mv|install|rsync)\s+[^;|&]*\s\/tmp\/[^ ;|&]*\s*($|[;|&])/g, '$1')

// Each quoted span becomes one placeholder, so a quoted redirect target still leaves something to match.
const unquote = (line: string): string => line.replace(/'[^']*'/g, 'Q').replace(/"[^"]*"/g, 'Q')

export function sourceWrites(command: string): string | null {
  const scan = perLine(command, neutralise)
  const unquoted = perLine(scan, unquote)

  const writes = anyLine(unquoted, REDIRECT) || WRITE_MECHANISMS.some(re => anyLine(scan, re))
  if (!writes) return null

  // Scratch only when the path begins with /tmp/ and never climbs out; $HOME and $PWD are not scratch.
  const target = allMatches(scan, SOURCE_PATH).find(path => !(path.startsWith('/tmp/') && !path.includes('..')))
  return target === undefined ? null : `${SOURCE_WRITE_REASON} (${target})`
}

// builds: a heavy parallel run outside the containment that keeps the desktop alive.
// The systemd scope caps memory and collects leftover shells; nice keeps the desktop ahead of the build.

const HEAVY = /cargo\s+mutants|cargo-mutants/

const READ_ONLY_FLAGS = /--list|--list-files|--version|--help/

export function builds(command: string, { cores, isTmpfs }: Pick<Context, 'cores' | 'isTmpfs'>): string | null {
  if (!anyLine(command, HEAVY) || anyLine(command, READ_ONLY_FLAGS)) return null

  const cap = Math.max(1, Math.floor(cores / 2))
  const form = `TMPDIR=~/.cache/mutants-tmp systemd-run --user --scope --unit=<name> \\
  -p MemoryMax=3G -p MemorySwapMax=0 -p OOMPolicy=continue nice -n 10 \\
  cargo mutants -j${cap} --iterate --output /tmp/<dir>
  systemctl --user stop <name>.scope     # collects the shells it leaves behind`

  const machine = isTmpfs ? `${cores} cores and /tmp is a tmpfs (RAM)` : `${cores} cores`
  const deny = (why: string): string =>
    `${why} — this machine has ${machine}, so an uncontained sweep competes with the desktop for CPU and memory. Required form:

  ${form}

Every part is load-bearing. If you genuinely need it uncontained, say so and let the user decide — do not work around this.`

  // TMPDIR only matters where /tmp is RAM: the sandboxes, one per job, land there.
  if (isTmpfs && !command.includes('TMPDIR=')) {
    return deny('a mutation sweep with no TMPDIR set, so its sandboxes land in /tmp')
  }
  if (isTmpfs && anyLine(command, /TMPDIR=\/tmp(\/|\s|$)/)) return deny('a mutation sweep with TMPDIR on the tmpfs')
  if (!command.includes('systemd-run')) {
    return deny(
      'a mutation sweep outside a systemd scope, so nothing bounds its memory and nothing collects the shells it leaves running',
    )
  }
  if (!command.includes('MemoryMax=')) return deny('a mutation sweep in a scope with no MemoryMax')
  if (!anyLine(command, /(^|\s)nice(\s|$)/)) {
    return deny('a mutation sweep that is not niced, so it competes with the compositor at equal priority')
  }

  const jobs = allMatches(command, /-j\s*[0-9]+|--jobs[\s=]+[0-9]+/).map(flag => Number(flag.match(/[0-9]+/)![0]))
  const most = jobs.length > 0 ? Math.max(...jobs) : null
  if (most !== null && most > cap) return deny(`a mutation sweep at -j${most} on a ${cores}-core machine (cap is ${cap})`)

  return null
}

const RULES: { rule: RuleName; check: (command: string, context: Context) => string | null }[] = [
  { rule: 'keywords', check: keywords },
  { rule: 'patterns', check: patterns },
  { rule: 'source-writes', check: sourceWrites },
  { rule: 'builds', check: builds },
]

// Every enabled rule that fires, so one denial names all of them instead of one per retry.
export function check(command: string, context: Context): Block[] {
  return RULES.flatMap(({ rule, check }) => {
    if (!context.enabled.has(rule)) return []
    const reason = check(command, context)
    return reason === null ? [] : [{ rule, reason }]
  })
}
