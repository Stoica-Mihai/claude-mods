export type GuardrailsBlock = {
  at: number
  rules: string[]
  command: string
  reason: string
}

export type GuardrailsStatus = {
  path: string
  ruleCount: number
  errors: string[]
}

declare module 'claude-code' {
  interface PluginState {
    guardrails: {
      session: GuardrailsBlock[]
      history: GuardrailsBlock[]
      totals: Record<string, number>
      status: GuardrailsStatus
    }
  }
}
