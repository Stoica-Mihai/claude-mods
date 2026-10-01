export type GuardrailsRule = 'keywords' | 'patterns' | 'source-writes' | 'builds'

export type GuardrailsBlock = {
  at: number
  rules: GuardrailsRule[]
  command: string
  reason: string
}

export type GuardrailsTotals = Record<GuardrailsRule, number>

declare module 'claude-code' {
  interface PluginState {
    guardrails: {
      session: GuardrailsBlock[]
      history: GuardrailsBlock[]
      totals: GuardrailsTotals
    }
  }
}
