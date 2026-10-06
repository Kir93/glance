export type GlanceContext = { percent: number; left: number }
export type GlanceLimit = { window: '5h' | '7d'; percent: number; resetsAt?: string }
export type GlanceGit = { branch: string; changes: number }
export type GlanceCall = { id: string; tool: string; detail?: string }
export type GlanceActivity = { running: GlanceCall[]; calls: number }
export type GlanceAgent = { id: string; type: string; since: number }
export type GlanceTodo = { id?: string; content: string; status: 'pending' | 'in_progress' | 'completed' }

declare module 'claude-code' {
  interface PluginState {
    glance: {
      context: GlanceContext | null
      limits: GlanceLimit[]
      git: GlanceGit | null
      activity: GlanceActivity
      agents: GlanceAgent[]
      todos: GlanceTodo[]
      now: number
    }
  }
}
