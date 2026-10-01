import { describe, expect, test } from 'claude-code/testing'

import { builds, check, keywords, patterns, sourceWrites } from '../hooks/rules'
import { CASES, CORES, REASONS } from './cases'

const RULES = {
  keywords: (command: string) => keywords(command),
  patterns: (command: string) => patterns(command),
  'source-writes': (command: string) => sourceWrites(command),
  builds: (command: string) => builds(command, { cores: CORES }),
}

// Each rule must give the shell hook's exact verdict, reason text included, for every recorded command.
describe('parity with the shell hooks', () => {
  for (const [rule, run] of Object.entries(RULES)) {
    test(rule, async () => {
      for (const [command, fired] of CASES) {
        const index = fired[rule]
        expect({ command, reason: run(command) }).toEqual({
          command,
          reason: index === undefined ? null : REASONS[index],
        })
      }
    })
  }
})

test('check names every rule that fires, in rule order', async () => {
  const blocks = check('until cargo mutants; do :; done > src/log.md', { cores: CORES })
  expect(blocks.map(block => block.rule)).toEqual(['keywords', 'source-writes', 'builds'])
  expect(check('ls -la', { cores: CORES })).toEqual([])
})

test('the job cap follows the core count', async () => {
  const contained = 'TMPDIR=~/.cache/m systemd-run --user --scope -p MemoryMax=3G nice -n 10 cargo mutants -j6'
  expect(builds(contained, { cores: 16 })).toBeNull()
  expect(builds(contained, { cores: 8 })).toContain('at -j6 on a 8-core machine (cap is 4)')
})
