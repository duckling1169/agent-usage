// Every colour and mark the pane draws. Add a theme by adding one entry to THEMES.

import type { ToolId } from '../../types'
import type { Tone } from './logic'

export type Theme = {
  /** Empty part of a bar. */
  track: string
  /** Out-of-date readings. */
  stale: string
  /** Running low, quiet, stopped. */
  warn: string
  /** Out of quota, errors. */
  alert: string
  /** Something healthy is happening. */
  ok: string
  border: string
  /** Box titles; undefined keeps the surface's own text colour. */
  title: string | undefined
  brand: Record<ToolId, string>
}

export const THEMES = {
  /** Muted: brand colour fills a healthy bar; amber and red only when it matters. */
  dark: {
    track: '#30333a', stale: '#55595f', warn: '#d9a441', alert: '#e06c66', ok: '#7fb08a', border: '#3a3d44',
    title: undefined,
    brand: { codex: '#10a37f', agy: '#4285f4', claude: '#d97757' },
  },
  /** Synthwave: glowing tubes on a deep purple track. */
  neon: {
    track: '#2a1640', stale: '#6b5a8a', warn: '#ffe600', alert: '#ff2079', ok: '#39ff14', border: '#bc13fe',
    title: '#00f0ff',
    brand: { codex: '#39ff14', agy: '#00f0ff', claude: '#ff6ec7' },
  },
} satisfies Record<string, Theme>

export type ThemeName = keyof typeof THEMES
export const THEME_NAMES = Object.keys(THEMES) as ThemeName[]
export const DEFAULT_THEME: ThemeName = 'dark'

export function isThemeName(value: unknown): value is ThemeName {
  return typeof value === 'string' && value in THEMES
}

export function nextTheme(current: string): ThemeName {
  const i = THEME_NAMES.indexOf(current as ThemeName)
  return THEME_NAMES[(i + 1) % THEME_NAMES.length]!
}

/** Each tool's own mark, the same in every theme. */
export const MARKS: Record<ToolId, string> = { codex: '◇', agy: '▲', claude: '✻' }

/** The colour for a tone; `undefined` means the surface's default (with `dim` for quiet). */
export function colorOf(theme: Theme, tone: Tone, tool: ToolId | null): string | undefined {
  switch (tone) {
    case 'warn': return theme.warn
    case 'alert': return theme.alert
    case 'brand': return tool ? theme.brand[tool] : undefined
    default: return undefined
  }
}
