// The rule engine: compiles a user's rules file and checks Bash commands against it. It ships no rules.
// Every regex is JavaScript syntax and is applied line by line, the way grep reads a command.

export type Patterns = string | string[]

export type PatternRule = { kind: 'pattern'; name: string; match: Patterns; unless?: Patterns; reason: string }

export type SourceWritesRule = {
  kind: 'source-writes'
  name: string
  reason: string
  extensions?: string[]
  files?: string[]
  scratch?: Patterns
}

export type ContainedStep = { present: string; why: string } | { absent: string; why: string }

export type ContainedRule = {
  kind: 'contained'
  name: string
  match: Patterns
  unless?: Patterns
  steps?: ContainedStep[]
  jobs?: { flag: string; maxFraction: number; why: string }
  reason: string
}

export type Rule = PatternRule | SourceWritesRule | ContainedRule

export type RulesFile = { rules: Rule[] }

export type Block = { rule: string; reason: string }

export type Machine = { cores: number }

export type Compiled = { name: string; check: (command: string, machine: Machine) => string | null }

const lines = (text: string): string[] => text.split('\n')

const anyLine = (text: string, re: RegExp): boolean => lines(text).some(line => re.test(line))

const allMatches = (text: string, re: RegExp): string[] =>
  lines(text).flatMap(line => [...line.matchAll(new RegExp(re.source, 'g'))].map(m => m[0]))

const escape = (text: string): string => text.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&')

const fill = (template: string, values: Record<string, string | number>): string =>
  template.replace(/\{(\w+)\}/g, (whole, key: string) => (key in values ? String(values[key]) : whole))

const list = (patterns: Patterns | undefined): string[] =>
  patterns === undefined ? [] : Array.isArray(patterns) ? patterns : [patterns]

// pattern: deny when any `match` regex hits a line and no `unless` regex does.

function pattern(rule: PatternRule): Compiled['check'] {
  const match = list(rule.match).map(source => new RegExp(source))
  const unless = list(rule.unless).map(source => new RegExp(source))
  return command =>
    match.some(re => anyLine(command, re)) && !unless.some(re => anyLine(command, re)) ? rule.reason : null
}

// source-writes: writing a source file through the shell. Reads text, so expansion and scripts get through.

const DEFAULT_EXTENSIONS = [
  'ts', 'tsx', 'mts', 'cts', 'js', 'jsx', 'mjs', 'cjs', 'json', 'jsonc', 'md', 'mdx', 'py', 'rs', 'go', 'sh',
  'bash', 'css', 'scss', 'html', 'vue', 'svelte', 'yml', 'yaml', 'toml', 'spr', 'lua', 'c', 'h', 'cpp', 'sql',
  'graphql',
]

const DEFAULT_FILES = [
  'Makefile', 'Dockerfile', 'CMakeLists.txt', 'Justfile', 'Rakefile', 'Gemfile', 'Procfile', '.gitignore', '.npmrc',
  '.env',
]

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

// Copies whose last argument is the only file they write.
const COPY = /^(cp|mv|install|rsync)\s/

// Splits a line into its commands at unquoted ; | & (an & that is part of a redirect stays), so each write is
// matched only against its own command's paths.
export function segments(line: string): string[] {
  const parts: string[] = []
  let quote: string | null = null
  let current = ''
  for (let i = 0; i < line.length; i++) {
    const c = line[i]!
    if (quote !== null) {
      if (c === quote) quote = null
    } else if (c === "'" || c === '"') {
      quote = c
    } else if ((c === ';' || c === '|' || c === '&') && line[i - 1] !== '>' && line[i + 1] !== '>') {
      parts.push(current)
      current = ''
      continue
    }
    current += c
  }
  parts.push(current)
  return parts.map(part => part.trim()).filter(part => part !== '')
}

// The files a command's unquoted > and >> redirects write, quotes removed; fd duplication (2>&1) is skipped.
export function redirectTargets(segment: string): string[] {
  const targets: string[] = []
  let quote: string | null = null
  for (let i = 0; i < segment.length; i++) {
    const c = segment[i]!
    if (quote !== null) {
      if (c === quote) quote = null
      continue
    }
    if (c === "'" || c === '"') {
      quote = c
      continue
    }
    if (c !== '>') continue
    let j = i + 1
    if (segment[j] === '>') j++
    if (segment[j] === '&') continue
    while (segment[j] === ' ' || segment[j] === '\t') j++
    let target = ''
    const open = segment[j] === '"' || segment[j] === "'" ? segment[j++] : null
    while (j < segment.length && (open !== null ? segment[j] !== open : !/[\s;&|)<>]/.test(segment[j]!))) target += segment[j++]
    if (target !== '') targets.push(target)
    i = j
  }
  return targets
}

