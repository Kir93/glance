import type { AgentInfo, On, RenderNode } from 'claude-code'
import { describe, expect, mock, test } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'

const START = Date.parse('2026-10-06T00:00:00Z')
const SECOND = 1000
const band = (bodyColumns: number, isWorking = false) =>
  ({
    plugin: 'glance',
    component: 'AbovePrompt',
    props: { hasSurvey: false, isWorking, maxRows: 10, bodyColumns, scroll: { offset: 0, bodyRows: 10 }, view: {} },
  }) as const

// `git` on branch `main` with this `status --porcelain` (or the repo's own); the repo's remotes,
// unpushed count and `diff --shortstat` are read from `repo` at each call. Commands in `failing`
// exit as without HEAD, those in `hanging` time out, and every command run is noted in `ran`.
type Repo = {
  status?: string
  remotes?: string
  ahead?: string
  shortstat?: string
  failing?: string[]
  hanging?: string[]
  ran?: string[]
}
const git =
  (dirty: string, repo: Repo = {}) =>
  ($: unknown, e: { argv: readonly string[] }) => {
    const command = e.argv[3] ?? ''
    const outputs: Record<string, string | undefined> = {
      'symbolic-ref': 'main\n',
      status: repo.status ?? dirty,
      'for-each-ref': repo.remotes,
      'rev-list': repo.ahead,
      diff: repo.shortstat,
    }
    repo.ran?.push(command)
    if (repo.hanging?.includes(command)) throw new Error(`git ${command} timed out`)
    const isFailing = repo.failing?.includes(command) ?? false
    return {
      value: {
        exitCode: isFailing ? 128 : 0,
        stdout: isFailing ? '' : (outputs[command] ?? ''),
        stderr: '',
        isStdoutTruncated: false,
        isStderrTruncated: false,
      },
    }
  }

type Reading = { percentUsed: number; resetsAt: string }

// The session the scenarios below start from: 38% context, both limits, a clean `main`, and the
// agents and 5-hour reading given.
function session(
  on: On,
  {
    agents = [],
    fiveHour = () => ({ percentUsed: 41, resetsAt: '2026-10-06T02:15:00Z' }),
    repo = {},
  }: { agents?: AgentInfo[]; fiveHour?: () => Reading; repo?: Repo } = {},
) {
  on('session.start', ($, e) => ({ cwd: e.cwd }))
  on('session.cwd', () => ({ value: '/work/app' }))
  on('session.surfaces', () => ({ value: ['terminal', 'desktop'] }))
  on('session.usage', () => ({
    value: {
      startedAt: START,
      context: { tokens: 76_000, window: 200_000, percent: 38 },
      rateLimits: [
        { kind: 'five_hour', ...fiveHour() },
        { kind: 'seven_day', percentUsed: 20, resetsAt: '2026-10-09T00:00:00Z' },
      ],
    },
  }))
  on('agent.list', () => ({ value: agents }))
  on('process.run', git('', repo))
  on('turn.start', ($, e) => ({ turnId: e.turnId }))
  on('turn.complete', () => ({ text: '' }))
}

const SURFACES = ['terminal', 'desktop'] as const

// What each surface, in turn, draws for a text matching the pattern.
async function found($: Engine, pattern: RegExp, bodyColumns = 140, isWorking = false) {
  const all = []
  for (const surface of SURFACES) {
    const line = await $.ui.mount({ ...band(bodyColumns, isWorking), surface })
    all.push(await line.find({ type: 'Text', text: pattern }))
    await line.unmount()
  }
  return all
}

// One drawing of the band: the text of each line, top to bottom, and every Text it holds.
async function drawing($: Engine, surface: (typeof SURFACES)[number], bodyColumns: number, isWorking = false) {
  const mounted = await $.ui.mount({ ...band(bodyColumns, isWorking), surface })
  const root = await mounted.drawn()
  const texts = (await mounted.findAll({ type: 'Text' })).map(t => t.text)
  await mounted.unmount()
  const textOf = (node: RenderNode): string =>
    typeof node === 'string' ? node : 'children' in node && Array.isArray(node.children) ? node.children.map(textOf).join('') : ''
  const rows = 'children' in root && Array.isArray(root.children) ? root.children.map(textOf) : []
  return { rows, texts }
}

