import { v4 as uuid } from 'uuid'
import { resolve } from 'node:path'
import { writeFileSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { SessionMode, RoundResult } from '../types.js'
import type { RubberDuckConfig } from '../config.js'
import { ClaudeAdapter } from '../adapters/claude.js'
import { CodexAdapter } from '../adapters/codex.js'
import { getSystemPrompt } from '../adapters/prompts.js'
import { getDb, closeDb } from '../bus/db.js'
import { createSession, updateSession } from '../bus/sessions.js'
import { getDbPath } from '../config.js'
import { initPlanArtifact, initReviewArtifact } from '../artifact/manager.js'
import { executeRound } from './round.js'
import { shouldSummarize, summarizeAndRotate } from '../summarizer/summarizer.js'
import { InterruptHandler } from '../interrupt/handler.js'
import { CONSENSUS_BANNER } from '../ui/ducks.js'
import chalk from 'chalk'

export interface OrchestratorOpts {
  mode: SessionMode
  task: string
  config: RubberDuckConfig
  stepByStep?: boolean
  noTmux?: boolean
}

export async function runOrchestrator(opts: OrchestratorOpts): Promise<void> {
  const { mode, task, config } = opts
  const sessionId = uuid()
  const db = getDb(getDbPath(config))

  const artifactPath = resolveArtifactPath(mode, task)

  if (mode === 'plan') initPlanArtifact(artifactPath, task)
  if (mode === 'review') initReviewArtifact(artifactPath, task)

  createSession(db, {
    id: sessionId,
    task,
    mode,
    max_rounds: config.session.maxRounds,
    autonomy: config.session.autonomy,
    step_by_step: opts.stepByStep,
    artifact_path: artifactPath,
    artifact_kind: mode,
  })

  console.log(chalk.dim(`Session: ${sessionId}`))
  console.log(chalk.dim(`Artifact: ${artifactPath}`))
  console.log()

  const agentA = new ClaudeAdapter()
  const agentB = new CodexAdapter()

  // Write system prompts to temp files to avoid CLI arg length issues
  const promptVars = {
    artifact_path: artifactPath,
    review_target_path: mode === 'review' ? task : undefined,
    task,
    step_by_step: opts.stepByStep,
  }
  const systemPromptA = writeSystemPromptFile(getSystemPrompt(mode, 'a', promptVars), 'claude')
  const systemPromptB = writeSystemPromptFile(getSystemPrompt(mode, 'b', promptVars), 'codex')

  const interrupt = new InterruptHandler(config.interrupt.hotkey)
  interrupt.registerAgents(agentA, agentB)

  let totalCost = 0
  let lastAgentBContent: string | null = null
  let claudeSid: string | null = null
  let codexSid: string | null = null
  let converged = false

  for (let round = 1; round <= config.session.maxRounds; round++) {
    if (totalCost >= config.session.maxBudgetTotal) {
      console.log(chalk.red(`\nBudget limit reached ($${totalCost.toFixed(2)} / $${config.session.maxBudgetTotal})`))
      updateSession(db, sessionId, { status: 'paused', rounds: round - 1, total_cost_usd: totalCost })
      break
    }

    // Check for pending human interrupt between rounds
    let humanMessage: string | undefined
    if (interrupt.isPaused()) {
      const result = await interrupt.waitForInterrupt()
      if (result.action === 'abort') {
        console.log(chalk.yellow('\nAborted by user.'))
        updateSession(db, sessionId, { status: 'cancelled', rounds: round - 1, total_cost_usd: totalCost })
        break
      }
      if (result.action === 'inject' && result.message) {
        humanMessage = result.message
      }
    }

    let result: RoundResult
    try {
      result = await executeRound({
        db,
        sessionId,
        round,
        mode,
        artifactPath,
        agentA,
        agentB,
        systemPromptA,
        systemPromptB,
        lastAgentBContent,
        claudeSid,
        codexSid,
        humanMessage,
        cwd: process.cwd(),
        timeoutMs: config.session.timeoutPerTurn_ms,
        maxBudgetPerTurn: config.claude.maxBudgetPerTurn,
      })
    } catch (err) {
      console.error(chalk.red(`\nRound ${round} failed: ${(err as Error).message}`))
      updateSession(db, sessionId, { status: 'failed', rounds: round, total_cost_usd: totalCost })
      break
    }

    totalCost += result.cost_usd
    lastAgentBContent = result.agent_b.content
    claudeSid = result.agent_a.session_id || claudeSid
    codexSid = result.agent_b.session_id || codexSid

    updateSession(db, sessionId, {
      rounds: round,
      total_cost_usd: totalCost,
      claude_sid: claudeSid || undefined,
      codex_sid: codexSid || undefined,
    })

    if (result.consensus.reached) {
      converged = true
      console.log(CONSENSUS_BANNER)
      console.log(chalk.green(`  Consensus reached in ${round} round${round > 1 ? 's' : ''}!`))
      console.log(chalk.dim(`  Total cost: $${totalCost.toFixed(2)}`))
      console.log(chalk.dim(`  Artifact: ${artifactPath}`))
      break
    }

    // Summarize if needed (cost management)
    if (shouldSummarize(round, config.session.summarizeEvery)) {
      console.log(chalk.dim('\nSummarizing conversation to manage context size...'))
      try {
        await summarizeAndRotate(db, sessionId, round, config.consensus.model)
        claudeSid = null
        codexSid = null
        console.log(chalk.dim('Session rotated with summary context.'))
      } catch (err) {
        console.log(chalk.dim(`Summarization failed, continuing with full context: ${(err as Error).message}`))
      }
    }

    console.log()
  }

  if (!converged) {
    const session = updateSession(db, sessionId, {
      status: 'paused',
      total_cost_usd: totalCost,
    })
    console.log(chalk.yellow(`\nMax rounds (${config.session.maxRounds}) reached without consensus.`))
    console.log(chalk.dim(`Total cost: $${totalCost.toFixed(2)}`))
    console.log(chalk.dim(`Resume with: duck resume ${sessionId.slice(0, 8)}`))
  }

  interrupt.destroy()
  closeDb()
}

function resolveArtifactPath(mode: SessionMode, task: string): string {
  if (mode === 'plan') return resolve('plan.md')
  if (mode === 'review') return resolve('review.json')
  return resolve('.duck-build')
}

function writeSystemPromptFile(content: string, prefix: string): string {
  const dir = join(tmpdir(), 'rubberduck')
  mkdirSync(dir, { recursive: true })
  const path = join(dir, `${prefix}-${Date.now()}.txt`)
  writeFileSync(path, content, 'utf-8')
  return path
}
