import type { AgentAdapter, AgentTurn, AgentTurnOutput, SendOpts } from '../types.js'
import type { ResultPromise } from 'execa'

export abstract class BaseAdapter implements AgentAdapter {
  abstract readonly name: 'claude' | 'codex'
  protected process: ResultPromise | null = null

  abstract send(prompt: string, opts?: SendOpts): Promise<AgentTurn>
  abstract resume(sessionId: string, prompt: string, opts?: SendOpts): Promise<AgentTurn>

  async abort(): Promise<void> {
    if (this.process) {
      this.process.kill('SIGTERM')
      this.process = null
    }
  }

  isRunning(): boolean {
    return this.process !== null
  }

  protected parseStructuredOutput(content: string): AgentTurnOutput | null {
    const jsonBlockRegex = /```json\s*\n([\s\S]*?)\n\s*```/g
    let lastMatch: RegExpExecArray | null = null
    let match: RegExpExecArray | null
    while ((match = jsonBlockRegex.exec(content)) !== null) {
      lastMatch = match
    }
    if (!lastMatch) return null

    try {
      const parsed = JSON.parse(lastMatch[1])
      if (
        typeof parsed.decision === 'string' &&
        Array.isArray(parsed.blocking_issues) &&
        typeof parsed.artifact_hash === 'string' &&
        Array.isArray(parsed.touched_files) &&
        typeof parsed.summary === 'string'
      ) {
        return parsed as AgentTurnOutput
      }
    } catch {}
    return null
  }
}
