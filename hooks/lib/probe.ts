// Side effects: everything that reads the machine. Each function returns data or throws;
// callers decide what a failure means.

import type { EngineInterface as Engine } from 'claude-code'

import type { ProviderUsage, Worktree, WorkSnapshot } from '../../types'
import { findAgents, parseStatusFiles, parseUsage, parseWorktreeList, toolOfFolder } from './logic'
import type { Proc } from './logic'

const MAX_STATS = 60

async function run($: Engine, argv: string[], cwd?: string, timeoutMs = 20000): Promise<string> {
  const result = await $.process.run(argv, { cwd, timeoutMs, stdin: '' })
  if (result.exitCode !== 0) {
    const reason = result.stderr.trim().split(/\r?\n/).pop() || `exit ${result.exitCode}`
    throw new Error(`${argv[0]}: ${reason}`)
  }
  return result.stdout
}

async function isWindows($: Engine): Promise<boolean> {
  return (await $.env.get('OS')) === 'Windows_NT'
}

async function exists($: Engine, path: string): Promise<boolean> {
  try {
    return (await $.fs.stat(path)).kind === 'file'
  } catch {
    return false
  }
}

// ---------------------------------------------------------------- usage

/**
 * The orchestrator's usage script. The installed copy lives under a version-hash folder that
 * changes on every update, so look it up rather than naming it; fall back to the marketplace copy.
 */
export async function locateUsageScript($: Engine): Promise<string | null> {
  const home = ((await $.env.get('USERPROFILE')) ?? (await $.env.get('HOME')) ?? '').replace(/\\/g, '/')
  if (!home) return null
  const tail = 'skills/alethe/scripts/orchestrate.py'
  const cache = `${home}/.claude/plugins/cache/alethe/alethe-orchestrate`
  const candidates: { path: string; mtime: number }[] = []
  try {
    for (const entry of await $.fs.list(cache)) {
      if (entry.kind !== 'dir') continue
      const path = `${cache}/${entry.name}/${tail}`
      try {
        candidates.push({ path, mtime: (await $.fs.stat(path)).mtimeMs })
      } catch {
        // Not a complete install.
      }
    }
  } catch {
    // No cache folder.
  }
  candidates.sort((a, b) => b.mtime - a.mtime)
  if (candidates[0]) return candidates[0].path
  const marketplace = `${home}/.claude/plugins/marketplaces/alethe/${tail}`
  return (await exists($, marketplace)) ? marketplace : null
}

async function python($: Engine): Promise<string[]> {
  return (await isWindows($)) ? ['py', '-3'] : ['python3']
}

/**
 * Codex has no usage command; it writes fresh limits after any run. A one-line prompt on its
 * cheapest model costs a sliver of the window, so only a manual refresh does it.
 */
export async function pingCodex($: Engine): Promise<void> {
  await $.process.run(
    ['codex', 'exec', '--skip-git-repo-check', '-s', 'read-only', '-m', 'gpt-6.1-terra', '-c', 'model_reasoning_effort="low"', 'Reply with OK only.'],
    { stdin: '', timeoutMs: 90000 },
  )
}

export async function readUsage($: Engine, script: string, refreshClaude: boolean): Promise<ProviderUsage[]> {
  const argv = [...(await python($)), script, 'usage', '--refresh-agy', ...(refreshClaude ? ['--refresh-claude'] : []), '--json']
  return parseUsage(await run($, argv, undefined, 120000))
}

// ---------------------------------------------------------------- work

async function git($: Engine, cwd: string, args: string[]): Promise<string> {
  return (await run($, ['git', ...args], cwd)).trim()
}

