import { execa } from 'execa'
import { writeFileSync, readFileSync, existsSync, unlinkSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { execSync } from 'node:child_process'
import { BaseAdapter } from './base.js'
import type { AgentTurn, SendOpts } from '../types.js'

export class ClaudeAdapter extends BaseAdapter {
  readonly name = 'claude' as const
  private currentSessionId: string | null = null
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
      args.push('--append-system-prompt-file', opts.systemPrompt)
    }

    // Write prompt to temp file for stdin
    const promptFile = join(tmpdir(), 'rubberduck', `claude-prompt-${Date.now()}.txt`)
    mkdirSync(join(tmpdir(), 'rubberduck'), { recursive: true })
    writeFileSync(promptFile, prompt, 'utf-8')

    // Output file for capturing JSON result
    const outputFile = join(tmpdir(), 'rubberduck', `claude-output-${Date.now()}.json`)

    const start = Date.now()

    if (this.tmuxPane) {
      // Run in tmux pane so user sees it live
      const escapedArgs = args.map(a => `'${a.replace(/'/g, "'\\''")}'`).join(' ')
      const cmd = `claude ${escapedArgs} < '${promptFile}' > '${outputFile}' 2>&1; echo '__DUCK_DONE__'`

      // Clear pane and run command
      execSync(`tmux send-keys -t "${this.tmuxPane}" "clear" Enter`, { stdio: 'pipe' })
      execSync(`tmux send-keys -t "${this.tmuxPane}" ${JSON.stringify(cmd)} Enter`, { stdio: 'pipe' })

      // Poll for completion
      await this.waitForOutput(outputFile, opts?.timeout_ms ?? 300_000)
    } else {
      // Non-tmux: run directly
      this.process = execa('claude', args, {
        cwd: opts?.cwd,
        timeout: opts?.timeout_ms ?? 300_000,
        reject: false,
        input: prompt,
      })

      const result = await this.process
      this.process = null

      if (result.exitCode !== 0) {
        throw new Error(`Claude exited with code ${result.exitCode}: ${result.stderr}`)
      }

      writeFileSync(outputFile, result.stdout as string, 'utf-8')
    }

    const duration_ms = Date.now() - start

    if (!existsSync(outputFile)) {
      throw new Error('Claude produced no output')
    }

    const raw = readFileSync(outputFile, 'utf-8').trim()
    // Clean up temp files
    try { unlinkSync(promptFile) } catch {}
    try { unlinkSync(outputFile) } catch {}

    if (!raw) {
      throw new Error('Claude produced empty output')
    }

    const output = JSON.parse(raw)
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

  private async waitForOutput(outputFile: string, timeout: number): Promise<void> {
    const start = Date.now()
    const pollInterval = 2000

    while (Date.now() - start < timeout) {
      await new Promise(resolve => setTimeout(resolve, pollInterval))

      if (existsSync(outputFile)) {
        const content = readFileSync(outputFile, 'utf-8')
        // Check if the file has actual JSON content (not just partial writes)
        if (content.trim() && content.includes('"result"')) {
          return
        }
      }
    }

    throw new Error(`Claude timed out after ${Math.round(timeout / 1000)}s`)
  }
}
