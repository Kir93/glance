import { describe, expect, mock, test } from 'claude-code/testing'

const START = Date.parse('2026-10-06T00:00:00Z')
const band = (bodyColumns: number, isWorking = false) =>
  ({
    plugin: 'glance',
    component: 'AbovePrompt',
    props: { hasSurvey: false, isWorking, maxRows: 10, bodyColumns },
  }) as const

describe('register', () => {
  test('one line of context, limit, activity and git on terminal and desktop', async ($, on) => {
    mock.clock(on, { now: START })
    let sevenDay = 20
    on('session.start', ($, e) => ({ cwd: e.cwd }))
    on('session.cwd', () => ({ value: '/work/app' }))
    on('session.usage', () => ({
      value: {
        startedAt: START,
        context: { tokens: 76_000, window: 200_000, percent: 38 },
        rateLimits: [
          { kind: 'five_hour', percentUsed: 41, resetsAt: '2026-10-06T02:15:00Z' },
          { kind: 'seven_day', percentUsed: sevenDay, resetsAt: '2026-10-09T00:00:00Z' },
        ],
      },
    }))
    on('process.run', ($, e) => ({
      value: {
        exitCode: 0,
        stdout: e.argv.includes('symbolic-ref') ? 'main\n' : ' M a.ts\n?? b.ts\n',
        stderr: '',
        isStdoutTruncated: false,
        isStderrTruncated: false,
      },
    }))
    on('tool.call', () => ({ result: {} }))
    on('turn.start', ($, e) => ({ turnId: e.turnId }))
    on('turn.complete', () => ({ text: '' }))
    on('session.surfaces', () => ({ value: ['terminal', 'desktop'] }))

    await $.session.start({ surface: 'terminal', isInteractive: true, cwd: '/work/app' })

    for (const surface of ['terminal', 'desktop'] as const) {
      const ui = await $.ui.mount({ ...band(120), surface })
      expect(await ui.find({ type: 'Text', text: /^◔ $/ })).toBeDefined()
      expect(await ui.find({ type: 'Text', text: /^38%$/ })).toBeDefined()
      expect(await ui.find({ type: 'Text', text: /124K left/ })).toBeDefined()
      expect(await ui.find({ type: 'Text', text: /^5h $/ })).toBeDefined()
      expect(await ui.find({ type: 'Text', text: /↻2:15/ })).toBeDefined()
      expect(await ui.find({ type: 'Text', text: /^main$/ })).toBeDefined()
      expect(await ui.find({ type: 'Text', text: / ±2/ })).toBeDefined()
      await ui.unmount()

      const narrow = await $.ui.mount({ ...band(36), surface })
      expect(await narrow.find({ type: 'Text', text: /^38%$/ })).toBeDefined()
      expect(await narrow.find({ type: 'Text', text: /^main$/ })).toBeUndefined()
      await narrow.unmount()
    }

    sevenDay = 92
    await $.turn.start({ text: 'go', turnId: 't1' })
    await $.tool.call({ tool: 'Read', file_path: '/work/app/src/a.ts' })
    await $.turn.complete({ reason: 'answer', answer: 'ok', durationMs: 1, isAborted: false, turnId: 't1' })

    for (const surface of ['terminal', 'desktop'] as const) {
      const ui = await $.ui.mount({ ...band(120), surface })
      expect(await ui.find({ type: 'Text', text: /^7d $/ })).toBeDefined()
      expect(await ui.find({ type: 'Text', text: /^92%$/ })).toBeDefined()
      expect(await ui.find({ type: 'Text', text: /^1 call last turn$/ })).toBeDefined()
      await ui.unmount()
    }
  })

  test('in VS Code the line is pinned as the status line instead', async ($, on) => {
    mock.clock(on, { now: START })
    const lines: (string | undefined)[] = []
    on('session.start', ($, e) => ({ cwd: e.cwd }))
    on('session.cwd', () => ({ value: '/work/app' }))
    on('session.surfaces', () => ({ value: ['vscode'] }))
    on('session.usage', () => ({
      value: {
        startedAt: START,
        context: { tokens: 76_000, window: 200_000, percent: 38 },
        rateLimits: [{ kind: 'five_hour', percentUsed: 41, resetsAt: '2026-10-06T02:15:00Z' }],
      },
    }))
    on('process.run', ($, e) => ({
      value: {
        exitCode: 0,
        stdout: e.argv.includes('symbolic-ref') ? 'main\n' : '',
        stderr: '',
        isStdoutTruncated: false,
        isStderrTruncated: false,
      },
    }))
    on('ui.status', ($, e) => {
      lines.push(e.text)
    })

    await $.session.start({ surface: 'vscode', isInteractive: true, cwd: '/work/app' })

    expect(lines.at(-1)).toBe('◔ 38%  124K left  ·  5h 41%  ↻2:15  ·  ⎇ main ✓')
  })
})
