// glance — two lines above the prompt, drawn the same in the terminal and the desktop app:
//
//   ◔ 38% 124K left · ◑ 5h 41% ▲1:40 ↻2:15 · ◔ 7d 20% ↻3d
//   ⎇ main ±3 ↑2 · ▸ Edit register.ts #6 ✗2 · ◇ Explore 45s · ⧗ codex review 6m · ☐ 2/5 Fix auth bug
//
// The first line is Claude's budget: the context and the limits, then, while idle, the last turn's
// API error and a cooling prompt cache. The second is the work: the repository first, so the line
// is seldom blank, then what is happening right now. Each line starts with what is always there, so
// it stays put while the rest comes and goes. There are always two lines, so the prompt never jumps.
// When a line is too wide, long texts give way first, then details (see SHED), then whole segments;
// what is never shed is cut at the edge.
//
// VS Code draws no band above the prompt, so there the two lines, joined and without color, are
// pinned as this plugin's status line instead.
import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type {
  GlanceActivity,
  GlanceAgent,
  GlanceBackground,
  GlanceCall,
  GlanceContext,
  GlanceGit,
  GlanceLimit,
  GlanceLoop,
  GlanceTodo,
} from '../types'

const context = atom({ plugin: 'glance', key: 'context' } as const, null)
// Tagged since the limits carry pace samples, so a reload over older code's value starts empty.
const limits = atom({ plugin: 'glance', key: 'limits' } as const, [], { shape: 'samples' })
// Tagged since git carries the unpushed and line counts, so a reload over older code's value starts empty.
const git = atom({ plugin: 'glance', key: 'git' } as const, null, { shape: 'ahead' })
const NO_ACTIVITY: GlanceActivity = { running: [], calls: 0, errors: 0, inTurn: false }
// Tagged since activity counts errors, so a reload over older code's value starts empty.
const activity = atom({ plugin: 'glance', key: 'activity' } as const, NO_ACTIVITY, { shape: 'errors' })
const agents = atom({ plugin: 'glance', key: 'agents' } as const, [])
const todos = atom({ plugin: 'glance', key: 'todos' } as const, [])
const background = atom({ plugin: 'glance', key: 'background' } as const, [])
const loops = atom({ plugin: 'glance', key: 'loops' } as const, [])
const lastAnswerAt = atom({ plugin: 'glance', key: 'lastAnswerAt' } as const, null)
const apiError = atom({ plugin: 'glance', key: 'apiError' } as const, null)
const now = atom({ plugin: 'glance', key: 'now' } as const, 0)

// Context is tight once 60% is gone and close to auto-compaction past 80%.
const CONTEXT_TIGHT = 60
const CONTEXT_CRITICAL = 80
const LIMIT_TIGHT = 70
const LIMIT_CRITICAL = 90
const SECOND = 1000
const MINUTE = 60 * SECOND
// Background work recorded this soon before a Stop reached glance may be newer than the list Stop
// carries (taken before the hooks above ran); it stays until the next Stop.
const STOP_GRACE = 5 * SECOND
// Running agents are re-read this often, so their elapsed time, and that of background work, keeps moving.
const AGENT_POLL = 5 * SECOND
// A limit's pace is read over the last half hour, from a sample at least ten minutes and one point
// behind. Samples are kept a minute apart, for an hour.
const PACE_SPAN = 30 * MINUTE
const PACE_MIN_GAP = 10 * MINUTE
const PACE_MIN_RISE = 1
const PACE_STEP = MINUTE
const PACE_KEEP = 60 * MINUTE
// The prompt cache is taken to live an hour past the last answer; its last ten minutes are tight.
const CACHE_TTL = 60 * MINUTE
const CACHE_TIGHT = 10 * MINUTE
const STATUS_COLUMNS = 140
const SEPARATOR = ' · '
const MUTATING = new Set(['Bash', 'Edit', 'Write', 'NotebookEdit'])
// Characters a terminal draws two columns wide: Hangul, CJK, fullwidth forms and emoji.
const WIDE = /[\u1100-\u115f\u2e80-\u303e\u3041-\u33ff\u3400-\u4dbf\u4e00-\u9fff\ua000-\ua4cf\ua960-\ua97f\uac00-\ud7a3\uf900-\ufaff\ufe30-\ufe4f\uff00-\uff60\uffe0-\uffe6\u{1f300}-\u{1f64f}\u{1f900}-\u{1f9ff}\u{20000}-\u{3fffd}]/u
// `git diff --shortstat`: "3 files changed, 120 insertions(+), 30 deletions(-)".
const INSERTIONS = /(\d+) insertion/
const DELETIONS = /(\d+) deletion/
const GAUGE = ['○', '◔', '◑', '◕', '●']