function sourceWrites(rule: SourceWritesRule): Compiled['check'] {
  const extensions = (rule.extensions ?? DEFAULT_EXTENSIONS).map(escape).join('|')
  const files = (rule.files ?? DEFAULT_FILES).map(escape).join('|')
  const sourcePath = new RegExp(`([A-Za-z0-9_./~$-]+\\.(${extensions})|[A-Za-z0-9_./~$-]*(${files}))\\b`)
  const scratch = list(rule.scratch ?? '/tmp/')

  // Scratch only when the path begins with a scratch prefix and never climbs out; $HOME and $PWD are not scratch.
  const isScratch = (path: string): boolean => scratch.some(prefix => path.startsWith(prefix)) && !path.includes('..')
  const sourceIn = (text: string): string[] =>
    allMatches(text, sourcePath).filter(path => !isScratch(path) && !path.startsWith('/dev/'))

  const check = (segment: string): string | null => {
    // A URL is never a file being written.
    const text = segment.replace(/\S+:\/\/\S+/g, ' ')
    const redirected = redirectTargets(text).flatMap(sourceIn)
    if (redirected.length > 0) return redirected[0]!
    if (!WRITE_MECHANISMS.some(re => re.test(text))) return null
    if (COPY.test(text)) return sourceIn(text.split(/\s+/).pop() ?? '')[0] ?? null
    return sourceIn(text)[0] ?? null
  }

  return command => {
    // A trailing backslash continues the command on the next line.
    for (const line of lines(command.replace(/\\\n/g, ' '))) {
      for (const segment of segments(line)) {
        const target = check(segment)
        if (target !== null) return `${rule.reason} (${target})`
      }
    }
    return null
  }
}

// contained: a command that must carry every required part; the first missing part names the denial.

function contained(rule: ContainedRule): Compiled['check'] {
  const match = list(rule.match).map(source => new RegExp(source))
  const unless = list(rule.unless).map(source => new RegExp(source))
  const steps = (rule.steps ?? []).map(step =>
    'present' in step
      ? { re: new RegExp(step.present), isRequired: true, why: step.why }
      : { re: new RegExp(step.absent), isRequired: false, why: step.why },
  )
  const jobs = rule.jobs === undefined ? null : { ...rule.jobs, re: new RegExp(rule.jobs.flag) }

  return (command, { cores }) => {
    if (!match.some(re => anyLine(command, re)) || unless.some(re => anyLine(command, re))) return null

    const cap = Math.max(1, Math.floor(cores * (jobs?.maxFraction ?? 1)))
    const deny = (why: string, extra: Record<string, number> = {}): string =>
      fill(rule.reason, { why: fill(why, { cores, cap, ...extra }), cores, cap, ...extra })

    for (const step of steps) {
      if (anyLine(command, step.re) !== step.isRequired) return deny(step.why)
    }
    if (jobs !== null) {
      const counts = allMatches(command, jobs.re).map(flag => Number(flag.match(/[0-9]+/)?.[0] ?? 0))
      const most = counts.length > 0 ? Math.max(...counts) : null
      if (most !== null && most > cap) return deny(jobs.why, { jobs: most })
    }
    return null
  }
}

const KINDS = { pattern, 'source-writes': sourceWrites, contained } as const

// Turns a parsed rules file into checks; a rules file with any error yields no rules, only the errors.
export function compile(file: unknown): { rules: Compiled[]; errors: string[] } {
  const raw = (file as RulesFile | null)?.rules
  if (!Array.isArray(raw)) return { rules: [], errors: ['the file has no "rules" list'] }

  const errors: string[] = []
  const rules = raw.flatMap((rule, index): Compiled[] => {
    const where = `rule ${index + 1}${typeof rule?.name === 'string' ? ` (${rule.name})` : ''}`
    if (typeof rule?.name !== 'string' || rule.name === '') errors.push(`${where}: "name" is missing`)
    if (typeof rule?.reason !== 'string') errors.push(`${where}: "reason" is missing`)
    const build = KINDS[rule?.kind as keyof typeof KINDS]
    if (build === undefined) {
      errors.push(`${where}: "kind" must be one of ${Object.keys(KINDS).join(', ')}`)
      return []
    }
    try {
      return [{ name: rule.name, check: build(rule as never) }]
    } catch (error) {
      errors.push(`${where}: ${error instanceof Error ? error.message : String(error)}`)
      return []
    }
  })
  return errors.length > 0 ? { rules: [], errors } : { rules, errors }
}

// Every rule that fires, in file order, so one denial names all of them instead of one per retry.
export function check(command: string, rules: Compiled[], machine: Machine): Block[] {
  return rules.flatMap(({ name, check }) => {
    const reason = check(command, machine)
    return reason === null ? [] : [{ rule: name, reason }]
  })
}
