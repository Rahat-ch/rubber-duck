import { execa } from 'execa'
import { writeFileSync, readFileSync, existsSync, unlinkSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { execSync } from 'node:child_process'
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
  private tmuxPane: string | null = null

  setTmuxPane(paneId: string): void {
    this.tmuxPane = paneId
  }

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

    // Write prompt to temp file for stdin
    const promptFile = join(tmpdir(), 'rubberduck', `codex-prompt-${Date.now()}.txt`)
    mkdirSync(join(tmpdir(), 'rubberduck'), { recursive: true })

    // Prepend system prompt if provided
    let fullPrompt = prompt
    if (opts?.systemPrompt) {
      try {
        const sysContent = readFileSync(opts.systemPrompt, 'utf-8')
        fullPrompt = `${sysContent}\n\n---\n\n${prompt}`
      } catch {}
    }
    writeFileSync(promptFile, fullPrompt, 'utf-8')

    const outputFile = join(tmpdir(), 'rubberduck', `codex-output-${Date.now()}.jsonl`)

    args.push('-')

    const start = Date.now()

    if (this.tmuxPane) {
      // Run in tmux pane so user sees it live
      const escapedArgs = args.map(a => `'${a.replace(/'/g, "'\\''")}'`).join(' ')
      const cmd = `codex ${escapedArgs} < '${promptFile}' > '${outputFile}' 2>&1; echo '__DUCK_DONE__'`

      execSync(`tmux send-keys -t "${this.tmuxPane}" "clear" Enter`, { stdio: 'pipe' })
      execSync(`tmux send-keys -t "${this.tmuxPane}" ${JSON.stringify(cmd)} Enter`, { stdio: 'pipe' })

      await this.waitForOutput(outputFile, opts?.timeout_ms ?? 300_000)
    } else {
      // Non-tmux: run directly
      this.process = execa('codex', args, {
        cwd: opts?.cwd,
        timeout: opts?.timeout_ms ?? 120_000,
        reject: false,
        input: fullPrompt,
      })

      const result = await this.process
      this.process = null

      if (result.exitCode !== 0) {
        throw new Error(`Codex exited with code ${result.exitCode}: ${result.stderr}`)
      }

      writeFileSync(outputFile, result.stdout as string, 'utf-8')
    }

    const duration_ms = Date.now() - start

    if (!existsSync(outputFile)) {
      throw new Error('Codex produced no output')
    }

    const raw = readFileSync(outputFile, 'utf-8').trim()
    try { unlinkSync(promptFile) } catch {}
    try { unlinkSync(outputFile) } catch {}

    if (!raw) {
      throw new Error('Codex produced empty output')
    }

    return this.parseJsonlOutput(raw, duration_ms, threadId)
  }

  private async waitForOutput(outputFile: string, timeout: number): Promise<void> {
    const start = Date.now()
    const pollInterval = 2000

    while (Date.now() - start < timeout) {
      await new Promise(resolve => setTimeout(resolve, pollInterval))

      if (existsSync(outputFile)) {
        const content = readFileSync(outputFile, 'utf-8')
        // Codex JSONL is done when we see turn.completed
        if (content.includes('"turn.completed"') || content.includes('"turn.failed"')) {
          return
        }
      }
    }

    throw new Error(`Codex timed out after ${Math.round(timeout / 1000)}s`)
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