// The order details are shed in when the line is too wide: a part or segment tagged with a stage
// is left out from that stage on, and a part tagged `from` stands in for it from that stage on.
// Before each stage, a part tagged `floor` (a label, a todo, a command) gives up columns down to
// that many, so it shows whole while there is room.
// Context, the limits, the running tool and an API error are never shed.
const SHED = { diffStat: 1, resets: 2, left: 3, changes: 4, todoText: 5, bgText: 6, cache: 7, git: 8 } as const
const LAST_STAGE = 8

type Part = { text: string; color?: string; dim?: boolean; shed?: number; from?: number; floor?: number }
type Segment = { key: string; parts: Part[]; shed?: number; keep?: boolean }
type Snapshot = {
  ctx: GlanceContext
  windows: GlanceLimit[]
  repo: GlanceGit | null
  act: GlanceActivity
  running: GlanceAgent[]
  list: GlanceTodo[]
  tasks: GlanceBackground[]
  crew: number
  answeredAt: number | null
  failure: string | null
  at: number
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    const result = await next(e)
    await Promise.all([readUsage($), readGit($), readAgents($)])
    $.clock.every(MINUTE, () => {
      void stamp($)
    })
    $.clock.every(AGENT_POLL, () => {
      void Promise.all([readAgents($), read($, background)])
        .then(([isRunning, tasks]) => (isRunning || tasks.length > 0 ? stamp($) : undefined))
        .catch(() => undefined)
    })
    return result
  })

  on('turn.start', async ($, e, next) => {
    await Promise.all([update($, activity, () => ({ ...NO_ACTIVITY, inTurn: true })), update($, apiError, () => null)])
      .then(() => publishStatus($))
      .catch(() => undefined)
    return next(e)
  })

  on('turn.complete', async ($, e, next) => {
    const result = await next(e)
    if (!e.agentId) {
      await update($, activity, () => NO_ACTIVITY)
      const at = await $.clock.now()
      await update($, lastAnswerAt, () => at)
      await Promise.all([readUsage($), readGit($), readAgents($)])
    } else {
      const done = e.agentId
      await update($, loops, list => (list.some(l => l.id === done) ? list.filter(l => l.id !== done) : list))
        .then(() => endTasks($, t => t.owner === done))
        .then(() => publishStatus($))
        .catch(() => undefined)
    }
    return result
  })

  on('tool.call', async ($, e, next) => {
    const input = e as unknown as Record<string, unknown>
    // A subagent's or a workflow's call is only watched: for the workflow agent it may come from,
    // and, once answered, for background work it started. Nothing holds the answer back.
    if (e.agentId) {
      void judgeLoop($, e.agentId).catch(() => undefined)
      const answer = next(e)
      const agentId = e.agentId
      void answer
        .then(result => (isAnswered(result) ? trackBackground($, e.tool, input, result, agentId) : undefined))
        .catch(() => undefined)
      return answer
    }
    // Nothing is awaited before the tool runs, and the HUD's own failures never reach the call.
    const started = begin($, e.tool, e.tool_use_id, input)
    let result: Awaited<ReturnType<typeof next>> | undefined
    try {
      result = await next(e)
      return result
    } finally {
      await started.then(call => end($, call, e.tool, input, result)).catch(() => undefined)
    }
  })

  // The main loop's Stop lists the background work still in flight; anything else has ended.
  // Work recorded since just before the list was taken, or while the hooks beneath run, is newer
  // than it and stays.
  on('classic.Stop', async ($, e, next) => {
    const asOf = $.clock.now().catch(() => Infinity)
    const result = await next(e)
    const inFlight = e.background_tasks
    if (!e.agent_id && inFlight) {
      const ids = new Set(inFlight.map(t => t.id))
      await asOf
        .then(taken => endTasks($, t => t.since <= taken - STOP_GRACE && !ids.has(t.id)))
        .then(() => publishStatus($))
        .catch(() => undefined)
    }
    return result
  })

  // The main loop's turn ended on an API error: which kind, until the next turn starts.
  on('classic.StopFailure', async ($, e, next) => {
    const result = await next(e)
    if (!e.agent_id) {
      await update($, apiError, () => e.error)
        .then(() => publishStatus($))
        .catch(() => undefined)
    }
    return result
  })

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    const snap = await snapshot($)
    if (e.props.hasSurvey || snap === null) return next(e)

    const columns = e.props.bodyColumns - 2
    const { Box, Text } = $.ui.resolve(e)
    // A line with nothing on it is drawn blank, so the band keeps its height.
    const row = (key: string, segments: Segment[]) => {
      const texts = fit(segments, columns).flatMap((segment, i) => {
        const parts = segment.parts.map(p => Text({ color: p.color, dimColor: p.dim, children: p.text }))
        return i === 0 ? parts : [Text({ dimColor: true, children: SEPARATOR }), ...parts]
      })
      return Box({ key, flexDirection: 'row', children: texts.length > 0 ? texts : [Text({ children: ' ' })] })
    }
    return Box({
      flexDirection: 'column',
      paddingX: 1,
      children: [row('state', stateLine(snap, e.props.isWorking)), row('live', liveLine(snap, e.props.isWorking))],
    })
  })
}

