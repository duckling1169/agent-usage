// Pure functions: parsing, pairing and wording. No `$`, no clock: callers pass `now`.

import type { Agent, ProviderUsage, ToolId, UsageWindow, Worktree } from '../../types'

export const TOOLS: readonly ToolId[] = ['codex', 'agy', 'claude']
export const TOOL_NAMES: Record<ToolId, string> = { codex: 'Codex', agy: 'Antigravity', claude: 'Claude' }

/** Minutes without an edit or a running command before a working agent counts as quiet. */
export const QUIET_MINUTES = 10

// ---------------------------------------------------------------- usage

type RawWindow = { usedPercent?: unknown; resetsAt?: unknown; stale?: unknown; observedAt?: unknown }

/** Reads `orchestrate.py usage --json`. Unknown or malformed windows are skipped, not fatal. */
export function parseUsage(text: string): ProviderUsage[] {
  const raw = JSON.parse(text) as { providers?: Record<string, { windows?: Record<string, RawWindow> }> }
  return TOOLS.map(provider => ({
    provider,
    windows: Object.entries(raw.providers?.[provider]?.windows ?? {}).flatMap(([name, w]): UsageWindow[] =>
      typeof w.usedPercent === 'number'
        ? [{
            name,
            usedPercent: w.usedPercent,
            resetsAt: typeof w.resetsAt === 'string' ? w.resetsAt : null,
            stale: w.stale === true,
            observedAt: typeof w.observedAt === 'string' ? w.observedAt : null,
          }]
        : [],
    ),
  }))
}

export type Tone = 'normal' | 'quiet' | 'warn' | 'alert' | 'brand'

/** One line on the tightest fresh window. */
export function verdict(providers: ProviderUsage[], now: number): { text: string; tone: Tone } {
  let worst: { provider: ToolId; left: number; resetsAt: string | null } | null = null
  for (const p of providers)
    for (const w of p.windows) {
      if (w.stale) continue
      const left = 100 - w.usedPercent
      if (!worst || left < worst.left) worst = { provider: p.provider, left, resetsAt: w.resetsAt }
    }
  if (!worst) return { text: 'Waiting for a reading', tone: 'quiet' }
  const name = TOOL_NAMES[worst.provider]
  if (worst.left <= 5) return { text: `${name} is out, back ${untilText(worst.resetsAt, now)}`, tone: 'alert' }
  if (worst.left <= 20) return { text: `${name} is running low (${Math.round(worst.left)}% left)`, tone: 'warn' }
  return { text: 'Plenty of room everywhere', tone: 'quiet' }
}

export function windowLevel(left: number): Tone {
  return left <= 5 ? 'alert' : left <= 20 ? 'warn' : 'normal'
}

// ---------------------------------------------------------------- time

export function minutesBetween(fromIso: string | null, now: number): number | null {
  if (!fromIso) return null
  const t = Date.parse(fromIso)
  return Number.isNaN(t) ? null : Math.max(0, Math.round((now - t) / 60000))
}

export function agoText(iso: string | null, now: number): string {
  const m = minutesBetween(iso, now)
  if (m === null) return 'unknown'
  return m < 1 ? 'just now' : m < 120 ? `${m} min ago` : `${Math.round(m / 60)} h ago`
}

export function untilText(iso: string | null, now: number): string {
  if (!iso) return ''
  const m = Math.round((Date.parse(iso) - now) / 60000)
  if (m <= 0) return 'reset due'
  if (m < 120) return `in ${m} min`
  if (m < 48 * 60) return `in ${Math.round(m / 60)} h`
  return `in ${Math.round(m / 1440)} d`
}

export function durationText(minutes: number): string {
  return minutes < 60 ? `${minutes} min` : `${Math.floor(minutes / 60)} h ${minutes % 60} min`
}

// ---------------------------------------------------------------- layout

export const WINDOW_LABELS: Record<string, { long: string; short: string }> = {
  '5h': { long: '5 hours', short: '5h' },
  week: { long: 'Week', short: 'Week' },
  '3p-5h': { long: 'Claude/GPT 5 hours', short: 'C/G 5h' },
  '3p-week': { long: 'Claude/GPT week', short: 'C/G wk' },
  argon: { long: 'Argon week', short: 'Argon' },
}

/** Row layout for the room inside a box: label width, bar width (0 hides it), reset beside or below. */
export function layoutFor(inner: number): { label: number; long: boolean; bar: number; resetBeside: boolean } {
  if (inner >= 50) return { label: 18, long: true, bar: 10, resetBeside: true }
  if (inner >= 34) return { label: 7, long: false, bar: 10, resetBeside: true }
  if (inner >= 24) return { label: 7, long: false, bar: 8, resetBeside: false }
  return { label: 7, long: false, bar: 0, resetBeside: false }
}

