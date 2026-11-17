/** A tool the pane tracks. */
export type ToolId = 'codex' | 'agy' | 'claude'

/** One quota window as the orchestrator reports it. */
export type UsageWindow = { name: string; usedPercent: number; resetsAt: string | null; stale: boolean; observedAt: string | null }
export type ProviderUsage = { provider: ToolId; windows: UsageWindow[] }

/** The last quota reading. `error` is the last failure, kept beside the last good reading. */
export type UsageSnapshot = { providers: ProviderUsage[]; checkedAt: string | null; error: string | null; busy: boolean }

/** A worker worktree (never the main checkout). */
export type Worktree = {
  path: string
  folder: string
  branch: string
  tool: ToolId | null
  ahead: number
  changed: number
  atMain: boolean
  lastCommit: string | null
  lastCommitAt: string | null
  newestFile: string | null
  newestAt: string | null
}

/** A worker CLI process (`codex exec` or `agy -p`), with the worktree it runs in when known. */
export type Agent = {
  pid: number
  tool: ToolId
  model: string
  startedAt: string
  worktree: string | null
  activity: string[]
}

export type WorkSnapshot = { worktrees: Worktree[]; agents: Agent[]; checkedAt: string | null; error: string | null }

declare module 'claude-code' {
  interface PluginState {
    'agent-usage': { usage: Shaped<UsageSnapshot>; work: Shaped<WorkSnapshot>; theme: Shaped<string> }
  }
}
