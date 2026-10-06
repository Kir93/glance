// glance — two lines above the prompt, drawn the same in the terminal and the desktop app:
//
//   ◔ 38%  124K left  ·  ◑ 5h 41%  ↻2:15  ·  ○ 7d 20%  ↻3d  ·  ⎇ main ±3
//   ▸ Edit register.ts  #6  ·  ◇ 2 agents 3m  ·  ☐ 2/5 Fix auth bug
//
// The first line is state that is always true; the second is what is happening. Both lines
// always draw, so the prompt never jumps when a turn starts or ends. Within a line, segments
// are kept left to right and the rightmost go first when the band is narrow.
//
// VS Code draws no band above the prompt, so there both lines, joined and without color,
// are pinned as this plugin's status line instead.
import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type {
  GlanceActivity,
  GlanceAgent,
  GlanceCall,
  GlanceContext,
  GlanceGit,
  GlanceLimit,
  GlanceTodo,
} from '../types'

const context = atom({ plugin: 'glance', key: 'context' } as const, null)
const limits = atom({ plugin: 'glance', key: 'limits' } as const, [])
const git = atom({ plugin: 'glance', key: 'git' } as const, null)
const activity = atom({ plugin: 'glance', key: 'activity' } as const, { running: [], calls: 0, lastTurnCalls: 0 })
const agents = atom({ plugin: 'glance', key: 'agents' } as const, [])
const todos = atom({ plugin: 'glance', key: 'todos' } as const, [])
const now = atom({ plugin: 'glance', key: 'now' } as const, 0)

// Context is tight once 60% is gone and close to auto-compaction past 80%.
const CONTEXT_TIGHT = 60
const CONTEXT_CRITICAL = 80
const LIMIT_TIGHT = 70
const LIMIT_CRITICAL = 90
const SECOND = 1000
const MINUTE = 60 * SECOND
// Running agents are re-read this often, so their elapsed time keeps moving.
const AGENT_POLL = 5 * SECOND
const STATUS_COLUMNS = 140
const SEPARATOR = '  ·  '
const MUTATING = new Set(['Bash', 'Edit', 'Write', 'NotebookEdit'])
const GAUGE = ['○', '◔', '◑', '◕', '●']

type Part = { text: string; color?: string; dim?: boolean }
type Segment = { key: string; parts: Part[] }
type Snapshot = {
  ctx: GlanceContext
  windows: GlanceLimit[]
  repo: GlanceGit | null
  act: GlanceActivity
  running: GlanceAgent[]
  list: GlanceTodo[]
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
      void readAgents($).then(isRunning => (isRunning ? stamp($) : undefined))
    })
    return result
  })

  on('turn.start', async ($, e, next) => {
    await update($, activity, a => ({ ...a, running: [], calls: 0 }))
      .then(() => publishStatus($))
      .catch(() => undefined)
    return next(e)
  })

  on('turn.complete', async ($, e, next) => {
    const result = await next(e)
    if (!e.agentId) {
      await update($, activity, a => ({ running: [], calls: 0, lastTurnCalls: a.calls }))
      await Promise.all([readUsage($), readGit($), readAgents($)])
    }
    return result
  })

  on('tool.call', async ($, e, next) => {
    if (e.agentId) return next(e)
    const input = e as unknown as Record<string, unknown>
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

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    const snap = await snapshot($)
    if (e.props.hasSurvey || snap === null) return next(e)

    const columns = e.props.bodyColumns - 2
    const { Box, Text } = $.ui.resolve(e)
    const row = (key: string, segments: Segment[]) =>
      Box({
        key,
        flexDirection: 'row',
        children: fit(segments, columns).flatMap((segment, i) => {
          const texts = segment.parts.map(p => Text({ color: p.color, dimColor: p.dim, children: p.text }))
          return i === 0 ? texts : [Text({ dimColor: true, children: SEPARATOR }), ...texts]
        }),
      })
    return Box({
      flexDirection: 'column',
      paddingX: 1,
      children: [row('state', stateLine(snap)), row('activity', activityLine(snap, e.props.isWorking))],
    })
  })
}

