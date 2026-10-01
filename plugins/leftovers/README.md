# leftovers

Finds the processes Claude's Bash calls left running, such as a server, a watcher or a window, and has Claude stop them or explain why they stay. `/leftovers` lists them, each with a Stop button.

Linux only: it reads `/proc`.

## How it knows which processes are Claude's

While a Bash call runs, the mod sets `CLAUDE_LEFTOVERS_TAG` to a value unique to the session. Every process the call starts inherits it, and keeps it after it detaches from its parent. So the mod finds Claude's processes by tag, not by guessing from their names, and never touches a process it didn't tag.

At the end of each turn, it sorts the tagged processes that are still alive into two groups:

- **Left running:** detached from Claude Code, for example started with `nohup … &`, `setsid` or `wezterm start`. These are the leftovers.
- **Under background tasks:** still under Claude Code, such as a command run with `run_in_background`. These are reported in the pane only, because Claude Code tracks them itself.

## What happens to a leftover

The `onLeftover` setting decides. Each leftover is reported once.

| Value | Effect |
| --- | --- |
| `note` (default) | A toast, and a note Claude reads at its next turn |
| `follow-up` | A toast, and a new turn starts at once: Claude stops the leftovers or says why they stay |
| `off` | Nothing. The leftovers only show in `/leftovers` |

Set it with `/plugin configure leftovers@claude-mods`, or:

```sh
echo '{"onLeftover": "follow-up"}' | claude plugin configure leftovers@claude-mods --values-stdin
```

`ignore` takes a JavaScript regular expression. A leftover whose command line matches is listed, but never reported. Use it for something you always want left running, such as a dev server.

## The pane

`/leftovers` scans again and opens a pane listing both groups. `Stop` sends `kill` to one leftover, after checking it is still the same tagged process. `Stop all` does the same for every leftover. You can reach the buttons with `ctrl+x tab`, then Tab and Enter.

## Limits

- **A mod can't hold a turn open.** Claude Code's security default keeps installed mods away from the settings `Stop` hook. So `follow-up` starts a new turn instead of continuing the one that ended.
- **Some processes lose the tag.** A process started with a cleared environment (`env -i`) doesn't carry it. Neither does a session opened in a tmux server that was already running, because the server, not Claude's shell, starts it.
- **Claude Code's own helpers can be tagged.** If Claude Code starts one while a Bash call runs, it inherits the tag. It stays under Claude Code, so it's listed under background tasks and never reported.
