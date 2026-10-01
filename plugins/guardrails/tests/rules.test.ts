import { describe, expect, test } from 'claude-code/testing'

import { check, compile } from '../hooks/rules'
import { CASES, CORES, REASONS } from './cases'
import { SCRIPTS_RULES } from './scripts-rules'

// The recorded verdicts are keyed by script; each script became one rule of SCRIPTS_RULES.
const SCRIPT_OF: Record<string, string> = {
  'wait-loops': 'keywords',
  'pr-creation': 'patterns',
  'source-writes': 'source-writes',
  'contained-builds': 'builds',
}

const MACHINE = { cores: CORES }

describe('a rules file can reproduce the shell hooks exactly', () => {
  const { rules, errors } = compile(SCRIPTS_RULES)

  test('the file compiles', async () => {
    expect(errors).toEqual([])
    expect(rules.map(rule => rule.name)).toEqual(Object.keys(SCRIPT_OF))
  })

  for (const rule of rules) {
    test(rule.name, async () => {
      for (const [command, fired] of CASES) {
        const index = fired[SCRIPT_OF[rule.name]!]
        expect({ command, reason: rule.check(command, MACHINE) }).toEqual({
          command,
          reason: index === undefined ? null : REASONS[index],
        })
      }
    })
  }

  test('one denial names every rule that fires, in file order', async () => {
    const blocks = check('until cargo mutants; do :; done > src/log.md', rules, MACHINE)
    expect(blocks.map(block => block.rule)).toEqual(['wait-loops', 'source-writes', 'contained-builds'])
  })
})

describe('compiling a rules file', () => {
  test('no rules file content means no rules', async () => {
    expect(compile({ rules: [] })).toEqual({ rules: [], errors: [] })
    expect(compile(null).rules).toEqual([])
    expect(compile({}).errors).toEqual(['the file has no "rules" list'])
  })

  test('any error drops every rule and names each problem', async () => {
    const { rules, errors } = compile({
      rules: [
        { kind: 'pattern', name: 'fine', match: 'rm\\s+-rf', reason: 'no' },
        { kind: 'pattern', name: 'broken', match: '(unclosed', reason: 'no' },
        { kind: 'teleport', name: 'odd', reason: 'no' },
        { kind: 'pattern', match: 'x' },
      ],
    })
    expect(rules).toEqual([])
    expect(errors).toHaveLength(4)
    expect(errors[0]).toContain('rule 2 (broken)')
    expect(errors[1]).toBe('rule 3 (odd): "kind" must be one of pattern, source-writes, contained')
    expect(errors.slice(2)).toEqual(['rule 4: "name" is missing', 'rule 4: "reason" is missing'])
  })
})

describe('rule kinds', () => {
  const only = (rule: object) => {
    const compiled = compile({ rules: [rule] })
    expect(compiled.errors).toEqual([])
    return (command: string) => check(command, compiled.rules, { cores: 8 }).map(block => block.reason)
  }

  test('pattern: any match blocks unless an exception matches', async () => {
    const run = only({ kind: 'pattern', name: 'force', match: ['git\\s+push.*--force'], unless: '--force-with-lease', reason: 'use a lease' })
    expect(run('git push --force origin main')).toEqual(['use a lease'])
    expect(run('git push --force-with-lease origin main')).toEqual([])
    expect(run('git push origin main')).toEqual([])
  })

  test('source-writes: extensions, files and the scratch folder are the user\'s', async () => {
    const run = only({ kind: 'source-writes', name: 'w', reason: 'no', extensions: ['kt'], files: ['BUILD'], scratch: '/scratch/' })
    expect(run('echo x > Main.kt')).toEqual(['no (Main.kt)'])
    expect(run('echo x > BUILD')).toEqual(['no (BUILD)'])
    expect(run('echo x > main.ts')).toEqual([])
    expect(run('echo x > /scratch/Main.kt')).toEqual([])
    expect(run('echo x > /tmp/Main.kt')).toEqual(['no (/tmp/Main.kt)'])
  })

  test('contained: the first missing part names the denial, and the job cap follows the cores', async () => {
    const run = only({
      kind: 'contained',
      name: 'make',
      match: '\\bmake\\b',
      steps: [{ present: '\\bnice\\b', why: 'not niced' }],
      jobs: { flag: '-j\\s*[0-9]+', maxFraction: 0.5, why: '-j{jobs} is over {cap}' },
      reason: '{why} ({cores} cores)',
    })
    expect(run('make -j2')).toEqual(['not niced (8 cores)'])
    expect(run('nice make -j6')).toEqual(['-j6 is over 4 (8 cores)'])
    expect(run('nice make -j4')).toEqual([])
    expect(run('ls')).toEqual([])
  })
})
