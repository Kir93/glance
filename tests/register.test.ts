import { describe, expect, mock, test } from 'claude-code/testing'

const START = Date.parse('2026-10-06T00:00:00Z')
const band = (bodyColumns: number, isWorking = false) =>
  ({
    plugin: 'glance',
    component: 'AbovePrompt',
    props: { hasSurvey: false, isWorking, maxRows: 10, bodyColumns },
  }) as const

const git = (dirty: string) => ($: unknown, e: { argv: readonly string[] }) => ({
  value: {
    exitCode: 0,
    stdout: e.argv.includes('symbolic-ref') ? 'main\n' : dirty,
    stderr: '',
    isStdoutTruncated: false,
    isStderrTruncated: false,
  },
})

describe('register', () => {
  test('one line: full when idle, live segments appended while working, details shed to fit', async ($, on) => {
    const clock = mock.clock(on, { now: START })
    let running: { id: string; description: string; type: string; status: string }[] = []
    on('session.start', ($, e) => ({ cwd: e.cwd }))
    on('session.cwd', () => ({ value: '/work/app' }))
    on('session.surfaces', () => ({ value: ['terminal', 'desktop'] }))
    on('session.usage', () => ({
      value: {
        startedAt: START,
        context: { tokens: 76_000, window: 200_000, percent: 38 },
        rateLimits: [
          { kind: 'five_hour', percentUsed: 41, resetsAt: '2026-10-06T02:15:00Z' },
          { kind: 'seven_day', percentUsed: 20, resetsAt: '2026-10-09T00:00:00Z' },
        ],
      },
    }))
    on('agent.list', () => ({ value: running }))
    on('process.run', git(' M a.ts\n?? b.ts\n'))
    on('tool.call', () => ({ result: {} }))
    on('turn.start', ($, e) => ({ turnId: e.turnId }))
    on('turn.complete', () => ({ text: '' }))

    await $.session.start({ surface: 'terminal', isInteractive: true, cwd: '/work/app' })

    for (const surface of ['terminal', 'desktop'] as const) {
      const idle = await $.ui.mount({ ...band(120), surface })
      expect(await idle.find({ type: 'Text', text: /^38%$/ })).toBeDefined()
      expect(await idle.find({ type: 'Text', text: /124K left/ })).toBeDefined()
      expect(await idle.find({ type: 'Text', text: /↻2:15/ })).toBeDefined()
      expect(await idle.find({ type: 'Text', text: /↻3d/ })).toBeDefined()
      expect(await idle.find({ type: 'Text', text: /^main$/ })).toBeDefined()
      expect(await idle.find({ type: 'Text', text: / ±2/ })).toBeDefined()
      expect(await idle.find({ type: 'Text', text: /^▸ $/ })).toBeUndefined()
      expect(await idle.find({ type: 'Text', text: /ready|last turn/ })).toBeUndefined()
      await idle.unmount()

      // Too narrow for everything: details go first, then git; context and both limits stay.
      const narrow = await $.ui.mount({ ...band(36), surface })
      expect(await narrow.find({ type: 'Text', text: /^38%$/ })).toBeDefined()
      expect(await narrow.find({ type: 'Text', text: /^5h $/ })).toBeDefined()
      expect(await narrow.find({ type: 'Text', text: /^7d $/ })).toBeDefined()
      expect(await narrow.find({ type: 'Text', text: /124K left|↻/ })).toBeUndefined()
      expect(await narrow.find({ type: 'Text', text: /^main$/ })).toBeUndefined()
      await narrow.unmount()
    }

    await $.turn.start({ text: 'go', turnId: 't1' })
    await $.tool.call({ tool: 'Read', file_path: '/work/app/src/a.ts' })
    await $.tool.call({
      tool: 'TodoWrite',
      todos: [
        { content: 'Fix authentication bug', status: 'in_progress', activeForm: 'Fixing' },
        { content: 'Add tests', status: 'completed', activeForm: 'Adding' },
      ],
    })
    running = [{ id: 'a1', description: 'Find auth code', type: 'Explore', status: 'running' }]
    await clock.advance(45_000)

    for (const surface of ['terminal', 'desktop'] as const) {
      // Working at 110 columns: resets and tokens-left are shed so the live segments fit.
      const working = await $.ui.mount({ ...band(110, true), surface })
      expect(await working.find({ type: 'Text', text: /^working$/ })).toBeDefined()
      expect(await working.find({ type: 'Text', text: /^ #2$/ })).toBeDefined()
      expect(await working.find({ type: 'Text', text: /^Explore$/ })).toBeDefined()
      expect(await working.find({ type: 'Text', text: /^ 40s$/ })).toBeDefined()
      expect(await working.find({ type: 'Text', text: /^1\/2$/ })).toBeDefined()
      expect(await working.find({ type: 'Text', text: /Fix authentication bug/ })).toBeDefined()
      expect(await working.find({ type: 'Text', text: /^main$/ })).toBeDefined()
      expect(await working.find({ type: 'Text', text: /124K left|↻/ })).toBeUndefined()
      await working.unmount()
    }

    await $.turn.complete({ reason: 'answer', answer: 'ok', durationMs: 1, isAborted: false, turnId: 't1' })

    for (const surface of ['terminal', 'desktop'] as const) {
      // Idle again: the tool segment goes; a background agent and unfinished todos stay.
      const after = await $.ui.mount({ ...band(140), surface })
      expect(await after.find({ type: 'Text', text: /^working$/ })).toBeUndefined()
      expect(await after.find({ type: 'Text', text: /^Explore$/ })).toBeDefined()
      expect(await after.find({ type: 'Text', text: /^1\/2$/ })).toBeDefined()
      await after.unmount()
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
    on('agent.list', () => ({ value: [] }))
    on('process.run', git(''))
    on('ui.status', ($, e) => {
      lines.push(e.text)
    })

    await $.session.start({ surface: 'vscode', isInteractive: true, cwd: '/work/app' })

    expect(lines.at(-1)).toBe('◔ 38% 124K left · ◑ 5h 41% ↻2:15 · ⎇ main ✓')
  })
})
