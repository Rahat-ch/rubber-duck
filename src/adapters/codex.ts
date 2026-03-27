import { execa } from 'execa'
import { BaseAdapter } from './base.js'
import type { AgentTurn, SendOpts } from '../types.js'

interface CodexEvent {
  type: string
  thread_id?: string
  usage?: { input_tokens: number; cached_input_tokens: number; output_tokens: number }
  item?: { type: string; text?: string }
  error?: { message: string }
  message?: string
}

export class CodexAdapter extends BaseAdapter {
  readonly name = 'codex' as const
  private currentThreadId: string | null = null

  async send(prompt: string, opts?: SendOpts): Promise<AgentTurn> {
    return this.execute(prompt, undefined, opts)
  }

  async resume(sessionId: string, prompt: string, opts?: SendOpts): Promise<AgentTurn> {
    return this.execute(prompt, sessionId, opts)
  }

  private async execute(prompt: string, threadId?: string, opts?: SendOpts): Promise<AgentTurn> {
    const args: string[] = ['exec']

    if (threadId) {
      args.push('resume', threadId)
    }

    args.push('--json', '--full-auto', '--skip-git-repo-check')

    // Pass prompt via stdin to avoid arg parsing issues
    args.push('-')

    // Prepend system prompt to the input since Codex doesn't support file-based instructions well
    let input = prompt
    if (opts?.systemPrompt) {
      const { readFileSync } = await import('node:fs')
      try {
        const sysContent = readFileSync(opts.systemPrompt, 'utf-8')
        input = `${sysContent}\n\n---\n\n${prompt}`
      } catch {
        input = prompt
      }
    }

    const start = Date.now()
    this.process = execa('codex', args, {
      cwd: opts?.cwd,
      timeout: opts?.timeout_ms ?? 120_000,
      reject: false,
      input,
    })

    const result = await this.process
    this.process = null
    const duration_ms = Date.now() - start

    if (result.exitCode !== 0) {
      throw new Error(`Codex exited with code ${result.exitCode}: ${result.stderr}`)
    }

    return this.parseJsonlOutput(result.stdout as string, duration_ms, threadId)
  }

  private parseJsonlOutput(stdout: string, duration_ms: number, previousThreadId?: string): AgentTurn {
    const lines = stdout.trim().split('\n').filter(Boolean)
    let content = ''
    let tokens_in = 0
    let tokens_out = 0
    let newThreadId: string | null = null

    for (const line of lines) {
      let event: CodexEvent
      try {
        event = JSON.parse(line)
      } catch {
        continue
      }

      if (event.type === 'thread.started' && event.thread_id) {
        newThreadId = event.thread_id
      }

      if (event.type === 'item.completed' && event.item?.type === 'agent_message' && event.item.text) {
        content = event.item.text
      }

      if (event.type === 'turn.completed' && event.usage) {
        tokens_in = event.usage.input_tokens + (event.usage.cached_input_tokens ?? 0)
        tokens_out = event.usage.output_tokens
      }

      if (event.type === 'turn.failed' || event.type === 'error') {
        const msg = event.error?.message ?? event.message ?? 'Unknown error'
        throw new Error(`Codex turn failed: ${msg}`)
      }
    }

    this.currentThreadId = newThreadId ?? previousThreadId ?? null

    return {
      content,
      structured: this.parseStructuredOutput(content),
      cost_usd: 0,
      tokens_in,
      tokens_out,
      duration_ms,
      session_id: this.currentThreadId ?? '',
    }
  }
}