async function snapshot($: EngineInterface): Promise<Snapshot | null> {
  const [ctx, windows, repo, act, running, list, at] = await Promise.all([
    read($, context),
    read($, limits),
    read($, git),
    read($, activity),
    read($, agents),
    read($, todos),
    read($, now),
  ])
  return ctx === null ? null : { ctx, windows, repo, act, running, list, at }
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
  await update($, activity, a => ({ ...a, running: a.running.filter(r => r.id !== call.id) }))
  if (isAnswered(result)) await trackTodos($, tool, input, result)
  if (tool === 'Agent') await readAgents($)
  await readUsage($)
  if (MUTATING.has(tool)) await readGit($)
}

function isAnswered(result: unknown): result is { result?: unknown } {
  if (typeof result !== 'object' || result === null) return false
  const r = result as { deny?: unknown; isError?: unknown }
  return r.deny === undefined && r.isError !== true
}

// TodoWrite replaces the list; TaskCreate and TaskUpdate edit it one task at a time.
async function trackTodos($: EngineInterface, tool: string, input: Record<string, unknown>, answered: { result?: unknown }) {
  const text = (value: unknown) => (typeof value === 'string' ? value : '')
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
  const segments = [...stateLine(snap), ...activityLine(snap, snap.act.running.length > 0)]
  $.ui.status(
    fit(segments, STATUS_COLUMNS)
      .map(segment => segment.parts.map(p => p.text).join(''))
      .join(SEPARATOR),
  )
}

function stateLine(snap: Snapshot) {
  return [
    contextSegment(snap.ctx),
    ...snap.windows.map(w => limitSegment(w, snap.at)),
    snap.repo && gitSegment(snap.repo),
  ].filter((s): s is Segment => Boolean(s))
}

function activityLine(snap: Snapshot, isWorking: boolean) {
  const segments = [
    activitySegment(snap.act, isWorking),
    agentsSegment(snap.running, snap.at),
    todosSegment(snap.list),
  ].filter((s): s is Segment => Boolean(s))
  return segments.length > 0 ? segments : [{ key: 'ready', parts: [{ text: 'ready', dim: true }] }]
}

async function readUsage($: EngineInterface) {
  const usage = await $.session.usage()
  const { window } = usage.context
  const used = usage.context.tokens ?? 0
  const percent = usage.context.percent ?? (window > 0 ? Math.round((used / window) * 100) : 0)
  const nextContext: GlanceContext = { percent, left: Math.max(0, window - used) }
  const windows = (['five_hour', 'seven_day'] as const).flatMap((kind): GlanceLimit[] => {
    const r = usage.rateLimits.find(l => l.kind === kind)
    return r ? [{ window: kind === 'five_hour' ? '5h' : '7d', percent: r.percentUsed, resetsAt: r.resetsAt }] : []
  })

  await update($, context, () => nextContext)
  await update($, limits, () => windows)
  await stamp($)
}

async function readGit($: EngineInterface) {
  const cwd = await $.session.cwd()
  const run = (...args: string[]) => $.process.run(['git', '-C', cwd, ...args], { timeoutMs: 2000 })
  const head = await run('symbolic-ref', '--short', '-q', 'HEAD')
  const branch = head.exitCode === 0 ? head.stdout.trim() : (await run('rev-parse', '--short', 'HEAD')).stdout.trim()
  if (!branch) {
    await update($, git, () => null)
    return
  }
  const status = await run('status', '--porcelain')
  const changes = status.exitCode === 0 ? status.stdout.split('\n').filter(Boolean).length : 0
  await update($, git, (): GlanceGit => ({ branch, changes }))
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
      { text: `  ${compact(ctx.left)} left`, dim: true },
    ],
  }
}

