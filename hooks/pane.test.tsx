import { expect, test } from 'claude-code/testing'

const pane = (bodyColumns: number) =>
  ({
    plugin: 'agent-usage',
    component: 'Pane',
    requestId: 'agent-usage',
    props: { title: 'Agent usage', isFocused: false, bodyColumns, placement: 'dock', scroll: { offset: 0, bodyRows: 40 }, view: {} },
  }) as const

const usage = JSON.stringify({
  providers: {
    codex: { windows: { '5h': { usedPercent: 8, resetsAt: '2099-01-01T00:00:00Z', stale: false } } },
    agy: { windows: { '3p-week': { usedPercent: 0, resetsAt: '2099-01-01T00:00:00Z', stale: true } } },
    claude: { windows: {} },
  },
})

const ok = (stdout: string) => ({ value: { exitCode: 0, stdout, stderr: '', isStdoutTruncated: false, isStderrTruncated: false } })

for (const surface of ['terminal', 'desktop'] as const) {
  test(`rows stay inside the pane at narrow, medium and wide widths (${surface})`, async ($, on) => {
    on('command.register', () => ({ value: { command: 'usage-pane' } }))
    on('ui.open', () => ({ value: { isPlaced: true } }))
    on('clock.every', () => ({ value: undefined }))
    on('clock.after', () => ({ value: undefined }))
    on('store.get', () => ({ value: undefined }))
    on('env.get', (_, e) => ({ value: e.name === 'OS' ? 'Windows_NT' : e.name === 'USERPROFILE' ? 'C:/home' : undefined }))
    on('fs.list', () => ({ value: [] }))
    on('fs.stat', () => ({ value: { kind: 'file', size: 1, mtimeMs: 1, isLink: false } }))
    on('process.run', (_, e) => {
      const [cmd, ...args] = e.argv
      if (cmd === 'py') return ok(usage)
      if (cmd === 'powershell') return ok('[]')
      if (cmd === 'git' && args.includes('--git-common-dir')) return ok('C:/repo/.git')
      return ok('')
    })
    on('session.start', (_, e) => ({ cwd: e.cwd }))
    await $.session.start({ cwd: 'C:/repo', surface, isInteractive: true })

    for (const width of [22, 30, 40, 70]) {
      const ui = await $.ui.mount({ ...pane(width), surface })
      const row = await ui.find({ type: 'Text', text: /^92%$/ })
      expect(row).toBeTruthy()
      const summary = await ui.find({ type: 'Text', text: /No work open/ })
      expect(summary).toBeTruthy()
      await ui.unmount()
    }
  })
}