// ---------------------------------------------------------------- worktrees

export function toolOfFolder(folder: string): ToolId | null {
  return folder.includes('-agy-') ? 'agy' : folder.includes('-codex-') ? 'codex' : folder.includes('-claude-') ? 'claude' : null
}

/** `git worktree list --porcelain`, without the main checkout (always listed first) or detached heads. */
export function parseWorktreeList(porcelain: string): { path: string; folder: string; branch: string }[] {
  return porcelain
    .split(/\r?\n\r?\n/)
    .slice(1)
    .flatMap(block => {
      const path = /^worktree (.+)$/m.exec(block)?.[1]?.trim()
      const branch = /^branch refs\/heads\/(.+)$/m.exec(block)?.[1]?.trim()
      if (!path || !branch) return []
      return [{ path, folder: basename(path), branch }]
    })
}

/** File paths from `git status --porcelain`, renames reduced to their new name. */
export function parseStatusFiles(porcelain: string): string[] {
  return porcelain
    .split(/\r?\n/)
    .filter(line => line.length > 3)
    .map(line => line.slice(3).split(' -> ').pop()!.replace(/^"|"$/g, ''))
}

export function basename(path: string): string {
  return path.replace(/[\\/]+$/, '').split(/[\\/]/).pop() ?? path
}

// ---------------------------------------------------------------- processes

export type Proc = { pid: number; ppid: number; name: string; cmd: string; startedAt: string }

/** What a command line says a worker is doing; the first match wins. */
const ACTIVITIES: [RegExp, string][] = [
  [/vitest/i, 'tests'],
  [/cucumber/i, 'scenarios'],
  [/playwright/i, 'browser tests'],
  [/\btsc(\.cmd)?\b|typescript[\\/]bin/i, 'type-check'],
  [/eslint/i, 'lint'],
  [/prettier/i, 'format'],
  [/\bvite\b/i, 'serving'],
  [/\bgit(\.exe)?\s/i, 'git'],
  [/\bnpm(\.cmd)?\s/i, 'npm'],
]

export function activityOf(commands: string[]): string[] {
  const found: string[] = []
  for (const cmd of commands) {
    const hit = ACTIVITIES.find(([pattern]) => pattern.test(cmd))
    if (hit && !found.includes(hit[1])) found.push(hit[1])
  }
  return found
}

function workerKind(p: Proc): ToolId | null {
  const name = p.name.toLowerCase().replace(/\.exe$/, '')
  if (name === 'codex' && /\sexec(\s|$)/.test(p.cmd)) return 'codex'
  if (name === 'agy' && /\s(-p|--print|--prompt)\s/.test(p.cmd)) return 'agy'
  return null
}

