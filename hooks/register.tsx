// Wiring only: state, timers, commands and the pane. Reading the machine is in lib/probe.ts,
// deciding what it means is in lib/logic.ts, drawing is in lib/view.tsx.

import { atom, read, update } from 'claude-code'
import type { EngineInterface as Engine, Register } from 'claude-code'

import type { UsageSnapshot, WorkSnapshot } from '../types'
import { findRepo, locateUsageScript, pingCodex, readUsage, readWork } from './lib/probe'
import { DEFAULT_THEME, THEMES, THEME_NAMES, isThemeName, nextTheme } from './lib/theme'
import type { ThemeName } from './lib/theme'
import { drawPane } from './lib/view'

const PANE = 'agent-usage'
const USAGE_MS = 5 * 60 * 1000
const WORK_MS = 30 * 1000

const usage = atom({ plugin: 'agent-usage', key: 'usage' } as const, { providers: [], checkedAt: null, error: null, busy: false } as UsageSnapshot, { shape: 'usage-2' })
const work = atom({ plugin: 'agent-usage', key: 'work' } as const, { worktrees: [], agents: [], checkedAt: null, error: null } as WorkSnapshot, { shape: 'work-3' })
const theme = atom({ plugin: 'agent-usage', key: 'theme' } as const, DEFAULT_THEME as string, { shape: 'theme-1' })
const THEME_STORE_KEY = 'theme'

const message = (error: unknown) => (error instanceof Error ? error.message : String(error))

// Found once per load (a reload runs session.start again), and one refresh of each kind at a
// time: a timer that fires while one runs joins it.
const context: { repo: string | null; script: string | null } = { repo: null, script: null }
let usageRun: Promise<void> | null = null
let workRun: Promise<void> | null = null

function refreshUsage($: Engine, manual: boolean): Promise<void> {
  usageRun ??= runUsage($, manual).finally(() => { usageRun = null })
  return usageRun
}

async function runUsage($: Engine, manual: boolean): Promise<void> {
  await update($, usage, old => ({ ...old, busy: true }))
  try {
    if (!context.script) throw new Error('usage script not found (is alethe-orchestrate installed?)')
    if (manual) await pingCodex($).catch(() => undefined)
    const providers = await readUsage($, context.script, manual)
    await update($, usage, () => ({ providers, checkedAt: new Date().toISOString(), error: null, busy: false }))
  } catch (error) {
    await update($, usage, old => ({ ...old, error: message(error), busy: false }))
  }
}

function refreshWork($: Engine): Promise<void> {
  workRun ??= runWork($).finally(() => { workRun = null })
  return workRun
}

async function runWork($: Engine): Promise<void> {
  try {
    if (!context.repo) throw new Error('not in a git repository')
    const next = await readWork($, context.repo)
    await update($, work, () => ({ ...next, error: null }))
  } catch (error) {
    await update($, work, old => ({ ...old, error: message(error) }))
  }
}

async function setTheme($: Engine, name: ThemeName): Promise<void> {
  await update($, theme, () => name)
  await $.store.set(THEME_STORE_KEY, name)
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    await $.command.register({ name: 'usage-pane', description: 'Show the agent usage pane and refresh it (pings Codex)' })
    await $.command.register({ name: 'usage-theme', description: `Change the usage pane's look: ${THEME_NAMES.join(', ')}` })
    const saved = await $.store.get(THEME_STORE_KEY)
    if (isThemeName(saved)) await update($, theme, () => saved)

    ;[context.repo, context.script] = await Promise.all([findRepo($, e.cwd), locateUsageScript($)])
    void $.ui.open({ id: PANE, title: 'Agent usage' })
    void refreshUsage($, false)
    void refreshWork($)
    $.clock.every(WORK_MS, () => void refreshWork($))
    // Quota on the UTC clock's 5-minute marks (:00, :05, …).
    $.clock.after(USAGE_MS - (Date.now() % USAGE_MS), () => {
      void refreshUsage($, false)
      $.clock.every(USAGE_MS, () => void refreshUsage($, false))
    })
    return next(e)
  })

  on('command.run', { command: 'usage-pane' }, async $ => {
    await $.ui.open({ id: PANE, title: 'Agent usage' })
    void refreshWork($)
    void refreshUsage($, true)
    return { text: 'Refreshing agent usage; the pane updates when it is done.' }
  })

  on('command.run', { command: 'usage-theme' }, async ($, e) => {
    const asked = (e.args ?? '').trim().toLowerCase()
    const name = asked ? asked : nextTheme(await read($, theme))
    if (!isThemeName(name)) return { text: `No theme called "${asked}". Try: ${THEME_NAMES.join(', ')}.` }
    await setTheme($, name)
    return { text: `Usage pane theme: ${name}.` }
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const current = await read($, theme)
    const themeName = isThemeName(current) ? current : DEFAULT_THEME
    return drawPane($.ui.resolve(e), {
      usage: await read($, usage),
      work: await read($, work),
      theme: THEMES[themeName],
      themeName,
      columns: e.props.bodyColumns ?? e.viewport?.columns ?? 60,
      now: Date.now(),
      onRefresh: () => { void refreshWork($); void refreshUsage($, true) },
      onTheme: () => void setTheme($, nextTheme(themeName)),
    })
  })
}
