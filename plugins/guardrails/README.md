# guardrails

Blocks Bash commands that route around how this setup is meant to work, and keeps a record of every block.

## Rules

Every rule is off until you switch it on, so installing the mod changes nothing by itself.

| Setting | Rule | Blocks | Instead |
| --- | --- | --- | --- |
| `blockWaitLoops` | `keywords` | `until` in command position: the wait-loop | Background the command and wait for the completion notice |
| `blockPrCreation` | `patterns` | `gh pr create`, `glab mr create`, `gh api -X POST …/pulls` | Merge to the main branch directly |
| `blockShellSourceWrites` | `source-writes` | Writing a source file through the shell: `sed -i`, redirects, `cp`, `tee`, Python or Node file writes, `curl -o` | Read the file, then use Edit or Write. `/tmp` is exempt |
| `blockUncontainedBuilds` | `builds` | `cargo mutants` outside a systemd scope with `MemoryMax`, under `nice`, at no more than half the cores, and with `TMPDIR` off `/tmp` where `/tmp` is a tmpfs | The required form is in the denial message |

When several rules match one command, the denial gives every reason at once.

## Turning rules on

In Claude Code, run `/plugin configure guardrails@claude-mods`. Or set them from the command line:

```sh
echo '{"blockWaitLoops": "true", "blockPrCreation": "true"}' | claude plugin configure guardrails@claude-mods --values-stdin
```

The command takes every value as a string, `"true"` or `"false"`. Claude Code stores them as booleans in `~/.claude/settings.json` under `pluginConfigs`. Restart Claude Code to apply a change made this way.

These rules read the command text. They are a speed bump for habits, not a security boundary. A script, a glob or a variable that only becomes a path after expansion gets through.

## Seeing what was blocked

- A toast appears each time a command is blocked.
- `/blocked` opens a pane listing recent blocks: time, rule and command, with counts for this session, all time and each rule.
- History is kept across sessions, up to the last 500 blocks.

## If it breaks

A deny never depends on the history being written. If recording a block fails, the command is still denied. If the hook itself fails, a fallback runs the rules again and denies without recording. The test `the deny still holds when the history cannot be written` covers this.

## Tests

`tests/cases.ts` holds 97 commands with the verdicts the shell hooks this mod replaced gave on them. `tests/rules.test.ts` checks that each rule decides every one of them the same way: whether it fires, which file path a write names, and why a build is refused.
