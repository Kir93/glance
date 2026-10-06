export type GlanceContext = { percent: number; left: number }
export type GlanceLimit = { window: '5h' | '7d'; percent: number; resetsAt?: string }
export type GlanceGit = { branch: string; changes: number }
export type GlanceCall = { id: string; tool: string; detail?: string }
export type GlanceActivity = { running: GlanceCall[]; calls: number; lastTurnCalls: number }

declare module 'claude-code' {
  interface PluginState {
    glance: {
      context: GlanceContext | null
      limit: GlanceLimit | null
      git: GlanceGit | null
      activity: GlanceActivity
      now: number
    }
  }
}
