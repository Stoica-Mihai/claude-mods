# guardrails

Blocks Bash commands that route around how this setup is meant to work, and keeps a record of every block.

## Rules

| Rule | Blocks | Instead |
| --- | --- | --- |
| `keywords` | `until` in command position: the wait-loop | Background the command and wait for the completion notice |
| `patterns` | `gh pr create`, `glab mr create`, `gh api -X POST …/pulls` | Merge to `main` directly |
| `source-writes` | Writing a source file through the shell: `sed -i`, redirects, `cp`, `tee`, Python or Node file writes, `curl -o` | Read the file, then use Edit or Write. `/tmp` is exempt |
| `builds` | `cargo mutants` outside a systemd scope with `TMPDIR` off the tmpfs, `MemoryMax`, `nice` and at most half the cores as jobs | The required form is in the denial message |

When several rules match one command, the denial gives every reason at once.

These rules read the command text. They are a speed bump for habits, not a security boundary. A script, a glob or a variable that only becomes a path after expansion gets through.

## Seeing what was blocked

- A toast appears each time a command is blocked.
- `/blocked` opens a pane listing recent blocks: time, rule and command, with counts for this session, all time and each rule.
- History is kept across sessions, up to the last 500 blocks.

## If it breaks

A deny never depends on the history being written. If recording a block fails, the command is still denied. If the hook itself fails, a fallback runs the rules again and denies without recording. The test `the deny still holds when the history cannot be written` covers this.

## Tests

`tests/cases.ts` holds 97 commands with the verdicts the original shell hooks gave, reason text included. `tests/rules.test.ts` checks each rule against all of them.
