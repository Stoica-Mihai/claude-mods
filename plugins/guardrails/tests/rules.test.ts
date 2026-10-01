import { describe, expect, test } from 'claude-code/testing'

import type { GuardrailsRule } from '../types'
import { builds, check, keywords, patterns, sourceWrites } from '../hooks/rules'
import { CASES, CORES, REASONS } from './cases'

const ALL: ReadonlySet<GuardrailsRule> = new Set(['keywords', 'patterns', 'source-writes', 'builds'])
const MACHINE = { cores: CORES, isTmpfs: true }

const RULES: Record<GuardrailsRule, (command: string) => string | null> = {
  keywords: command => keywords(command),
  patterns: command => patterns(command),
  'source-writes': command => sourceWrites(command),
  builds: command => builds(command, MACHINE),
}

// What a verdict decides, wording aside: fired or not, the path a write names, the reason a build failed.
const decision = (rule: GuardrailsRule, reason: string | null | undefined): string | null => {
  if (reason === null || reason === undefined) return null
  if (rule === 'source-writes') return reason.match(/\(([^()]*)\)$/)![1]!
  if (rule === 'builds') return reason.split(' — ')[0]!
  return 'blocked'
}

// Every rule must decide each recorded command exactly as the shell hook it replaced did.
describe('parity with the shell hooks', () => {
  for (const [rule, run] of Object.entries(RULES) as [GuardrailsRule, (command: string) => string | null][]) {
    test(rule, async () => {
      for (const [command, fired] of CASES) {
        const index = fired[rule]
        expect({ command, decision: decision(rule, run(command)) }).toEqual({
          command,
          decision: decision(rule, index === undefined ? null : REASONS[index]),
        })
      }
    })
  }
})

test('check names every enabled rule that fires, in rule order', async () => {
  const blocks = check('until cargo mutants; do :; done > src/log.md', { ...MACHINE, enabled: ALL })
  expect(blocks.map(block => block.rule)).toEqual(['keywords', 'source-writes', 'builds'])
  expect(check('ls -la', { ...MACHINE, enabled: ALL })).toEqual([])
})

test('a rule that is not enabled never fires', async () => {
  const command = 'until cargo mutants; do gh pr create; done > src/log.md'
  expect(check(command, { ...MACHINE, enabled: new Set() })).toEqual([])
  expect(check(command, { ...MACHINE, enabled: new Set(['patterns']) }).map(block => block.rule)).toEqual(['patterns'])
})

test('the job cap follows the core count', async () => {
  const contained = 'TMPDIR=~/.cache/m systemd-run --user --scope -p MemoryMax=3G nice -n 10 cargo mutants -j6'
  expect(builds(contained, { cores: 16, isTmpfs: true })).toBeNull()
  expect(builds(contained, { cores: 8, isTmpfs: true })).toContain('at -j6 on a 8-core machine (cap is 4)')
})

test('TMPDIR is only required where /tmp is a tmpfs', async () => {
  const scoped = 'systemd-run --user --scope -p MemoryMax=3G nice -n 10 cargo mutants -j4'
  expect(builds(scoped, { cores: 16, isTmpfs: true })).toContain('no TMPDIR set')
  expect(builds(scoped, { cores: 16, isTmpfs: false })).toBeNull()
  expect(builds('cargo mutants', { cores: 16, isTmpfs: false })).not.toContain('tmpfs')
})

test('denials name nothing from one particular setup', async () => {
  const reasons = check('until cargo mutants; do gh pr create; done > src/log.md', { ...MACHINE, enabled: ALL })
  for (const { reason } of reasons) {
    expect(reason).not.toMatch(/rules\/git-workflow\.md|MUTATION\.md|recast|compositor/)
  }
})
