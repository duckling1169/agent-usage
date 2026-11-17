// The pane's drawing: data in, tree out. No reads or writes here.
//
// One system for every box: title (bold, sentence case), then a summary line (dim, sentence
// case, coloured only when something needs you), then groups one row apart. Tool names are bold in
// their colour; details are dim and lower case.

import type { EngineInterface as Engine } from 'claude-code'

import type { UsageSnapshot, WorkSnapshot } from '../../types'
import { TOOL_NAMES, WINDOW_LABELS, agoText, layoutFor, untilText, verdict, windowLevel, workRows, workSummary } from './logic'
import type { Tone } from './logic'
import { MARKS, colorOf } from './theme'
import type { Theme, ThemeName } from './theme'

type UI = ReturnType<Engine['ui']['resolve']>

export type PaneModel = {
  usage: UsageSnapshot
  work: WorkSnapshot
  theme: Theme
  themeName: ThemeName
  columns: number
  now: number
  onRefresh: () => void
  onTheme: () => void
}

export function drawPane({ Box, Text, Button }: UI, m: PaneModel) {
  const t = m.theme
  const fit = layoutFor(Math.max(16, m.columns - 4))
  const toned = (tone: Tone) => ({ color: colorOf(t, tone, null), dimColor: tone === 'quiet' || undefined })

  const section = (key: string, title: string, summary: string, tone: Tone, body: unknown) => (
    <Box key={key} flexDirection="column" borderStyle="round" borderColor={t.border} paddingX={1} marginBottom={1}>
      <Text bold color={t.title} wrap="truncate-end">{title}</Text>
      <Text {...toned(tone)} wrap="truncate-end">{summary}</Text>
      {body as never}
    </Box>
  )

  // ------------------------------------------------------------ quota
  const mood = m.usage.busy ? { text: 'Checking…', tone: 'quiet' as Tone } : verdict(m.usage.providers, m.now)
  const quota = m.usage.providers.map(p => (
    <Box key={p.provider} flexDirection="column" marginTop={1}>
      <Text bold color={t.brand[p.provider]} wrap="truncate-end">{MARKS[p.provider]} {TOOL_NAMES[p.provider]}</Text>
      {p.windows.length === 0 && <Text dimColor wrap="truncate-end">no reading yet</Text>}
      {p.windows.map(w => {
        const left = Math.max(0, Math.min(100, 100 - w.usedPercent))
        const level = windowLevel(left)
        const levelColor = level === 'normal' ? undefined : colorOf(t, level, null)
        const fill = w.stale ? t.stale : (levelColor ?? t.brand[p.provider])
        const filled = Math.round((left / 100) * fit.bar)
        const label = WINDOW_LABELS[w.name]?.[fit.long ? 'long' : 'short'] ?? w.name
        const reset = untilText(w.resetsAt, m.now) + (w.stale ? `, as of ${agoText(w.observedAt, m.now)}` : '')
        return (
          <Box key={w.name} flexDirection="column">
            <Box flexDirection="row" height={1}>
              <Box width={fit.label + 1} flexShrink={0}>
                <Text dimColor={w.stale} wrap="truncate-end">{label}</Text>
              </Box>
              {fit.bar > 0 && (
                <Box width={fit.bar} height={1} flexShrink={0} flexDirection="row">
                  {filled > 0 && <Box width={filled} height={1} backgroundColor={fill}><Text> </Text></Box>}
                  {filled < fit.bar && <Box width={fit.bar - filled} height={1} backgroundColor={t.track}><Text> </Text></Box>}
                </Box>
              )}
              <Box width={5} flexShrink={0} justifyContent="flex-end">
                <Text color={levelColor} dimColor={w.stale && !levelColor}>{Math.round(left)}%</Text>
              </Box>
              {fit.resetBeside && (
                <Box marginLeft={2} flexShrink={1}>
                  <Text dimColor wrap="truncate-end">{reset}</Text>
                </Box>
              )}
            </Box>
            {!fit.resetBeside && reset && (
              <Box marginLeft={fit.label + 1}>
                <Text dimColor wrap="truncate-end">{reset}</Text>
              </Box>
            )}
          </Box>
        )
      })}
    </Box>
  ))

  // ------------------------------------------------------------ work
  const rows = workRows(m.work.worktrees, m.work.agents, m.now)
  const work = rows.map(r => {
    const statusColor = r.tone === 'normal' ? t.ok : colorOf(t, r.tone, r.tool)
    return (
      <Box key={r.key} flexDirection="column" marginTop={1}>
        <Box flexDirection="row">
          <Box flexGrow={1} flexShrink={1}>
            <Text wrap="truncate-end">
              <Text bold color={r.tool ? t.brand[r.tool] : undefined}>{r.tool ? MARKS[r.tool] : '·'}</Text> <Text bold>{r.name}</Text>
            </Text>
          </Box>
          <Box flexShrink={0} marginLeft={1}>
            <Text color={statusColor} dimColor={r.tone === 'quiet' || undefined}>{r.status}{r.flagged ? ' ●' : ''}</Text>
          </Box>
        </Box>
        <Text dimColor wrap="truncate-end">  {r.facts}</Text>
        {r.latest && <Text dimColor wrap="truncate-end">  {r.latest}</Text>}
      </Box>
    )
  })

  // ------------------------------------------------------------ footer
  const checked = m.usage.checkedAt ? `checked ${new Date(m.usage.checkedAt).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}` : 'not checked yet'
  const errors = [m.usage.error && `Quota: ${m.usage.error}`, m.work.error && `Work: ${m.work.error}`].filter(Boolean) as string[]

  return (
    <Box flexDirection="column">
      {section('quota', 'Quota', mood.text, mood.tone, quota)}
      {section('work', 'Work', workSummary(rows), 'quiet', <Box flexDirection="column">{work}</Box>)}
      <Box flexDirection="row" paddingX={1}>
        <Button key="refresh" label="Refresh" onPress={m.onRefresh} />
        <Box marginLeft={1}>
          <Button key="theme" label={`Theme: ${m.themeName}`} onPress={m.onTheme} />
        </Box>
        <Box marginLeft={1} flexShrink={1}>
          <Text dimColor wrap="truncate-end">{m.usage.busy ? 'checking…' : checked}</Text>
        </Box>
      </Box>
      {errors.map(text => (
        <Box key={text} paddingX={1}>
          <Text color={t.alert} wrap="wrap">{text}</Text>
        </Box>
      ))}
    </Box>
  )
}
