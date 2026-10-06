// glance — one line above the prompt, drawn the same in the terminal and the desktop app:
//
//   ◔ 38%  124K left  ·  5h 41%  ↻2:15  ·  ▸ Edit register.ts  #6  ·  ⎇ main ±3
//
// VS Code draws no band above the prompt, so there the same line, without color, is
// pinned as this plugin's status line instead.
//
// Segments, left to right, in the order they are dropped last when the band is narrow:
// context, the rate-limit window closest to running out, activity, git.
import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { GlanceActivity, GlanceCall, GlanceContext, GlanceGit, GlanceLimit } from '../types'

const context = atom({ plugin: 'glance', key: 'context' } as const, null)
const limit = atom({ plugin: 'glance', key: 'limit' } as const, null)
const git = atom({ plugin: 'glance', key: 'git' } as const, null)
const activity = atom({ plugin: 'glance', key: 'activity' } as const, { running: [], calls: 0, lastTurnCalls: 0 })
const now = atom({ plugin: 'glance', key: 'now' } as const, 0)

// Context is tight once 60% is gone and close to auto-compaction past 80%.
const CONTEXT_TIGHT = 60
const CONTEXT_CRITICAL = 80
const LIMIT_TIGHT = 70
const LIMIT_CRITICAL = 90
const MINUTE = 60_000
const STATUS_COLUMNS = 100
const MUTATING = new Set(['Bash', 'Edit', 'Write', 'NotebookEdit'])
const GAUGE = ['○', '◔', '◑', '◕', '●']

type Segment = { key: string; parts: { text: string; color?: string; dim?: boolean }[] }

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    const result = await next(e)
    await Promise.all([readUsage($), readGit($)])
    $.clock.every(MINUTE, () => {
      void stamp($)
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
      await Promise.all([readUsage($), readGit($)])
    }
    return result
  })

  on('tool.call', async ($, e, next) => {
    if (e.agentId) return next(e)
    // Nothing is awaited before the tool runs, and the HUD's own failures never reach the call.
    const started = begin($, e.tool, e.tool_use_id, e as unknown as Record<string, unknown>)
    try {
      return await next(e)
    } finally {
      await started.then(call => end($, call, e.tool)).catch(() => undefined)
    }
  })

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    const ctx = await read($, context)
    if (e.props.hasSurvey || ctx === null) return next(e)

    const [lim, repo, act, at] = await Promise.all([read($, limit), read($, git), read($, activity), read($, now)])
    const shown = fit(segmentsOf(ctx, lim, repo, act, at, e.props.isWorking), e.props.bodyColumns - 2)
    const { Box, Text } = $.ui.resolve(e)
    const children = shown.flatMap((segment, i) => {
      const texts = segment.parts.map(p => Text({ color: p.color, dimColor: p.dim, children: p.text }))
      return i === 0 ? texts : [Text({ dimColor: true, children: '  ·  ' }), ...texts]
    })
    return Box({ flexDirection: 'row', paddingX: 1, children })
  })
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

async function end($: EngineInterface, call: GlanceCall, tool: string) {
  await update($, activity, a => ({ ...a, running: a.running.filter(r => r.id !== call.id) }))
  await readUsage($)
  if (MUTATING.has(tool)) await readGit($)
}

async function stamp($: EngineInterface) {
  const at = await $.clock.now()
  await update($, now, () => at)
  await publishStatus($)
}

// The VS Code fallback: a status line carries text only, so the segments go out uncolored.
async function publishStatus($: EngineInterface) {
  if (!(await $.session.surfaces()).includes('vscode')) return
  const [ctx, lim, repo, act, at] = await Promise.all([
    read($, context),
    read($, limit),
    read($, git),
    read($, activity),
    read($, now),
  ])
  if (ctx === null) return
  const line = fit(segmentsOf(ctx, lim, repo, act, at, act.running.length > 0), STATUS_COLUMNS)
    .map(segment => segment.parts.map(p => p.text).join(''))
    .join('  ·  ')
  $.ui.status(line)
}

function segmentsOf(
  ctx: GlanceContext,
  lim: GlanceLimit | null,
  repo: GlanceGit | null,
  act: GlanceActivity,
  at: number,
  isWorking: boolean,
) {
  return [
    contextSegment(ctx),
    lim && limitSegment(lim, at),
    activitySegment(act, isWorking),
    repo && gitSegment(repo),
  ].filter((s): s is Segment => Boolean(s))
}

async function readUsage($: EngineInterface) {
  const usage = await $.session.usage()
  const { window } = usage.context
  const used = usage.context.tokens ?? 0
  const percent = usage.context.percent ?? (window > 0 ? Math.round((used / window) * 100) : 0)
  const nextContext: GlanceContext = { percent, left: Math.max(0, window - used) }

  // Of the subscription windows, show the one nearest its cap: that is the one that stops work.
  const windows = usage.rateLimits
    .filter(r => r.kind === 'five_hour' || r.kind === 'seven_day')
    .map((r): GlanceLimit => ({ window: r.kind === 'five_hour' ? '5h' : '7d', percent: r.percentUsed, resetsAt: r.resetsAt }))
    .sort((a, b) => b.percent - a.percent)

  await update($, context, () => nextContext)
  await update($, limit, () => windows[0] ?? null)
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

function contextSegment(ctx: GlanceContext): Segment {
  const color = ctx.percent >= CONTEXT_CRITICAL ? 'red' : ctx.percent >= CONTEXT_TIGHT ? 'yellow' : 'green'
  const glyph = GAUGE[Math.min(GAUGE.length - 1, Math.floor(ctx.percent / 20))] ?? '●'
  return {
    key: 'context',
    parts: [
      { text: `${glyph} `, color },
      { text: `${ctx.percent}%`, color: ctx.percent >= CONTEXT_TIGHT ? color : undefined },
      { text: `  ${compact(ctx.left)} left`, dim: true },
    ],
  }
}

function limitSegment(lim: GlanceLimit, at: number): Segment {
  const color = lim.percent >= LIMIT_CRITICAL ? 'red' : lim.percent >= LIMIT_TIGHT ? 'yellow' : undefined
  const reset = until(lim.resetsAt, at)
  return {
    key: 'limit',
    parts: [
      { text: `${lim.window} `, dim: true },
      { text: `${Math.round(lim.percent)}%`, color },
      ...(reset ? [{ text: `  ↻${reset}`, dim: true }] : []),
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

// Keeps segments in priority order until the line would overflow; the first always stays.
function fit(segments: Segment[], columns: number) {
  const width = (s: Segment) => s.parts.reduce((n, p) => n + p.text.length, 0)
  const shown: Segment[] = []
  let used = 0
  for (const segment of segments) {
    const cost = width(segment) + (shown.length > 0 ? 5 : 0)
    if (shown.length > 0 && used + cost > columns) continue
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

// h:mm under a day, whole days beyond it.
function until(iso: string | undefined, at: number) {
  if (!iso) return ''
  const minutes = Math.ceil((Date.parse(iso) - at) / MINUTE)
  if (!(minutes > 0)) return ''
  if (minutes >= 24 * 60) return `${Math.round(minutes / (24 * 60))}d`
  return `${Math.floor(minutes / 60)}:${String(minutes % 60).padStart(2, '0')}`
}