async function snapshot($: EngineInterface): Promise<Snapshot | null> {
  const [ctx, windows, repo, act, running, list, tasks, judged, answeredAt, failure, at] = await Promise.all([
    read($, context),
    read($, limits),
    read($, git),
    read($, activity),
    read($, agents),
    read($, todos),
    read($, background),
    read($, loops),
    read($, lastAnswerAt),
    read($, apiError),
    read($, now),
  ])
  const crew = judged.filter(l => l.isWorkflow).length
  return ctx === null ? null : { ctx, windows, repo, act, running, list, tasks, crew, answeredAt, failure, at }
}

async function begin($: EngineInterface, tool: string, id: string | undefined, input: Record<string, unknown>) {
  const call: GlanceCall = {
    id: id ?? `${tool}-${Math.random().toString(36).slice(2)}`,
    tool: displayTool(tool),
    detail: detailOf(tool, input),
  }
  await update($, activity, a => ({ ...a, running: [...a.running, call], calls: a.calls + 1 }))
  await publishStatus($)
  return call
}

async function end($: EngineInterface, call: GlanceCall, tool: string, input: Record<string, unknown>, result: unknown) {
  // An error or a deny counts; a call that threw before answering left no result to count.
  const isFailed = typeof result === 'object' && result !== null && !isAnswered(result)
  await update($, activity, a => ({
    ...a,
    running: a.running.filter(r => r.id !== call.id),
    errors: a.errors + (isFailed ? 1 : 0),
  }))
  if (isAnswered(result)) {
    await trackTodos($, tool, input, result)
    await trackBackground($, tool, input, result)
  }
  if (tool === 'Agent') await readAgents($)
  await readUsage($)
  // Not awaited: git reads several commands, and the call's answer does not wait on them.
  if (MUTATING.has(tool)) void readGit($).catch(() => undefined)
}

function isAnswered(result: unknown): result is { result?: unknown } {
  if (typeof result !== 'object' || result === null) return false
  const r = result as { deny?: unknown; isError?: unknown }
  return r.deny === undefined && r.isError !== true
}

// TodoWrite replaces the list; TaskCreate and TaskUpdate edit it one task at a time.
async function trackTodos($: EngineInterface, tool: string, input: Record<string, unknown>, answered: { result?: unknown }) {
  const status = (value: unknown): GlanceTodo['status'] | null =>
    value === 'pending' || value === 'in_progress' || value === 'completed' ? value : null

  if (tool === 'TodoWrite' && Array.isArray(input.todos)) {
    const list = (input.todos as Record<string, unknown>[]).map(
      (t): GlanceTodo => ({ content: text(t.content), status: status(t.status) ?? 'pending' }),
    )
    await update($, todos, () => list)
  } else if (tool === 'TaskCreate') {
    const id = text((answered.result as { task?: { id?: unknown } } | undefined)?.task?.id)
    const created: GlanceTodo = { id, content: text(input.subject) || text(input.description), status: 'pending' }
    if (id) await update($, todos, list => [...list, created])
  } else if (tool === 'TaskUpdate') {
    const id = text(input.taskId)
    const next = status(input.status)
    const subject = text(input.subject)
    await update($, todos, list =>
      input.status === 'deleted'
        ? list.filter(t => t.id !== id)
        : list.map(t => (t.id === id ? { ...t, content: subject || t.content, status: next ?? t.status } : t)),
    )
  }
}

