# agent-usage

A Claude Code pane that shows two things beside the chat:

- **Quota**: the 5-hour and weekly windows for Codex, Antigravity and Claude, with what is left and when each resets. Readings come from the `alethe-orchestrate` plugin's `usage` command, which must be installed.
- **Work**: one row per worker worktree of the current repository. A row shows which tool and model runs there, what it is doing now (tests, type-check and so on), how long it has run, its last edit, and whether it needs review or has gone quiet.

Commands: `/usage-pane` opens the pane and refreshes it (this pings Codex with a one-line prompt so it reports fresh limits), and `/usage-theme [dark|neon]` changes its look. Quota refreshes on the UTC 5-minute marks and work every 30 seconds.

Code layout: `hooks/register.tsx` wires state, timers and commands; `hooks/lib/probe.ts` reads the machine (git, processes, the usage script); `hooks/lib/logic.ts` holds the pure parsing and pairing logic, tested in `hooks/logic.test.ts`; `hooks/lib/view.tsx` draws the pane; `hooks/lib/theme.ts` holds the themes.

## Install

At the prompt of a Claude Code terminal session:

```
/plugin install agent-usage --marketplace duckling1169/agent-usage
```

From a shell:

```
claude plugin install agent-usage --marketplace duckling1169/agent-usage
```

In the desktop app: click + next to the prompt box, then Plugins, Add marketplace with `duckling1169/agent-usage`, then Add plugin.

Answer `y` to add the marketplace, then pick a scope. Works on Windows, macOS and Linux; it needs `git`, Python 3, and the `alethe-orchestrate` plugin for quota readings.