function limitSegment(lim: GlanceLimit, at: number): Segment {
  const color = lim.percent >= LIMIT_CRITICAL ? 'red' : lim.percent >= LIMIT_TIGHT ? 'yellow' : 'blue'
  const reset = until(lim.resetsAt, at)
  return {
    key: `limit:${lim.window}`,
    parts: [
      { text: `${gauge(lim.percent)} `, color },
      { text: `${lim.window} `, dim: true },
      { text: `${Math.round(lim.percent)}%`, color: lim.percent >= LIMIT_TIGHT ? color : undefined },
      ...(reset ? [{ text: `  ↻${reset}`, dim: true }] : []),
    ],
  }
}

function gitSegment(repo: GlanceGit): Segment {
  return {
    key: 'git',
    parts: [
      { text: '⎇ ', color: 'magenta' },
      { text: repo.branch },
      { text: repo.changes > 0 ? ` ±${repo.changes}` : ' ✓', dim: true },
    ],
  }
}

function activitySegment(act: GlanceActivity, isWorking: boolean): Segment | null {
  const current = act.running[act.running.length - 1]
  if (isWorking && current) {
    return {
      key: 'activity',
      parts: [
        { text: '▸ ', color: 'cyan' },
        { text: current.tool },
        ...(current.detail ? [{ text: ` ${current.detail}`, dim: true }] : []),
        { text: `  #${act.calls}`, dim: true },
      ],
    }
  }
  if (isWorking) return { key: 'activity', parts: [{ text: act.calls > 0 ? `working  #${act.calls}` : 'working', dim: true }] }
  if (act.lastTurnCalls > 0) {
    return { key: 'activity', parts: [{ text: `${act.lastTurnCalls} call${act.lastTurnCalls === 1 ? '' : 's'} last turn`, dim: true }] }
  }
  return null
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

function todosSegment(list: GlanceTodo[]): Segment | null {
  if (list.length === 0) return null
  const done = list.filter(t => t.status === 'completed').length
  const active = list.find(t => t.status === 'in_progress')
  return {
    key: 'todos',
    parts: [
      done === list.length ? { text: '☑ ', color: 'green' } : { text: '☐ ', color: 'yellow' },
      { text: `${done}/${list.length}`, dim: true },
      ...(active?.content ? [{ text: ` ${clip(active.content, 32)}` }] : []),
    ],
  }
}

// Keeps segments in order until the line would overflow; the first always stays.
function fit(segments: Segment[], columns: number) {
  const width = (s: Segment) => s.parts.reduce((n, p) => n + p.text.length, 0)
  const shown: Segment[] = []
  let used = 0
  for (const segment of segments) {
    const cost = width(segment) + (shown.length > 0 ? SEPARATOR.length : 0)
    if (shown.length > 0 && used + cost > columns) break
    shown.push(segment)
    used += cost
  }
  return shown
}

function displayTool(tool: string) {
  const mcp = /^mcp__(.+?)__(.+)$/.exec(tool)
  return mcp ? (mcp[2] ?? tool) : tool
}

function detailOf(tool: string, input: Record<string, unknown>) {
  const text = (key: string) => (typeof input[key] === 'string' ? (input[key] as string) : '')
  switch (tool) {
    case 'Read':
    case 'Edit':
    case 'Write':
    case 'NotebookEdit':
      return text('file_path').split('/').pop() || undefined
    case 'Grep':
    case 'Glob':
      return clip(text('pattern'), 24)
    case 'Bash':
      return clip(text('command').trim().split('\n')[0] ?? '', 28)
    case 'Agent':
      return text('subagent_type') || undefined
    case 'Skill':
      return text('skill') || undefined
  }
  return undefined
}

function clip(value: string, max: number) {
  if (!value) return undefined
  return value.length > max ? `${value.slice(0, max - 1)}…` : value
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

// h:mm under a day, whole days beyond it.
function until(iso: string | undefined, at: number) {
  if (!iso) return ''
  const minutes = Math.ceil((Date.parse(iso) - at) / MINUTE)
  if (!(minutes > 0)) return ''
  if (minutes >= 24 * 60) return `${Math.round(minutes / (24 * 60))}d`
  return `${Math.floor(minutes / 60)}:${String(minutes % 60).padStart(2, '0')}`
}