// Bash, Monitor and Workflow start background work; TaskStop ends it. Stop drops the rest once it has ended.
async function trackBackground(
  $: EngineInterface,
  tool: string,
  input: Record<string, unknown>,
  answered: { result?: unknown },
  agentId?: string,
) {
  const output = (answered.result ?? {}) as Record<string, unknown>
  const owner = agentId && output.backgroundEndsWithFinalResponse === true ? agentId : undefined
  const start = async (id: string, type: GlanceBackground['type'], label: string) => {
    const since = await $.clock.now()
    await update($, background, tasks =>
      tasks.some(t => t.id === id) ? tasks : [...tasks, { id, type, label: label || undefined, since, owner }],
    )
  }

  if (tool === 'Bash' && text(output.backgroundTaskId)) {
    await start(text(output.backgroundTaskId), 'shell', text(input.description) || firstLine(input.command))
  } else if (tool === 'Monitor' && text(output.taskId)) {
    await start(text(output.taskId), 'monitor', text(input.description))
  } else if (tool === 'Workflow' && text(output.taskId) && !text(output.error)) {
    await start(text(output.taskId), 'workflow', text(output.workflowName))
  } else if (tool === 'TaskStop') {
    // The answer names the task stopped, also when the call named it otherwise.
    const id = text(output.task_id) || text(input.task_id) || text(input.shell_id)
    await endTasks($, t => t.id === id)
  } else {
    return
  }
  await publishStatus($)
}

// Drops the work that ended; with no workflow left in flight, no workflow agent is either.
async function endTasks($: EngineInterface, isOver: (task: GlanceBackground) => boolean) {
  const left = await update($, background, tasks => (tasks.some(isOver) ? tasks.filter(t => !isOver(t)) : tasks))
  if (!left.some(t => t.type === 'workflow')) await update($, loops, list => (list.length > 0 ? [] : list))
}

// A workflow's agents are the loops `$.agent.list()` does not name. The engine's own forks are not
// named either, so loops are judged only while a workflow is in flight, each once: a named one is
// remembered as not the workflow's, so its later calls skip the list.
async function judgeLoop($: EngineInterface, agentId: string) {
  if ((await read($, loops)).some(l => l.id === agentId)) return
  if (!(await read($, background)).some(t => t.type === 'workflow')) return
  const judged: GlanceLoop = { id: agentId, isWorkflow: !(await $.agent.list()).some(a => a.id === agentId) }
  // The workflow may have ended while the list was read; its agents went with it.
  if (!(await read($, background)).some(t => t.type === 'workflow')) return
  await update($, loops, list => (list.some(l => l.id === agentId) ? list : [...list, judged]))
  if (judged.isWorkflow) await publishStatus($)
}

async function stamp($: EngineInterface) {
  const at = await $.clock.now()
  await update($, now, () => at)
  await publishStatus($)
}

// Returns whether any agent is still running, so the poll knows to move the clock.
async function readAgents($: EngineInterface) {
  const listed = (await $.agent.list()).filter(a => a.status === 'running')
  const at = await $.clock.now()
  const previous = await read($, agents)
  const since = new Map(previous.map(a => [a.id, a.since]))
  const next = listed.map((a): GlanceAgent => ({ id: a.id, type: a.type, since: since.get(a.id) ?? at }))
  const isSame = next.length === previous.length && next.every((a, i) => a.id === previous[i]?.id)
  if (!isSame) await update($, agents, () => next)
  return next.length > 0
}

// The VS Code fallback: a status line carries text only, so the segments go out uncolored.
async function publishStatus($: EngineInterface) {
  if (!(await $.session.surfaces()).includes('vscode')) return
  const snap = await snapshot($)
  if (snap === null) return
  const isWorking = snap.act.inTurn || snap.act.running.length > 0
  $.ui.status(
    fit([...stateLine(snap, isWorking), ...liveLine(snap, isWorking)], STATUS_COLUMNS)
      .map(segment => segment.parts.map(p => p.text).join(''))
      .join(SEPARATOR),
  )
}

