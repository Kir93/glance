export type GlanceContext = { percent: number; left: number }
export type GlanceSample = { at: number; percent: number }
// `readAt`: when the figure was read, so a slower read cannot overwrite a newer one.
export type GlanceLimit = { window: '5h' | '7d' | 'spend'; percent: number; resetsAt?: string; readAt: number; samples: GlanceSample[] }
// `ahead`: commits on no remote; `added` / `removed`: lines changed in tracked files since HEAD;
// `readAt`: when the read started, so an earlier read finishing late cannot overwrite a later one.
export type GlanceGit = { branch: string; changes: number; ahead: number; added: number; removed: number; readAt: number }
export type GlanceCall = { id: string; tool: string; detail?: string }
// `errors`: this turn's calls that ended in an error or a deny; `inTurn`: a main turn is under way.
export type GlanceActivity = { running: GlanceCall[]; calls: number; errors: number; inTurn: boolean }
export type GlanceAgent = { id: string; type: string; since: number }
export type GlanceTodo = { id?: string; content: string; status: 'pending' | 'in_progress' | 'completed' }
export type GlanceBackground = {
  id: string
  type: 'shell' | 'monitor' | 'workflow'
  label?: string
  since: number
  // The subagent whose final answer ends it, for a shell a synchronous subagent started.
  owner?: string
}
export type GlanceLoop = { id: string; isWorkflow: boolean }
// The main thread's last request: its prompt tokens, and the model that answered it.
export type GlancePrompt = { tokens: number; model: string }

declare module 'claude-code' {
  interface PluginState {
    glance: {
      context: GlanceContext | null
      limits: Shaped<GlanceLimit[]>
      git: Shaped<GlanceGit | null>
      activity: Shaped<GlanceActivity>
      agents: GlanceAgent[]
      todos: GlanceTodo[]
      background: GlanceBackground[]
      loops: GlanceLoop[]
      lastAnswerAt: number | null
      lastPrompt: GlancePrompt | null
      // How long the prompt cache lives, in milliseconds, as the session has shown it.
      cacheTtl: number
      // What the session has cost so far, in US dollars; null where the host keeps no ledger.
      cost: number | null
      apiError: string | null
      now: number
    }
  }
}
