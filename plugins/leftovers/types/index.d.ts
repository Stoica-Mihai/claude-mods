export type LeftoversCall = { at: number; end: number | null; command: string }

export type LeftoversProc = {
  id: string
  pid: number
  ppid: number
  isAttached: boolean
  startedAt: number
  args: string
  from: string | null
}

export type LeftoversScan = { at: number; procs: LeftoversProc[]; error: string | null }

declare module 'claude-code' {
  interface PluginState {
    leftovers: {
      key: string
      calls: LeftoversCall[]
      reported: string[]
      scan: LeftoversScan
    }
  }
}