// Claude's budget; while idle, what went wrong with the last turn or is about to.
function stateLine(snap: Snapshot, isWorking: boolean) {
  return [
    contextSegment(snap.ctx),
    ...snap.windows.map(w => limitSegment(w, snap.at)),
    isWorking ? null : apiErrorSegment(snap.failure),
    isWorking ? null : cacheSegment(snap.answeredAt, snap.at),
  ].filter((s): s is Segment => Boolean(s))
}

// The work: the repository, then what is happening right now.
function liveLine(snap: Snapshot, isWorking: boolean) {
  return [
    snap.repo && gitSegment(snap.repo),
    isWorking ? activitySegment(snap.act) : null,
    agentsSegment(snap.running, snap.at),
    workflowSegment(snap.tasks, snap.crew, snap.at),
    backgroundSegment(snap.tasks, snap.at),
    todosSegment(snap.list),
  ].filter((s): s is Segment => Boolean(s))
}

async function readUsage($: EngineInterface) {
  // Taken first: a reading is never newer than this.
  const at = await $.clock.now()
  const usage = await $.session.usage()
  const { window } = usage.context
  const used = usage.context.tokens ?? 0
  const percent = usage.context.percent ?? (window > 0 ? Math.round((used / window) * 100) : 0)
  const nextContext: GlanceContext = { percent, left: Math.max(0, window - used) }

  await update($, context, () => nextContext)
  await update($, limits, previous =>
    (['five_hour', 'seven_day'] as const).flatMap((kind): GlanceLimit[] => {
      const r = usage.rateLimits.find(l => l.kind === kind)
      if (!r) return []
      const name = kind === 'five_hour' ? '5h' : '7d'
      const before = previous.find(p => p.window === name)
      // A slower concurrent read landing after a newer one is stale; it changes nothing.
      if (before && before.readAt > at) return [before]
      const samples = sampled(before, r.percentUsed, r.resetsAt, at)
      return [{ window: name, percent: r.percentUsed, resetsAt: r.resetsAt, readAt: at, samples }]
    }),
  )
  await stamp($)
}

// The window's samples with this reading added. A reset or a drop in the figure starts them over.
function sampled(before: GlanceLimit | undefined, percent: number, resetsAt: string | undefined, at: number) {
  const last = before?.samples.at(-1)
  const isSameWindow = before?.resetsAt === resetsAt && (!last || last.percent <= percent)
  const kept = isSameWindow && before ? before.samples.filter(s => at - s.at <= PACE_KEEP) : []
  const latest = kept.at(-1)
  return latest && at - latest.at < PACE_STEP ? kept : [...kept, { at, percent }]
}

// How long the window lasts at the pace of the last half hour, told only when it runs out before
// it resets.
function exhaustIn(lim: GlanceLimit, at: number) {
  if (lim.percent >= 100 || !lim.resetsAt) return ''
  const from = lim.samples.find(s => at - s.at <= PACE_SPAN)
  if (!from || at - from.at < PACE_MIN_GAP || lim.percent - from.percent < PACE_MIN_RISE) return ''
  const left = ((100 - lim.percent) * (at - from.at)) / (lim.percent - from.percent)
  return at + left < Date.parse(lim.resetsAt) ? span(left) : ''
}

