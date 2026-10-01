import type { RulesFile } from '../hooks/rules'

// A rules file that reproduces the four shell hooks the mod replaced; test data, not shipped rules.
export const SCRIPTS_RULES: RulesFile = {
  rules: [
    {
      kind: 'pattern',
      name: 'wait-loops',
      match: '(^|[;&|(]|&&|\\|\\|)\\s*until(\\s|;|$)',
      reason:
        "blocked keyword: until — Wait-loops are denied on this machine, and the harness's own denial message suggests this exact form — that advice is wrong here. To wait for work you started: pass run_in_background and end your turn; you are re-invoked when it completes. To wait on external state the harness cannot observe (CI, a deploy, a remote queue): make one Bash call with a delay matched to how fast that state changes.",
    },
    {
      kind: 'pattern',
      name: 'pr-creation',
      match: ['gh\\s+pr\\s+create', 'glab\\s+mr\\s+create', 'gh\\s+api.*(-X|--method)\\s*POST.*pulls'],
      reason: 'PR/MR creation is blocked: land work by merging directly to main (see rules/git-workflow.md)',
    },
    {
      kind: 'source-writes',
      name: 'source-writes',
      reason:
        'Editing a source file through Bash is blocked: Read it, then use Edit or Write.\nThose are tracked — Edit refuses a file you have not Read — which is the point.\nFor the same mechanical change across many files, use the recast MCP tool: it\npreviews a per-file plan and refuses a zero-match pattern.\nScratch work under /tmp is unaffected.',
    },
    {
      kind: 'contained',
      name: 'contained-builds',
      match: 'cargo\\s+mutants|cargo-mutants',
      unless: '--list|--list-files|--version|--help',
      steps: [
        { present: 'TMPDIR=', why: 'a mutation sweep with no TMPDIR set, so its sandboxes land in /tmp' },
        { absent: 'TMPDIR=/tmp(/|\\s|$)', why: 'a mutation sweep with TMPDIR on the tmpfs' },
        {
          present: 'systemd-run',
          why: 'a mutation sweep outside a systemd scope, so nothing bounds its memory and nothing collects the shells it leaves running',
        },
        { present: 'MemoryMax=', why: 'a mutation sweep in a scope with no MemoryMax' },
        {
          present: '(^|\\s)nice(\\s|$)',
          why: 'a mutation sweep that is not niced, so it competes with the compositor at equal priority',
        },
      ],
      jobs: {
        flag: '-j\\s*[0-9]+|--jobs[\\s=]+[0-9]+',
        maxFraction: 0.5,
        why: 'a mutation sweep at -j{jobs} on a {cores}-core machine (cap is {cap})',
      },
      reason:
        '{why} — this machine has {cores} cores and /tmp is a tmpfs (RAM), so an uncontained sweep competes with the compositor and eats memory it never gives back. Required form:\n\n  TMPDIR=~/.cache/mutants-tmp systemd-run --user --scope --unit=<name> \\\n  -p MemoryMax=3G -p MemorySwapMax=0 -p OOMPolicy=continue nice -n 10 \\\n  cargo mutants -j{cap} --iterate --output /tmp/<dir>\n  systemctl --user stop <name>.scope     # collects the shells it leaves behind\n\nEvery part is load-bearing and MUTATION.md records why. If you genuinely need it uncontained, say so and let the user decide — do not work around this.',
    },
  ],
}
