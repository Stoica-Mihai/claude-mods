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
  scratch?: string
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

const perLine = (text: string, edit: (line: string) => string): string => lines(text).map(edit).join('\n')

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

// Matched against the command with quoted spans removed: the shell cannot redirect from inside quotes.
const REDIRECT = /[>]>?\s*[^&\s]/

// Each quoted span becomes one placeholder, so a quoted redirect target still leaves something to match.
const unquote = (line: string): string => line.replace(/'[^']*'/g, 'Q').replace(/"[^"]*"/g, 'Q')

function sourceWrites(rule: SourceWritesRule): Compiled['check'] {
  const extensions = (rule.extensions ?? DEFAULT_EXTENSIONS).map(escape).join('|')
  const files = (rule.files ?? DEFAULT_FILES).map(escape).join('|')
  const sourcePath = new RegExp(`([A-Za-z0-9_./~-]+\\.(${extensions})|[A-Za-z0-9_./~-]*(${files}))\\b`)
  const scratch = rule.scratch ?? '/tmp/'
  const s = escape(scratch)

  // Drops writes in appearance only: a scratch path climbing back out, discards, fd duplication, scratch targets.
  const neutralise = (line: string): string =>
    line
      .replace(new RegExp(`${s}\\.\\.`, 'g'), '/climbs-out/..')
      .replace(/[0-9]*>>?\s*\/dev\/[a-z]+/g, '')
      .replace(/[0-9]*>&[0-9-]+/g, '')
      .replace(new RegExp(`[0-9]*>>?\\s*"?'?${s}[^ "'|;&)]*`, 'g'), '')
      .replace(new RegExp(`(^|[;&|]\\s*)(cp|mv|install|rsync)\\s+[^;|&]*\\s${s}[^ ;|&]*\\s*($|[;|&])`, 'g'), '$1')

  return command => {
    const scan = perLine(command, neutralise)
    const writes = anyLine(perLine(scan, unquote), REDIRECT) || WRITE_MECHANISMS.some(re => anyLine(scan, re))
    if (!writes) return null

    // Scratch only when the path begins with the scratch prefix and never climbs out; $HOME and $PWD are not scratch.
    const target = allMatches(scan, sourcePath).find(path => !(path.startsWith(scratch) && !path.includes('..')))
    return target === undefined ? null : `${rule.reason} (${target})`
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
