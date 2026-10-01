# guardrails

Blocks the Bash commands your rules file names, and keeps a record of every block. The mod ships no rules: until you point it at a rules file, it blocks nothing.

## Setting it up

1. Write a rules file, for example `~/.claude/guardrails.json`. The format is below.
2. Point the mod at it. In Claude Code, run `/plugin configure guardrails@claude-mods`. Or from the command line:

   ```sh
   echo '{"rulesFile": "~/.claude/guardrails.json"}' | claude plugin configure guardrails@claude-mods --values-stdin
   ```

3. Restart Claude Code.

After that, the mod reads the file again whenever it changes, so editing a rule needs no restart.

## The rules file

```json
{
  "rules": [
    {
      "kind": "pattern",
      "name": "force-push",
      "match": "git\\s+push.*--force",
      "unless": "--force-with-lease",
      "reason": "Force-push is blocked. Use --force-with-lease."
    }
  ]
}
```

Every rule has a `name`, shown in `/blocked`, and a `reason`, which Claude reads when a command is denied. Patterns are JavaScript regular expressions, written as JSON strings, so a backslash is written twice. Each pattern is matched against every line of the command separately. When several rules match one command, the denial gives every reason at once.

There are three kinds of rule.

### `pattern`

Blocks a command when any `match` pattern matches and no `unless` pattern does. Both take one pattern or a list.

### `source-writes`

Blocks writing a source file through the shell: `sed -i`, `perl -i`, redirects, `cp`, `mv`, `tee`, `dd`, `truncate`, `ln -sf`, `patch`, Python and Node file writes, and `curl -o`/`wget -O`. The denial ends with the path it found, in brackets.

| Field | Meaning | Default |
| --- | --- | --- |
| `extensions` | File extensions that count as source | `ts`, `js`, `json`, `md`, `py`, `rs`, `go`, `sh`, `yml`, `toml`, `c`, `cpp` and others |
| `files` | File names that count as source | `Makefile`, `Dockerfile`, `.gitignore`, `.env` and others |
| `scratch` | Folder whose files are exempt | `/tmp/` |

It reads the command's text, so it is a speed bump, not a security boundary. A script, a glob or a variable that becomes a path only after expansion gets through.

### `contained`

Requires a heavy command to carry every part that contains it. When `match` matches and `unless` does not, the mod checks `steps` in order. A `present` step needs its pattern somewhere in the command, and an `absent` step forbids its pattern. The first step that fails supplies `{why}`.

`jobs` caps parallelism. Every `flag` match is read as a job count, and the largest must be at most `maxFraction` of this machine's cores.

`reason` and each `why` can use `{why}`, `{cores}`, `{cap}` (the job cap) and `{jobs}` (the count found).

```json
{
  "kind": "contained",
  "name": "contained-make",
  "match": "\\bmake\\b",
  "steps": [{ "present": "(^|\\s)nice(\\s|$)", "why": "make is not niced" }],
  "jobs": { "flag": "-j\\s*[0-9]+", "maxFraction": 0.5, "why": "-j{jobs} is over the cap of {cap}" },
  "reason": "{why}. Run it as: nice make -j{cap}"
}
```

## When the rules file is wrong

If the file is missing, is not valid JSON, or has any broken rule, the mod blocks nothing. It shows a toast naming every problem, and `/blocked` shows them until the file is fixed.

## Seeing what was blocked

- A toast appears each time a command is blocked.
- `/blocked` says where the rules come from, then opens a pane listing recent blocks: time, rule and command, with counts for this session, all time and each rule.
- History is kept across sessions, up to the last 500 blocks.

## If it breaks

A deny never depends on the history being written. If recording a block fails, the command is still denied. If the hook itself fails, a fallback checks the rules again and denies without recording.

## Tests

`tests/scripts-rules.ts` is a rules file that reproduces four shell hooks this mod replaced. `tests/cases.ts` holds 97 commands with the verdicts those hooks gave. `tests/rules.test.ts` checks that the rules file gives the same verdict, word for word, on every one of them.
