# claude-mods

A marketplace of [Claude Code](https://code.claude.com) mods: plugins built on function hooks, TypeScript that runs inside Claude Code.

Mods are early access. The API can change between Claude Code releases, so a mod here may need fixing after an update.

## Mods

| Mod | What it does |
| --- | --- |
| [guardrails](plugins/guardrails) | Blocks the Bash commands your own rules file names, and shows every block in `/blocked`. Ships no rules |
| [leftovers](plugins/leftovers) | Finds the processes Claude's Bash calls left running, and has Claude stop them or explain them. `/leftovers` lists them. Linux only |

## Install

```sh
claude plugin marketplace add Stoica-Mihai/claude-mods
claude plugin install guardrails@claude-mods
```

To update after a new push: `claude plugin update guardrails@claude-mods`, then restart Claude Code.

## Develop

Load a mod straight from your clone instead of installing it. Claude Code then reloads it every time you save. Add the folder to `env` in `~/.claude/settings.json`:

```json
{ "env": { "CLAUDE_CODE_PLUGIN_DIRS": "/path/to/claude-mods/plugins/guardrails" } }
```

Load each mod one way only, either from the clone or installed, not both.

Check a mod before you commit it:

```sh
claude plugin validate plugins/guardrails
claude plugin test plugins/guardrails
```

## Layout

```
.claude-plugin/marketplace.json   the catalog: one entry per mod
plugins/<mod>/
  .claude-plugin/plugin.json      the mod's manifest
  hooks/hooks.json                names the hooks module
  hooks/register.tsx              the hooks module
  types/index.d.ts                the mod's state contract
  tests/*.test.ts                 run by `claude plugin test`
```
