import { createInterface } from 'node:readline'
import type { AgentAdapter } from '../types.js'

export interface InterruptResult {
  message: string | null
  action: 'inject' | 'resume' | 'abort'
}

export class InterruptHandler {
  private paused = false
  private pendingResolve: ((result: InterruptResult) => void) | null = null
  private agents: AgentAdapter[] = []

  constructor(private hotkey: string = 'ctrl+\\') {
    this.setupSignalHandler()
  }

  registerAgents(...agents: AgentAdapter[]): void {
    this.agents = agents
  }

  private setupSignalHandler(): void {
    // SIGQUIT is triggered by Ctrl+\ on Unix
    process.on('SIGQUIT', () => {
      this.handleInterrupt()
    })
  }

  private async handleInterrupt(): Promise<void> {
    if (this.paused) return
    this.paused = true

    // Kill running agents
    for (const agent of this.agents) {
      if (agent.isRunning()) {
        await agent.abort()
      }
    }

    console.log('\n[!! QUACK] Paused. Type your message (or "resume" to continue, "abort" to stop):')

    const rl = createInterface({ input: process.stdin, output: process.stdout })
    rl.question('[quack]> ', (answer) => {
      rl.close()
      this.paused = false

      const trimmed = answer.trim()
      if (trimmed.toLowerCase() === 'resume' || trimmed === '') {
        this.pendingResolve?.({ message: null, action: 'resume' })
      } else if (trimmed.toLowerCase() === 'abort') {
        this.pendingResolve?.({ message: null, action: 'abort' })
      } else {
        this.pendingResolve?.({ message: trimmed, action: 'inject' })
      }
      this.pendingResolve = null
    })
  }

  waitForInterrupt(): Promise<InterruptResult> {
    return new Promise(resolve => {
      this.pendingResolve = resolve
    })
  }

  isPaused(): boolean {
    return this.paused
  }

  destroy(): void {
    process.removeAllListeners('SIGQUIT')
  }
}