async function readWorktree($: Engine, path: string, folder: string, branch: string, mainHead: string): Promise<Worktree> {
  const [ahead, head, status] = await Promise.all([
    git($, path, ['rev-list', '--count', 'main..HEAD']),
    git($, path, ['rev-parse', 'HEAD']),
    git($, path, ['status', '--porcelain']),
  ])
  const commits = Number(ahead) || 0
  const [lastCommit, lastCommitAt] =
    commits > 0 ? (await git($, path, ['log', '-1', '--format=%s%x00%cI'])).split('\u0000') : [null, null]
  const files = parseStatusFiles(status)
  let newestFile: string | null = null
  let newestMs = 0
  for (const file of files.slice(0, MAX_STATS)) {
    try {
      const stat = await $.fs.stat(`${path}/${file}`)
      if (stat.kind === 'file' && stat.mtimeMs > newestMs) {
        newestMs = stat.mtimeMs
        newestFile = file.split('/').pop() ?? file
      }
    } catch {
      // Deleted files have no time.
    }
  }
  return {
    path,
    folder,
    branch,
    tool: toolOfFolder(folder),
    ahead: commits,
    changed: files.length,
    atMain: head === mainHead,
    lastCommit: lastCommit ?? null,
    lastCommitAt: lastCommitAt ?? null,
    newestFile,
    newestAt: newestMs ? new Date(newestMs).toISOString() : null,
  }
}

/** `ps` elapsed time, `[[dd-]hh:]mm:ss`, in seconds; null when unreadable. */
export function elapsedSeconds(etime: string): number | null {
  const m = /^(?:(\d+)-)?(?:(\d+):)?(\d+):(\d+)$/.exec(etime)
  if (!m) return null
  return ((Number(m[1] ?? 0) * 24 + Number(m[2] ?? 0)) * 60 + Number(m[3])) * 60 + Number(m[4])
}

/** Every process with its parent, in one call. */
export async function listProcesses($: Engine): Promise<Proc[]> {
  if (await isWindows($)) {
    const script =
      'Get-CimInstance Win32_Process | ForEach-Object { [pscustomobject]@{ pid = $_.ProcessId; ppid = $_.ParentProcessId; ' +
      "name = $_.Name; cmd = [string]$_.CommandLine; startedAt = $_.CreationDate.ToUniversalTime().ToString('o') } } | ConvertTo-Json -Compress"
    const parsed = JSON.parse((await run($, ['powershell', '-NoProfile', '-NonInteractive', '-Command', script])) || '[]') as Proc | Proc[]
    return Array.isArray(parsed) ? parsed : [parsed]
  }
  const now = Date.now()
  // `etime` ([[dd-]hh:]mm:ss) works on both macOS and Linux; `etimes` is Linux-only.
  return (await run($, ['ps', '-Ao', 'pid=,ppid=,etime=,args=']))
    .split('\n')
    .flatMap(line => {
      const m = /^\s*(\d+)\s+(\d+)\s+(\S+)\s+(.*)$/.exec(line)
      if (!m) return []
      const seconds = elapsedSeconds(m[3]!)
      if (seconds === null) return []
      const cmd = m[4]!
      const name = (cmd.split(/\s/)[0] ?? '').split('/').pop() ?? ''
      return [{ pid: Number(m[1]), ppid: Number(m[2]), name, cmd, startedAt: new Date(now - seconds * 1000).toISOString() }]
    })
}

export async function readWork($: Engine, repo: string): Promise<Omit<WorkSnapshot, 'error'>> {
  const [list, mainHead, procs] = await Promise.all([
    git($, repo, ['worktree', 'list', '--porcelain']),
    git($, repo, ['rev-parse', 'main']),
    listProcesses($),
  ])
  const worktrees = await Promise.all(parseWorktreeList(list).map(w => readWorktree($, w.path, w.folder, w.branch, mainHead)))
  return { worktrees, agents: findAgents(procs, worktrees), checkedAt: new Date().toISOString() }
}

/** The main checkout of the repository the session runs in, or null outside one. */
export async function findRepo($: Engine, cwd: string): Promise<string | null> {
  try {
    const common = await git($, cwd, ['rev-parse', '--path-format=absolute', '--git-common-dir'])
    return common.replace(/[\\/]\.git[\\/]?$/, '')
  } catch {
    return null
  }
}