/** The folder a shell command line moves into (`cd ../x && …`), or a `-C <dir>` flag. */
function folderNamedIn(cmd: string): string | null {
  // `cd` at the start of any shell segment, including inside `eval '…'` or `bash -c "…"`.
  const cd = /(?:^|[\s;&|("'])cd\s+(["']?)([^"'&;|\s]+)\1\s*(?:&&|;|$)/.exec(cmd)?.[2]
  if (cd) return basename(cd.trim())
  const flag = /\s-C\s+(["']?)([^"'\s]+)\1/.exec(cmd)?.[2]
  return flag && flag !== '.' ? basename(flag) : null
}

/**
 * Worker CLIs, each paired with its worktree: first by a `cd`/`-C` in its own or an ancestor's
 * command line, else by a worktree path in those lines. Activity comes from its descendants only,
 * so the prompt text in its own command line never counts.
 */
export function findAgents(procs: Proc[], worktrees: Pick<Worktree, 'folder' | 'path'>[]): Agent[] {
  const byPid = new Map(procs.map(p => [p.pid, p]))
  const children = new Map<number, Proc[]>()
  for (const p of procs) children.set(p.ppid, [...(children.get(p.ppid) ?? []), p])
  const folders = new Set(worktrees.map(w => w.folder))

  const lineage = (p: Proc): Proc[] => {
    const chain: Proc[] = []
    for (let at: Proc | undefined = p; at && chain.length < 6; at = byPid.get(at.ppid)) {
      if (chain.includes(at)) break
      chain.push(at)
    }
    return chain
  }
  const descendants = (pid: number): Proc[] => {
    const out: Proc[] = []
    const queue = [...(children.get(pid) ?? [])]
    while (queue.length && out.length < 200) {
      const p = queue.shift()!
      out.push(p)
      queue.push(...(children.get(p.pid) ?? []))
    }
    return out
  }

  // A worker's own child of the same kind (agy re-execs itself) is not a second agent.
  const workers = procs.filter(p => workerKind(p) && !(byPid.get(p.ppid) && workerKind(byPid.get(p.ppid)!)))
  return workers.map(p => {
    const chain = lineage(p)
    let worktree: string | null = null
    for (const q of chain) {
      const named = folderNamedIn(q.cmd)
      if (named && folders.has(named)) { worktree = named; break }
      const byPath = worktrees.find(w => q.cmd.includes(w.path) || q.cmd.includes(w.path.replace(/\//g, '\\')))
      if (byPath) { worktree = byPath.folder; break }
    }
    const model = /\s(?:--model|-m)[\s=]"?([\w.-]+)/.exec(p.cmd)?.[1] ?? 'default model'
    return {
      pid: p.pid,
      tool: workerKind(p)!,
      model,
      startedAt: p.startedAt,
      worktree,
      activity: activityOf(descendants(p.pid).map(d => d.cmd)),
    }
  })
}

// ---------------------------------------------------------------- work rows

export type WorkRow = {
  key: string
  tool: ToolId | null
  name: string
  status: string
  tone: Tone
  flagged: boolean
  facts: string
  latest: string | null
}

/**
 * One row per worktree worth showing. Agents without a known worktree fall back to the
 * likeliest one of their tool: uncommitted edits first, then a fresh branch cut from main.
 */
export function workRows(worktrees: Worktree[], agents: Agent[], now: number): WorkRow[] {
  const agentOf = new Map<string, Agent>()
  for (const a of agents) if (a.worktree) agentOf.set(a.worktree, a)
  const rank = (w: Worktree) => (w.changed > 0 ? 0 : w.atMain ? 1 : 2)
  for (const a of agents.filter(x => !x.worktree)) {
    const candidate = worktrees
      .filter(w => w.tool === a.tool && !agentOf.has(w.folder) && rank(w) < 2)
      .sort((x, y) => rank(x) - rank(y))[0]
    if (candidate) agentOf.set(candidate.folder, a)
  }

  return worktrees
    .filter(w => agentOf.has(w.folder) || w.ahead > 0 || w.changed > 0 || w.atMain)
    .sort((x, y) => Number(agentOf.has(y.folder)) - Number(agentOf.has(x.folder)) || x.folder.localeCompare(y.folder))
    .map(w => describe(w, agentOf.get(w.folder), now))
}

function describe(w: Worktree, agent: Agent | undefined, now: number): WorkRow {
  const base = { key: w.folder, tool: agent?.tool ?? w.tool, name: w.branch.replace(/^(feat|fix|chore|docs|test)\//, '') }
  const lastEdit = w.newestFile ? `last edit ${agoText(w.newestAt, now)} · ${w.newestFile}` : null
  if (agent) {
    const quiet = minutesBetween(w.newestAt ?? agent.startedAt, now) ?? 0
    const ran = minutesBetween(agent.startedAt, now) ?? 0
    const [status, tone, flagged]: [string, Tone, boolean] =
      agent.activity.length > 0
        ? [agent.activity[0]!, 'normal', false]
        : quiet >= QUIET_MINUTES
          ? [`quiet ${quiet} min`, 'warn', true]
          : ['editing', 'quiet', false]
    return { ...base, status, tone, flagged, facts: `${agent.model} · ${durationText(ran)} · ${w.changed} files`, latest: lastEdit ?? 'no edits yet' }
  }
  if (w.ahead > 0)
    return {
      ...base,
      status: 'needs review',
      tone: 'brand',
      flagged: true,
      facts: `finished ${agoText(w.lastCommitAt, now)} · ${w.ahead} commit${w.ahead === 1 ? '' : 's'}`,
      latest: w.lastCommit ? `"${w.lastCommit}"` : null,
    }
  if (w.changed > 0)
    return { ...base, status: 'stopped', tone: 'warn', flagged: true, facts: `${w.changed} files uncommitted`, latest: lastEdit }
  return { ...base, status: 'idle', tone: 'quiet', flagged: false, facts: 'no changes yet', latest: null }
}

export function workSummary(rows: WorkRow[]): string {
  const running = rows.filter(r => !['needs review', 'stopped', 'idle'].includes(r.status)).length
  const review = rows.filter(r => r.status === 'needs review').length
  const stopped = rows.filter(r => r.status === 'stopped').length
  const parts = [
    running ? `${running} running` : '',
    review ? `${review} need${review === 1 ? 's' : ''} review` : '',
    stopped ? `${stopped} stopped` : '',
  ].filter(Boolean)
  return parts.join(' · ') || (rows.length ? 'Nothing running' : 'No work open')
}
