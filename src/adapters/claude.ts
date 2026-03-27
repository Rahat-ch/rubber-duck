import { execa } from 'execa'
import { BaseAdapter } from './base.js'
import type { AgentTurn, SendOpts } from '../types.js'

export class ClaudeAdapter extends BaseAdapter {
  readonly name = 'claude' as const
  private currentSessionId: string | null = null

  async send(prompt: string, opts?: SendOpts): Promise<AgentTurn> {
    return this.execute(prompt, undefined, opts)
  }

  async resume(sessionId: string, prompt: string, opts?: SendOpts): Promise<AgentTurn> {
    return this.execute(prompt, sessionId, opts)
  }

  private async execute(prompt: string, sessionId?: string, opts?: SendOpts): Promise<AgentTurn> {
    const args = ['-p', '--output-format', 'json']

    if (sessionId) {
      args.push('--resume', sessionId)
    }

    args.push('--permission-mode', 'auto')

    if (opts?.maxBudget) {
      args.push('--max-budget-usd', String(opts.maxBudget))
    }

    if (opts?.systemPrompt) {
      args.push('--system-prompt', opts.systemPrompt)
    }

    // No positional prompt arg — pipe via stdin to avoid arg parsing issues
    const start = Date.now()
    this.process = execa('claude', args, {
      cwd: opts?.cwd,
      timeout: opts?.timeout_ms ?? 300_000,
      reject: false,
      input: prompt,
    })

    const result = await this.process
    this.process = null
    const duration_ms = Date.now() - start

    if (result.exitCode !== 0) {
      throw new Error(`Claude exited with code ${result.exitCode}: ${result.stderr}`)
    }

    const output = JSON.parse(result.stdout as string)
    const content = output.result ?? ''

    this.currentSessionId = output.session_id ?? sessionId ?? null

    return {
      content,
      structured: this.parseStructuredOutput(content),
      cost_usd: output.total_cost_usd ?? 0,
      tokens_in: output.usage?.input_tokens ?? 0,
      tokens_out: output.usage?.output_tokens ?? 0,
      duration_ms,
      session_id: this.currentSessionId ?? '',
    }
  }
}
