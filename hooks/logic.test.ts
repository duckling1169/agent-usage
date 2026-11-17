import { expect, test } from 'claude-code/testing'

import type { Agent, Worktree } from '../types'
import { activityOf, findAgents, layoutFor, parseStatusFiles, parseUsage, parseWorktreeList, verdict, workRows, workSummary } from './lib/logic'
import type { Proc } from './lib/logic'
import { elapsedSeconds } from './lib/probe'

const NOW = Date.parse('2026-11-17T22:00:00Z')
const minutesAgo = (m: number) => new Date(NOW - m * 60000).toISOString()

const worktree = (over: Partial<Worktree>): Worktree => ({
  path: 'C:/code/airport-agy-ratings',
  folder: 'airport-agy-ratings',
  branch: 'feat/ratings',
  tool: 'agy',
  ahead: 0,
  changed: 0,
  atMain: false,
  lastCommit: null,
  lastCommitAt: null,
  newestFile: null,
  newestAt: null,
  ...over,
})

test('usage parsing keeps good windows and skips malformed ones', () => {
  const providers = parseUsage(JSON.stringify({
    providers: {
      codex: { windows: { '5h': { usedPercent: 12, resetsAt: 'x', stale: false }, bad: { usedPercent: 'no' } } },
      agy: { windows: {} },
    },
  }))
  expect(providers.map(p => p.provider)).toEqual(['codex', 'agy', 'claude'])
  expect(providers[0]!.windows).toEqual([{ name: '5h', usedPercent: 12, resetsAt: 'x', stale: false, observedAt: null }])
  expect(providers[2]!.windows).toEqual([])
})

test('the verdict names the tightest fresh window and ignores stale ones', () => {
  const v = verdict(
    [
      { provider: 'codex', windows: [{ name: '5h', usedPercent: 85, resetsAt: null, stale: false, observedAt: null }] },
      { provider: 'agy', windows: [{ name: '5h', usedPercent: 99, resetsAt: null, stale: true, observedAt: null }] },
    ],
    NOW,
  )
  expect(v).toEqual({ text: 'Codex is running low (15% left)', tone: 'warn' })
})

test('layout narrows the label, then the bar, then hides the bar', () => {
  expect(layoutFor(60)).toMatchObject({ long: true, bar: 10, resetBeside: true })
  expect(layoutFor(40)).toMatchObject({ long: false, bar: 10, resetBeside: true })
  expect(layoutFor(26)).toMatchObject({ bar: 8, resetBeside: false })
  expect(layoutFor(18)).toMatchObject({ bar: 0 })
})

test('worktree and status parsing', () => {
  const list = 'worktree C:/code/main\nHEAD a\nbranch refs/heads/main\n\nworktree C:/code/airport-agy-ratings\nHEAD b\nbranch refs/heads/feat/ratings\n\nworktree C:/code/ref\nHEAD c\ndetached\n'
  expect(parseWorktreeList(list)).toEqual([{ path: 'C:/code/airport-agy-ratings', folder: 'airport-agy-ratings', branch: 'feat/ratings' }])
  expect(parseStatusFiles(' M src/a.ts\n?? "b c.ts"\nR  old.ts -> new.ts\n')).toEqual(['src/a.ts', 'b c.ts', 'new.ts'])
})

test('activity reads the first matching tool once', () => {
  expect(activityOf(['node node_modules/vitest/vitest.mjs run', 'node vitest', 'git status --short'])).toEqual(['tests', 'git'])
})

test('an agent is paired with the worktree its shell moved into, and activity comes from its children', () => {
  const procs: Proc[] = [
    { pid: 1, ppid: 0, name: 'bash.exe', cmd: `bash -c "source snap.sh || true && eval 'cd ../airport-agy-ratings && MSYS_NO_PATHCONV=1 agy -p ...'"`, startedAt: minutesAgo(30) },
    { pid: 2, ppid: 1, name: 'agy.exe', cmd: 'agy -p "keep npx vitest run passing" --model gemini-4-hydrogen-high', startedAt: minutesAgo(30) },
    { pid: 3, ppid: 2, name: 'node.exe', cmd: 'node C:/code/airport-agy-ratings/node_modules/typescript/bin/tsc --noEmit', startedAt: minutesAgo(1) },
    { pid: 4, ppid: 0, name: 'codex.exe', cmd: 'codex app-server', startedAt: minutesAgo(300) },
  ]
  const agents = findAgents(procs, [worktree({}), worktree({ folder: 'airport-agy-shops', path: 'C:/code/airport-agy-shops' })])
  expect(agents).toEqual([
    { pid: 2, tool: 'agy', model: 'gemini-4-hydrogen-high', startedAt: minutesAgo(30), worktree: 'airport-agy-ratings', activity: ['type-check'] },
  ])
})

test('rows: running, quiet, needs review, stopped, and merged worktrees hidden', () => {
  const agent: Agent = { pid: 2, tool: 'agy', model: 'hydrogen', startedAt: minutesAgo(51), worktree: 'airport-agy-ratings', activity: [] }
  const rows = workRows(
    [
      worktree({ changed: 37, newestFile: 'movement.ts', newestAt: minutesAgo(2) }),
      worktree({ folder: 'airport-codex-shops', path: 'x', branch: 'feat/shops', tool: 'codex', ahead: 4, lastCommit: 'feat: shops', lastCommitAt: minutesAgo(12) }),
      worktree({ folder: 'airport-agy-old', path: 'y', branch: 'feat/old' }),
      worktree({ folder: 'airport-agy-left', path: 'z', branch: 'feat/left', changed: 3 }),
    ],
    [agent],
    NOW,
  )
  expect(rows.map(r => [r.name, r.status])).toEqual([
    ['ratings', 'editing'],
    ['left', 'stopped'],
    ['shops', 'needs review'],
  ])
  expect(rows[0]!.facts).toBe('hydrogen · 51 min · 37 files')
  expect(workSummary(rows)).toBe('1 running · 1 needs review · 1 stopped')

  const quiet = workRows([worktree({ changed: 5, newestFile: 'a.ts', newestAt: minutesAgo(14) })], [agent], NOW)
  expect(quiet[0]).toMatchObject({ status: 'quiet 14 min', tone: 'warn', flagged: true })
})

test('an agent with no known worktree falls back to its tool’s fresh branch, not a merged one', () => {
  const agent: Agent = { pid: 9, tool: 'agy', model: 'm', startedAt: minutesAgo(1), worktree: null, activity: [] }
  const rows = workRows(
    [worktree({ folder: 'airport-agy-old', path: 'y', branch: 'feat/old' }), worktree({ atMain: true })],
    [agent],
    NOW,
  )
  expect(rows.map(r => [r.name, r.status])).toEqual([['ratings', 'editing']])
})

test('ps elapsed times parse on macOS and Linux', () => {
  expect(elapsedSeconds('05:07')).toBe(307)
  expect(elapsedSeconds('01:02:03')).toBe(3723)
  expect(elapsedSeconds('2-01:00:00')).toBe(176400)
  expect(elapsedSeconds('bad')).toBeNull()
})