async function readGit($: EngineInterface) {
  // Taken first: reads run side by side, and one that started earlier must not overwrite a later one.
  const at = await $.clock.now()
  const cwd = await $.session.cwd()
  const run = (...args: string[]) => $.process.run(['git', '-C', cwd, ...args], { timeoutMs: 2000 })
  const head = await run('symbolic-ref', '--short', '-q', 'HEAD')
  const branch = head.exitCode === 0 ? head.stdout.trim() : (await run('rev-parse', '--short', 'HEAD')).stdout.trim()
  if (!branch) {
    await update($, git, () => null)
    return
  }
  // A detail whose command fails (no HEAD yet) or times out is left out; the rest still shows.
  const detail = (...args: string[]) => run(...args).then(r => (r.exitCode === 0 ? r.stdout : ''), () => '')
  const [status, remotes, diff] = await Promise.all([
    run('status', '--porcelain'),
    detail('for-each-ref', '--count=1', 'refs/remotes'),
    detail('diff', '--shortstat', 'HEAD'),
  ])
  const changes = status.exitCode === 0 ? status.stdout.split('\n').filter(Boolean).length : 0
  // Without a remote every commit is unpushed, which says nothing, so it is not counted.
  const unpushed = remotes.trim() ? await detail('rev-list', '--count', 'HEAD', '--not', '--remotes') : ''
  const ahead = Number.parseInt(unpushed, 10) || 0
  const lines = (pattern: RegExp) => Number(pattern.exec(diff)?.[1] ?? 0)
  const fresh: GlanceGit = { branch, changes, ahead, added: lines(INSERTIONS), removed: lines(DELETIONS), readAt: at }
  await update($, git, previous => (previous && previous.readAt > at ? previous : fresh))
  await publishStatus($)
}

function gauge(percent: number) {
  return GAUGE[Math.min(GAUGE.length - 1, Math.floor(percent / 20))] ?? '●'
}

function contextSegment(ctx: GlanceContext): Segment {
  const color = ctx.percent >= CONTEXT_CRITICAL ? 'red' : ctx.percent >= CONTEXT_TIGHT ? 'yellow' : 'green'
  return {
    key: 'context',
    parts: [
      { text: `${gauge(ctx.percent)} `, color },
      { text: `${ctx.percent}%`, color: ctx.percent >= CONTEXT_TIGHT ? color : undefined },
      { text: ` ${compact(ctx.left)} left`, dim: true, shed: SHED.left },
    ],
  }
}

function limitSegment(lim: GlanceLimit, at: number): Segment {
  const color = lim.percent >= LIMIT_CRITICAL ? 'red' : lim.percent >= LIMIT_TIGHT ? 'yellow' : 'blue'
  const reset = until(lim.resetsAt, at)
  const out = exhaustIn(lim, at)
  return {
    key: `limit:${lim.window}`,
    keep: true,
    parts: [
      { text: `${gauge(lim.percent)} `, color },
      { text: `${lim.window} `, dim: true },
      { text: `${Math.round(lim.percent)}%`, color: lim.percent >= LIMIT_TIGHT ? color : undefined },
      ...(out ? [{ text: ` ▲${out}`, color: 'red' }] : []),
      ...(reset ? [{ text: ` ↻${reset}`, dim: true, shed: SHED.resets }] : []),
    ],
  }
}

function gitSegment(repo: GlanceGit): Segment {
  return {
    key: 'git',
    shed: SHED.git,
   
    parts: [
      { text: '⎇ ', color: 'magenta' },
      { text: repo.branch },
      { text: repo.changes > 0 ? ` ±${repo.changes}` : ' ✓', dim: true, shed: SHED.changes },
      ...(repo.ahead > 0 ? [{ text: ` ↑${repo.ahead}` }] : []),
      ...(repo.added > 0 || repo.removed > 0
        ? [{ text: ` +${repo.added}−${repo.removed}`, dim: true, shed: SHED.diffStat }]
        : []),
    ],
  }
}

// While idle after a turn the API ended: the error's kind, never shed.
function apiErrorSegment(failure: string | null): Segment | null {
  if (failure === null) return null
  return { key: 'apiError', keep: true, parts: [{ text: `✗ ${failure.replaceAll('_', ' ')}`, color: 'red' }] }
}

// While idle, once the prompt cache is about to go: its last minutes in yellow, then cold in red.
// With time to spare there is nothing to act on, so nothing shows.
function cacheSegment(answeredAt: number | null, at: number): Segment | null {
  if (answeredAt === null) return null
  const left = answeredAt + CACHE_TTL - at
  if (left >= CACHE_TIGHT) return null
  const part: Part =
    left <= 0 ? { text: 'cache cold', color: 'red' } : { text: `cache ${Math.ceil(left / MINUTE)}m`, color: 'yellow' }
  return { key: 'cache', shed: SHED.cache, parts: [part] }
}