async function rowsOf($: Engine, surface: (typeof SURFACES)[number], bodyColumns: number, isWorking = false) {
  return (await drawing($, surface, bodyColumns, isWorking)).rows
}

async function shows($: Engine, pattern: RegExp, bodyColumns = 140, isWorking = false) {
  return (await found($, pattern, bodyColumns, isWorking)).map(text => text !== undefined)
}

describe('register', () => {
  test('two lines: state above, what is happening below, details shed to fit', async ($, on) => {
    const clock = mock.clock(on, { now: START })
    let running: AgentInfo[] = []
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
      // Always two lines: the second is blank while nothing is happening.
      const rows = await rowsOf($, surface, 120)
      expect(rows).toHaveLength(2)
      expect(rows[1]).toBe(' ')

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
      // Working at 110 columns: the live segments take the second line, so the first keeps its details.
      const working = await $.ui.mount({ ...band(110, true), surface })
      expect(await working.find({ type: 'Text', text: /^working$/ })).toBeDefined()
      expect(await working.find({ type: 'Text', text: /^ #2$/ })).toBeDefined()
      expect(await working.find({ type: 'Text', text: /^Explore$/ })).toBeDefined()
      expect(await working.find({ type: 'Text', text: /^ 40s$/ })).toBeDefined()
      expect(await working.find({ type: 'Text', text: /^1\/2$/ })).toBeDefined()
      expect(await working.find({ type: 'Text', text: /Fix authentication bug/ })).toBeDefined()
      expect(await working.find({ type: 'Text', text: /^main$/ })).toBeDefined()
      expect(await working.find({ type: 'Text', text: /124K left/ })).toBeDefined()
      await working.unmount()
      const rows = await rowsOf($, surface, 110, true)
      expect(rows[0]).toContain('⎇ main')
      expect(rows[1]).toMatch(/^▸ working #2 · ◇ Explore 40s · ☐ 1\/2 Fix authentication bug$/)
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

  test('background work shows while it runs, from the main loop or an agent, until it ends', async ($, on) => {
    const clock = mock.clock(on, { now: START })
    session(on)
    on('classic.Stop', () => ({}))
    on('tool.call', ($, e) => ({
      result:
        e.tool === 'Bash' && e.run_in_background
          ? { backgroundTaskId: e.description ? 'b1' : 'b2' }
          : e.tool === 'Monitor'
            ? { taskId: 'm1' }
            : e.tool === 'TaskStop'
              ? { task_id: 'b2' }
              : {},
    }))

    await $.session.start({ surface: 'terminal', isInteractive: true, cwd: '/work/app' })
    await $.turn.start({ text: 'go', turnId: 't1' })
    await $.tool.call({ tool: 'Bash', command: 'codex review --base main', description: 'codex review', run_in_background: true })
    await $.turn.complete({ reason: 'answer', answer: 'ok', durationMs: 1, isAborted: false, turnId: 't1' })
    await clock.advance(6 * 60_000)

    expect(await shows($, /^⧗ $/)).toEqual([true, true])
    expect(await shows($, /^codex review$/)).toEqual([true, true])
    expect(await shows($, /^ 6m$/)).toEqual([true, true])
    // Short of room, the label gives way to the count.
    expect(await shows($, /^1 bg$/, 18)).toEqual([true, true])
    expect(await shows($, /codex review/, 18)).toEqual([false, false])

    // A Stop still listing it keeps it; a subagent's Stop is not the session's; an empty one ends it.
    const running = { id: 'b1', type: 'shell', status: 'running', description: 'codex review' }
    await $.classic.Stop({ stop_hook_active: false, background_tasks: [running] })
    await $.classic.Stop({ stop_hook_active: false, background_tasks: [], agent_id: 'a1' })
    expect(await shows($, /^codex review$/)).toEqual([true, true])
    await $.classic.Stop({ stop_hook_active: false, background_tasks: [] })
    expect(await shows($, /^⧗ $/)).toEqual([false, false])

    // An agent's background shell counts too, labeled by its command; TaskStop ends it at once,
    // also when it names the task otherwise than by id.
    const fromAgent = { tool: 'Bash' as const, command: 'npm test\nnpm run lint', run_in_background: true, agentId: 'a1' }
    await $.tool.call(fromAgent)
    await clock.advance(SECOND)
    expect(await shows($, /^npm test$/)).toEqual([true, true])
    // Recorded just before a Stop whose list predates it, it outlasts that Stop.
    await $.classic.Stop({ stop_hook_active: false, background_tasks: [] })
    expect(await shows($, /^npm test$/)).toEqual([true, true])
    await $.tool.call({ tool: 'TaskStop', task_id: 'tests' })
    expect(await shows($, /^⧗ $/)).toEqual([false, false])

    // Several at once, a monitor among them: how many, and the oldest's age.
    await $.tool.call({ tool: 'Monitor', description: 'watch deploy', timeout_ms: 60_000, command: 'tail -f deploy.log' })
    await clock.advance(2 * 60_000)
    await $.tool.call({ tool: 'Bash', command: 'codex review', description: 'codex review', run_in_background: true })
    expect(await shows($, /^2 bg$/)).toEqual([true, true])
    expect(await shows($, /^ 2m$/)).toEqual([true, true])
    expect(await shows($, /watch deploy|codex review/)).toEqual([false, false])
  })

  test('a workflow shows with its agents at work while it runs', async ($, on) => {
    const clock = mock.clock(on, { now: START })
    session(on, { agents: [{ id: 'sub', description: 'Find', type: 'Explore', status: 'running' }] })
    on('classic.Stop', () => ({}))
    const names = ['review-changes', 'audit']
    on('tool.call', ($, e) => {
      if (e.tool !== 'Workflow') return { result: {} }
      if (e.script?.endsWith('{')) return { result: { status: 'async_launched', taskId: 'w0', error: 'SyntaxError' } }
      const n = 3 - names.length
      return { result: { status: 'async_launched', taskId: `w${n}`, workflowName: names.shift() } }
    })
    const callFrom = async (agentId: string) => {
      const call = { tool: 'Read' as const, file_path: '/work/app/a.ts', agentId }
      await $.tool.call(call)
    }

    await $.session.start({ surface: 'terminal', isInteractive: true, cwd: '/work/app' })
    // Before any workflow, an unnamed loop (an engine fork) neither draws nor counts later.
    await callFrom('fork')
    await clock.advance(SECOND)
    expect(await shows($, /^⧉ $/)).toEqual([false, false])

    // A script that failed its syntax check never ran.
    await $.tool.call({ tool: 'Workflow', script: 'export const meta = {' })
    expect(await shows($, /^⧉ $/)).toEqual([false, false])

    await $.tool.call({ tool: 'Workflow', script: 'export const meta = {}' })
    for (const id of ['w-a', 'w-b', 'w-c', 'w-a', 'sub']) await callFrom(id)
    await clock.advance(45 * SECOND)
    expect(await shows($, /^⧉ $/)).toEqual([true, true])
    expect(await shows($, /^review-changes$/)).toEqual([true, true])
    expect(await shows($, /^ ×3$/)).toEqual([true, true])
    expect(await shows($, /^ 45s$/)).toEqual([true, true])

    // An agent that answered is no longer at work.
    await $.turn.complete({ reason: 'answer', answer: 'ok', durationMs: 1, isAborted: false, turnId: 'w-a1', agentId: 'w-a' })
    expect(await shows($, /^ ×2$/)).toEqual([true, true])

    // A second workflow: how many, still timed from the first.
    await $.tool.call({ tool: 'Workflow', script: 'export const meta = {}' })
    await clock.advance(15 * SECOND)
    expect(await shows($, /^2 workflows$/)).toEqual([true, true])
    expect(await shows($, /^ 1m$/)).toEqual([true, true])
    expect(await shows($, /^ ×2$/)).toEqual([true, true])

    // Once Stop lists it no longer, the workflow and its agents are gone.
    await $.classic.Stop({ stop_hook_active: false, background_tasks: [] })
    expect(await shows($, /^⧉ $/)).toEqual([false, false])
    await callFrom('late')
    await clock.advance(SECOND)
    expect(await shows($, /^⧉ $/)).toEqual([false, false])
  })

  test('a background shell ends with the synchronous subagent that started it', async ($, on) => {
    const clock = mock.clock(on, { now: START })
    session(on)
    on('tool.call', () => ({ result: { backgroundTaskId: 'b1', backgroundEndsWithFinalResponse: true } }))

    await $.session.start({ surface: 'terminal', isInteractive: true, cwd: '/work/app' })
    const fromAgent = { tool: 'Bash' as const, command: 'npm run dev', run_in_background: true, agentId: 'a1' }
    await $.tool.call(fromAgent)
    await clock.advance(SECOND)
    expect(await shows($, /^npm run dev$/)).toEqual([true, true])
    await $.turn.complete({ reason: 'answer', answer: 'ok', durationMs: 1, isAborted: false, turnId: 'a1t', agentId: 'a1' })
    expect(await shows($, /^⧗ $/)).toEqual([false, false])
  })

  test('background work started while Stop runs outlasts that Stop', async ($, on) => {
    const clock = mock.clock(on, { now: START })
    session(on)
    on('tool.call', () => ({ result: { backgroundTaskId: 'b1' } }))
    // An agent starts a shell while the hooks beneath Stop run, after its list was taken.
    on('classic.Stop', async () => {
      await clock.advance(SECOND)
      const fromAgent = { tool: 'Bash' as const, command: 'npm test', run_in_background: true, agentId: 'a1' }
      await $.tool.call(fromAgent)
      await clock.advance(SECOND)
      return {}
    })

    await $.session.start({ surface: 'terminal', isInteractive: true, cwd: '/work/app' })
    await $.classic.Stop({ stop_hook_active: false, background_tasks: [] })
    expect(await shows($, /^npm test$/)).toEqual([true, true])
  })

  test('git shows commits on no remote, and the lines changed since HEAD', async ($, on) => {
    const clock = mock.clock(on, { now: START })
    const repo: Repo = { remotes: 'abc123 commit\trefs/remotes/origin/main\n', ahead: '2\n' }
    session(on, { repo })
    on('tool.call', () => ({ result: {} }))
    const reread = async () => {
      await $.turn.start({ text: 'go', turnId: 't' })
      await $.turn.complete({ reason: 'answer', answer: 'ok', durationMs: 1, isAborted: false, turnId: 't' })
    }

    await $.session.start({ surface: 'terminal', isInteractive: true, cwd: '/work/app' })
    expect(await shows($, /^ ↑2$/)).toEqual([true, true])
    expect(await shows($, /[+−]\d/)).toEqual([false, false])

    // A call that may change files reads git again, without the call waiting for it.
    Object.assign(repo, { status: ' M a.ts\n', shortstat: ' 3 files changed, 120 insertions(+), 30 deletions(-)\n' })
    await $.tool.call({ tool: 'Write', file_path: '/work/app/a.ts', content: '' })
    await clock.advance(SECOND)
    expect(await shows($, /^ ±1$/)).toEqual([true, true])
    expect(await shows($, /^ \+120−30$/)).toEqual([true, true])
    // The line count is the first detail to go.
    expect(await shows($, /^ \+120−30$/, 70)).toEqual([false, false])
    expect(await shows($, /^ ↑2$/, 70)).toEqual([true, true])

    // Nothing unpushed, or no remote to push to: no arrow.
    repo.ahead = '0\n'
    await reread()
    expect(await shows($, /↑/)).toEqual([false, false])
    Object.assign(repo, { remotes: '', ahead: '5\n', ran: [] })
    await reread()
    expect(await shows($, /↑/)).toEqual([false, false])
    expect(repo.ran).not.toContain('rev-list')

    // A count that times out is left out; the rest of git still shows.
    Object.assign(repo, { remotes: 'abc123 commit\trefs/remotes/origin/main\n', ahead: '2\n', hanging: ['diff'] })
    await reread()
    expect(await shows($, /^ ↑2$/)).toEqual([true, true])
    expect(await shows($, /[+−]\d/)).toEqual([false, false])
    repo.hanging = []

    // A repository with no commit yet: both counts fail and only the branch is left.
    Object.assign(repo, { remotes: 'abc123 commit\trefs/remotes/origin/main\n', failing: ['rev-list', 'diff'] })
    await reread()
    expect(await shows($, /↑|[+−]\d/)).toEqual([false, false])
    expect(await shows($, /^main$/)).toEqual([true, true])
  })

  test('the failed calls of this turn show beside the running tool, in red', async ($, on) => {
    mock.clock(on, { now: START })
    session(on)
    on('tool.call', ($, e) =>
      e.tool === 'Bash' ? { result: 'exit 1', isError: true as const } : e.tool === 'Write' ? { deny: 'not allowed' } : { result: {} },
    )

    await $.session.start({ surface: 'terminal', isInteractive: true, cwd: '/work/app' })
    await $.turn.start({ text: 'go', turnId: 't1' })
    await $.tool.call({ tool: 'Bash', command: 'npm test' })
    await $.tool.call({ tool: 'Write', file_path: '/work/app/a.ts', content: '' })
    await $.tool.call({ tool: 'Read', file_path: '/work/app/a.ts' })
    expect((await found($, /^ ✗2$/, 140, true)).map(text => text?.props.color)).toEqual(['red', 'red'])

    await $.turn.complete({ reason: 'answer', answer: 'ok', durationMs: 1, isAborted: false, turnId: 't1' })
    await $.turn.start({ text: 'again', turnId: 't2' })
    expect(await shows($, /✗/, 140, true)).toEqual([false, false])
  })

  test('idle, the prompt cache shows in its last ten minutes, then shows cold', async ($, on) => {
    const clock = mock.clock(on, { now: START })
    session(on)
    const colorOf = async (pattern: RegExp) => (await found($, pattern)).map(text => text?.props.color)

    await $.session.start({ surface: 'terminal', isInteractive: true, cwd: '/work/app' })
    expect(await shows($, /cache/)).toEqual([false, false])
    await $.turn.start({ text: 'go', turnId: 't1' })
    await $.turn.complete({ reason: 'answer', answer: 'ok', durationMs: 1, isAborted: false, turnId: 't1' })

    // With time to spare there is nothing to show.
    await clock.advance(8 * 60_000)
    expect(await shows($, /cache/)).toEqual([false, false])
    await clock.advance(47 * 60_000)
    expect(await colorOf(/^cache 5m$/)).toEqual(['yellow', 'yellow'])
    expect(await shows($, /cache/, 140, true)).toEqual([false, false])
    await clock.advance(6 * 60_000)
    expect(await colorOf(/^cache cold$/)).toEqual(['red', 'red'])
  })

  test('idle, an API error that ended the last turn shows until the next turn', async ($, on) => {
    mock.clock(on, { now: START })
    session(on)
    on('classic.StopFailure', () => ({}))

    await $.session.start({ surface: 'terminal', isInteractive: true, cwd: '/work/app' })
    await $.turn.start({ text: 'go', turnId: 't1' })
    await $.classic.StopFailure({ error: 'overloaded' })
    await $.turn.complete({ reason: 'error', answer: '', durationMs: 1, isAborted: false, turnId: 't1' })
    expect((await found($, /^✗ overloaded$/)).map(text => text?.props.color)).toEqual(['red', 'red'])

    // A subagent's failure is not the session's.
    await $.classic.StopFailure({ error: 'rate_limit', agent_id: 'a1' })
    expect(await shows($, /^✗ overloaded$/)).toEqual([true, true])
    await $.classic.StopFailure({ error: 'rate_limit' })
    expect(await shows($, /^✗ rate limit$/)).toEqual([true, true])

    await $.turn.start({ text: 'again', turnId: 't2' })
    expect(await shows($, /^✗ /)).toEqual([false, false])
  })

  // 5-hour use climbs 40% → 60% over 20 minutes: at that pace the rest goes in 0:40.
  const climb = async ($: Engine, on: On, resetsAt: string) => {
    const clock = mock.clock(on, { now: START })
    let percentUsed = 40
    session(on, { fiveHour: () => ({ percentUsed, resetsAt }) })
    on('tool.call', () => ({ result: {} }))
    const reading = async (minutes: number, percent: number) => {
      await clock.advance(minutes * 60_000)
      percentUsed = percent
      await $.tool.call({ tool: 'Read', file_path: '/work/app/a.ts' })
    }

    await $.session.start({ surface: 'terminal', isInteractive: true, cwd: '/work/app' })
    // Five minutes in is too soon to tell a pace.
    await reading(5, 45)
    expect(await shows($, /▲/)).toEqual([false, false])
    await reading(15, 60)
    return reading
  }

  test('a limit warns, in red, when its pace runs it out before it resets', async ($, on) => {
    const reading = await climb($, on, '2026-10-06T02:20:00Z')
    expect((await found($, /^ ▲0:40$/)).map(text => text?.props.color)).toEqual(['red', 'red'])
    expect(await shows($, /^ ↻2:00$/)).toEqual([true, true])
    // Run out already: nothing left to warn of.
    await reading(5, 100)
    expect(await shows($, /▲/)).toEqual([false, false])
  })

  test('a limit stays quiet when it resets before that pace runs it out', async ($, on) => {
    await climb($, on, '2026-10-06T00:50:00Z')
    expect(await shows($, /▲/)).toEqual([false, false])
  })

  // Every signal on at once: a dirty, unpushed `main`, a 5-hour pace warning, an API error, a
  // workflow with an agent at work, a background shell, a subagent and an unfinished todo list.
  const everything = async ($: Engine, on: On) => {
    const clock = mock.clock(on, { now: START })
    let percentUsed = 40
    session(on, {
      agents: [{ id: 'sub', description: 'Find', type: 'Explore', status: 'running' }],
      fiveHour: () => ({ percentUsed, resetsAt: '2026-10-06T02:20:00Z' }),
      repo: {
        status: ' M a.ts\n M b.ts\n M c.ts\n',
        remotes: 'abc123 commit\trefs/remotes/origin/main\n',
        ahead: '2\n',
        shortstat: ' 3 files changed, 120 insertions(+), 30 deletions(-)\n',
      },
    })
    on('classic.StopFailure', () => ({}))
    on('tool.call', ($, e) => {
      if (e.tool === 'Bash' && e.run_in_background) return { result: { backgroundTaskId: 'b1' } }
      if (e.tool === 'Workflow') return { result: { status: 'async_launched', taskId: 'w1', workflowName: 'review-changes' } }
      if (e.tool === 'Read' && e.file_path === '/nowhere') return { result: 'no such file', isError: true as const }
      return { result: {} }
    })

    await $.session.start({ surface: 'terminal', isInteractive: true, cwd: '/work/app' })
    await $.turn.start({ text: 'go', turnId: 't1' })
    await $.tool.call({
      tool: 'TodoWrite',
      todos: [
        { content: 'Fix auth bug', status: 'in_progress', activeForm: 'Fixing' },
        { content: 'Add tests', status: 'pending', activeForm: 'Adding' },
      ],
    })
    await $.tool.call({ tool: 'Bash', command: 'codex review', description: 'codex review', run_in_background: true })
    await $.tool.call({ tool: 'Workflow', script: 'export const meta = {}' })
    const fromWorkflow = { tool: 'Read' as const, file_path: '/work/app/a.ts', agentId: 'w-a' }
    await $.tool.call(fromWorkflow)
    await clock.advance(20 * 60_000)
    percentUsed = 60
    await $.classic.StopFailure({ error: 'overloaded' })
    await $.turn.complete({ reason: 'error', answer: '', durationMs: 1, isAborted: false, turnId: 't1' })
    // Later readings, so the cache can reach its last minutes with the climb still under way.
    return async (minutes: number, percent: number) => {
      await clock.advance(minutes * 60_000)
      percentUsed = percent
      await $.tool.call({ tool: 'Read', file_path: '/work/app/a.ts' })
    }
  }

  // Narrows the line a column at a time. At every width it stays within the width and on one row;
  // until it has to be cut, `kept` all stay and `shed` go strictly in order: once one is gone, so
  // is every one before it. Every stage is seen, and at the background label's stage `1 bg` stands in.
  // Narrows the band a column at a time. At every width it draws exactly two lines, each within the
  // width. Until a line has to be cut, `kept` all stay, and each line's `shed` go strictly in order:
  // once one is gone, so is every one before it on that line. Every stage is seen on both lines, and
  // at the background label's stage `1 bg` stands in.
  const narrow = async ($: Engine, isWorking: boolean, kept: RegExp[], shed: [RegExp[], RegExp[]]) => {
    for (const surface of SURFACES) {
      const seen = [new Set<number>(), new Set<number>()]
      for (let bodyColumns = 200; bodyColumns >= 30; bodyColumns--) {
        const { rows, texts } = await drawing($, surface, bodyColumns, isWorking)
        expect(rows).toHaveLength(2)
        for (const row of rows) expect(row.length).toBeLessThanOrEqual(bodyColumns - 2)
        if (rows.some(row => row.endsWith('…'))) continue
        for (const pattern of kept) expect(texts.some(t => pattern.test(t))).toBe(true)
        shed.forEach((order, i) => {
          const present = order.map(pattern => texts.some(t => pattern.test(t)))
          const gone = present.indexOf(true) === -1 ? present.length : present.indexOf(true)
          expect(present.slice(gone).every(Boolean)).toBe(true)
          seen[i]?.add(gone)
        })
        if (!texts.includes('codex review') && texts.includes('⧗ ')) expect(texts).toContain('1 bg')
      }
      shed.forEach((order, i) => expect([...(seen[i] ?? [])].sort((a, b) => a - b)).toEqual([...order.keys(), order.length]))
    }
  }

  // The width sweeps draw the band some 700 times; a loaded machine needs more than the default 5 s.
  test('idle, every signal on: details shed in order, context, limits and the API error stay', { timeoutMs: 30_000 }, async ($, on) => {
    const reading = await everything($, on)
    await reading(31, 75)
    await reading(21, 90)
    expect(await shows($, /^cache 8m$/)).toEqual([true, true])
    expect(await shows($, /^ ▲0:14$/)).toEqual([true, true])
    const kept = [/^38%$/, /^5h $/, /^ ▲0:14$/, /^7d $/, /^✗ overloaded$/]
    const state = [/^ \+120−30$/, /^ ↻/, /^ 124K left$/, /^ ±3$/, /^cache /, /^main$/]
    await narrow($, false, kept, [state, [/^ Fix auth bug$/, /^codex review$/]])

    // Too narrow even for what is kept: the first line is cut at the width, ending in an ellipsis.
    for (const surface of SURFACES) {
      const [first] = await rowsOf($, surface, 36)
      expect(first?.length).toBeLessThanOrEqual(34)
      expect(first?.endsWith('…')).toBe(true)
    }
  })

  test('working, every signal on: details shed in order, context, limits and the failed calls stay', { timeoutMs: 30_000 }, async ($, on) => {
    await everything($, on)
    await $.turn.start({ text: 'again', turnId: 't2' })
    await $.tool.call({ tool: 'Read', file_path: '/nowhere' })
    expect(await shows($, /^ ✗1$/, 200, true)).toEqual([true, true])
    const kept = [/^38%$/, /^5h $/, /^ ▲0:40$/, /^7d $/, /^▸ $/, /^ ✗1$/]
    const state = [/^ \+120−30$/, /^ ↻/, /^ 124K left$/, /^ ±3$/, /^main$/]
    await narrow($, true, kept, [state, [/^ Fix auth bug$/, /^codex review$/]])
  })

  test('wide characters count as two columns, so a Korean label still fits its line', { timeoutMs: 30_000 }, async ($, on) => {
    mock.clock(on, { now: START })
    session(on)
    on('tool.call', () => ({ result: { backgroundTaskId: 'b1' } }))
    // Hangul takes two columns in a terminal; everything else drawn here takes one.
    const columns = (text: string) => [...text].reduce((n, ch) => n + (/[\u1100-\u115f\uac00-\ud7a3]/.test(ch) ? 2 : 1), 0)

    await $.session.start({ surface: 'terminal', isInteractive: true, cwd: '/work/app' })
    const description = '코덱스로 변경 사항을 리뷰하는 백그라운드 작업'
    await $.tool.call({ tool: 'Bash', command: 'codex review', description, run_in_background: true })

    const labelAt = async (bodyColumns: number, surface: (typeof SURFACES)[number]) => {
      const line = await $.ui.mount({ ...band(bodyColumns), surface })
      const label = (await line.findAll({ type: 'Text' })).map(t => t.text).find(t => t.startsWith('코덱스'))
      await line.unmount()
      return label ?? ''
    }

    for (const surface of SURFACES) {
      // With room the label shows whole; short of it, it gives up columns (counted two per Hangul
      // character) down to 24 before anything is shed.
      expect(await labelAt(140, surface)).toBe(description)
      const clipped = await labelAt(40, surface)
      expect(clipped.endsWith('…')).toBe(true)
      expect(columns(clipped)).toBeGreaterThanOrEqual(23)
      expect(columns(clipped)).toBeLessThan(columns(description))

      for (let bodyColumns = 140; bodyColumns >= 20; bodyColumns--) {
        for (const row of await rowsOf($, surface, bodyColumns)) expect(columns(row)).toBeLessThanOrEqual(bodyColumns - 2)
      }
    }

    const todo = 'Check the HUD stays on one line in a narrow terminal'
    await $.tool.call({ tool: 'TodoWrite', todos: [{ content: todo, status: 'in_progress', activeForm: 'Checking' }] })
    // A long todo shows whole while there is room for it.
    expect(await shows($, new RegExp(`^ ${todo}$`), 200)).toEqual([true, true])
  })

  test('in VS Code the line is pinned as the status line instead', async ($, on) => {
    const clock = mock.clock(on, { now: START })
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
      return { value: undefined }
    })

    on('turn.start', ($, e) => ({ turnId: e.turnId }))
    on('turn.complete', () => ({ text: '' }))
    on('tool.call', () => ({ result: {} }))

    await $.session.start({ surface: 'vscode', isInteractive: true, cwd: '/work/app' })

    expect(lines.at(-1)).toBe('◔ 38% 124K left · ◑ 5h 41% ↻2:15 · ⎇ main ✓')

    // Between the calls of a turn the line stays the working one: no idle-only cache segment.
    await $.turn.start({ text: 'go', turnId: 't1' })
    await $.turn.complete({ reason: 'answer', answer: 'ok', durationMs: 1, isAborted: false, turnId: 't1' })
    await clock.advance(55 * 60_000)
    expect(lines.at(-1)).toContain('cache 5m')
    await $.turn.start({ text: 'again', turnId: 't2' })
    await $.tool.call({ tool: 'Read', file_path: '/work/app/a.ts' })
    expect(lines.at(-1)).toBe('◔ 38% 124K left · ◑ 5h 41% ↻1:20 · ⎇ main ✓ · ▸ working #1')
  })
})