function activitySegment(act: GlanceActivity): Segment {
  const current = act.running[act.running.length - 1]
  // The call count, then how many of them failed, when any did.
  const count = [{ text: ` #${act.calls}`, dim: true }, ...(act.errors > 0 ? [{ text: ` ✗${act.errors}`, color: 'red' }] : [])]
  if (!current) return { key: 'activity', keep: true, parts: [{ text: '▸ ', color: 'cyan' }, { text: 'working', dim: true }, ...count] }
  return {
    key: 'activity',
    keep: true,
    parts: [
      { text: '▸ ', color: 'cyan' },
      { text: current.tool },
      ...(current.detail ? [{ text: ` ${current.detail}`, dim: true, floor: 29 }] : []),
      ...count,
    ],
  }
}

// One line for any number of agents: who, when it is one; how many otherwise; and the oldest's age.
function agentsSegment(running: GlanceAgent[], at: number): Segment | null {
  if (running.length === 0) return null
  const oldest = Math.min(...running.map(a => a.since))
  const who = running.length === 1 ? (running[0]?.type ?? 'agent') : `${running.length} agents`
  return {
    key: 'agents',
    parts: [
      { text: '◇ ', color: 'magenta' },
      { text: who },
      { text: ` ${age(at - oldest)}`, dim: true },
    ],
  }
}

// Running workflows: which, when it is one; how many otherwise; their agents at work, when any have
// been seen; and the age of the first.
function workflowSegment(tasks: GlanceBackground[], crew: number, at: number): Segment | null {
  const flows = tasks.filter(t => t.type === 'workflow')
  if (flows.length === 0) return null
  const first = Math.min(...flows.map(t => t.since))
  const which: Part =
    flows.length === 1 ? { text: flows[0]?.label || 'workflow', floor: 24 } : { text: `${flows.length} workflows` }
  return {
    key: 'workflow',
    parts: [
      { text: '⧉ ', color: 'magenta' },
      which,
      ...(crew > 0 ? [{ text: ` ×${crew}` }] : []),
      { text: ` ${age(at - first)}`, dim: true },
    ],
  }
}

// Background shells and monitors: what, when it is one; how many otherwise; and the oldest's age.
// Short of room, the one's label gives way to the count.
function backgroundSegment(tasks: GlanceBackground[], at: number): Segment | null {
  const shown = tasks.filter(t => t.type !== 'workflow')
  if (shown.length === 0) return null
  const oldest = Math.min(...shown.map(t => t.since))
  const count = `${shown.length} bg`
  const label = shown.length === 1 ? shown[0]?.label : undefined
  return {
    key: 'background',
    parts: [
      { text: '⧗ ', color: 'blue' },
      ...(label ? [{ text: label, shed: SHED.bgText, floor: 24 }, { text: count, from: SHED.bgText }] : [{ text: count }]),
      { text: ` ${age(at - oldest)}`, dim: true },
    ],
  }
}

// Shown only while something is left to do; a finished list disappears.
function todosSegment(list: GlanceTodo[]): Segment | null {
  const done = list.filter(t => t.status === 'completed').length
  if (list.length === 0 || done === list.length) return null
  const active = list.find(t => t.status === 'in_progress')
  return {
    key: 'todos',
   
    parts: [
      { text: '☐ ', color: 'yellow' },
      { text: `${done}/${list.length}`, dim: true },
      ...(active?.content ? [{ text: ` ${active.content}`, shed: SHED.todoText, floor: 33 }] : []),
    ],
  }
}

// Sheds details stage by stage until the line fits; if it still does not, drops whole segments
// from the right, sparing the ones marked keep. The first segment always stays, and should what
// is kept still not fit, the line is cut at the width and ends in an ellipsis.
function fit(segments: Segment[], columns: number) {
  const width = (line: Segment[]) =>
    line.reduce((n, s, i) => n + (i > 0 ? cells(SEPARATOR) : 0) + s.parts.reduce((m, p) => m + cells(p.text), 0), 0)
  const at = (stage: number) =>
    segments
      .filter(s => s.shed === undefined || s.shed > stage)
      .map(s => ({
        ...s,
        parts: s.parts.filter(p => (p.shed === undefined || p.shed > stage) && (p.from === undefined || p.from <= stage)),
      }))

  // Takes `over` columns from the floored parts, rightmost first, each no lower than its floor.
  const squeeze = (line: Segment[], over: number) =>
    line
      .slice()
      .reverse()
      .map(s => ({
        ...s,
        parts: s.parts
          .slice()
          .reverse()
          .map(p => {
            if (p.floor === undefined || over <= 0) return p
            const room = Math.max(p.floor, cells(p.text) - over)
            if (room >= cells(p.text)) return p
            const clipped = clip(p.text, room) ?? p.text
            over -= cells(p.text) - cells(clipped)
            return { ...p, text: clipped }
          })
          .reverse(),
      }))
      .reverse()

  for (let stage = 0; stage <= LAST_STAGE; stage++) {
    const line = squeeze(at(stage), width(at(stage)) - columns)
    if (width(line) <= columns) return line
  }
  const line = squeeze(at(LAST_STAGE), Infinity)
  for (let i = line.length - 1; i > 0 && width(line) > columns; i--) {
    if (!line[i]?.keep) line.splice(i, 1)
  }
  return width(line) > columns ? cut(line, columns) : line
}

// The line's first `columns - 1` columns, then `…`. A segment starts only where its separator and
// at least one column of it fit; a wide character that would straddle the edge is left out.
function cut(line: Segment[], columns: number) {
  let room = columns - 1
  const kept: Segment[] = []
  for (const [i, segment] of line.entries()) {
    const gap = i > 0 ? cells(SEPARATOR) : 0
    if (room <= gap) break
    room -= gap
    const parts: Part[] = []
    let isFull = false
    for (const p of segment.parts) {
      const fitted = head(p.text, room)
      if (fitted) parts.push({ ...p, text: fitted })
      room -= cells(fitted)
      if (fitted !== p.text) {
        isFull = true
        break
      }
    }
    if (parts.length > 0) kept.push({ ...segment, parts })
    if (isFull) break
  }
  const last = kept.at(-1)?.parts.at(-1)
  if (last) last.text += '…'
  return kept
}

function displayTool(tool: string) {
  const mcp = /^mcp__(.+?)__(.+)$/.exec(tool)
  return mcp ? (mcp[2] ?? tool) : tool
}

function detailOf(tool: string, input: Record<string, unknown>) {
  switch (tool) {
    case 'Read':
    case 'Edit':
    case 'Write':
    case 'NotebookEdit':
      return text(input.file_path).split('/').pop() || undefined
    case 'Grep':
    case 'Glob':
      return text(input.pattern) || undefined
    case 'Bash':
      return firstLine(input.command) || undefined
    case 'Agent':
      return text(input.subagent_type) || undefined
    case 'Skill':
      return text(input.skill) || undefined
  }
  return undefined
}

function text(value: unknown) {
  return typeof value === 'string' ? value : ''
}

function firstLine(value: unknown) {
  return text(value).trim().split('\n')[0] ?? ''
}

// At most `max` columns, ending in `…` when cut.
function clip(value: string, max: number) {
  if (!value) return undefined
  return cells(value) > max ? `${head(value, max - 1)}…` : value
}

// The columns the text takes in a terminal.
function cells(value: string) {
  let n = 0
  for (const ch of value) n += WIDE.test(ch) ? 2 : 1
  return n
}

// The longest start of the text that fits in `max` columns.
function head(value: string, max: number) {
  let out = ''
  for (const ch of value) {
    if (cells(out + ch) > max) break
    out += ch
  }
  return out
}

function compact(n: number) {
  return new Intl.NumberFormat('en', { notation: 'compact', maximumFractionDigits: n >= 1_000_000 ? 1 : 0 }).format(n)
}

// Seconds under a minute, minutes under an hour, then h:mm.
function age(ms: number) {
  const seconds = Math.max(0, Math.floor(ms / SECOND))
  if (seconds < 60) return `${seconds}s`
  const minutes = Math.floor(seconds / 60)
  if (minutes < 60) return `${minutes}m`
  return `${Math.floor(minutes / 60)}:${String(minutes % 60).padStart(2, '0')}`
}

function until(iso: string | undefined, at: number) {
  return iso ? span(Date.parse(iso) - at) : ''
}

// h:mm under a day, whole days beyond it.
function span(ms: number) {
  const minutes = Math.ceil(ms / MINUTE)
  if (!(minutes > 0)) return ''
  if (minutes >= 24 * 60) return `${Math.round(minutes / (24 * 60))}d`
  return `${Math.floor(minutes / 60)}:${String(minutes % 60).padStart(2, '0')}`
}
