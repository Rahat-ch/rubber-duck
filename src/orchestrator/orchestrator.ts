import type Database from 'better-sqlite3'
import { v4 as uuid } from 'uuid'
import { resolve } from 'node:path'
import type { SessionMode, RoundResult } from '../types.js'
import type { RubberDuckConfig } from '../config.js'
import { ClaudeAdapter } from '../adapters/claude.js'
import { CodexAdapter } from '../adapters/codex.js'
import { getSystemPrompt } from '../adapters/prompts.js'
import { getDb, closeDb } from '../bus/db.js'
import { createSession, updateSession, getSession } from '../bus/sessions.js'
import { getDbPath } from '../config.js'
import { initPlanArtifact, initReviewArtifact } from '../artifact/manager.js'
import { executeRound } from './round.js'
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

  // Init artifact
  if (mode === 'plan') initPlanArtifact(artifactPath, task)
  if (mode === 'review') initReviewArtifact(artifactPath, task)

  const session = createSession(db, {
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

  const promptVars = {
    artifact_path: artifactPath,
    review_target_path: mode === 'review' ? task : undefined,
    task,
    step_by_step: opts.stepByStep,
  }

  const systemPromptA = getSystemPrompt(mode, 'a', promptVars)
  const systemPromptB = getSystemPrompt(mode, 'b', promptVars)

  let totalCost = 0
  let lastAgentBContent: string | null = null
  let converged = false

  for (let round = 1; round <= config.session.maxRounds; round++) {
    // Budget check
    if (totalCost >= config.session.maxBudgetTotal) {
      console.log(chalk.red(`\nBudget limit reached ($${totalCost.toFixed(2)} / $${config.session.maxBudgetTotal})`))
      updateSession(db, sessionId, { status: 'paused', rounds: round - 1, total_cost_usd: totalCost })
      return
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
        cwd: process.cwd(),
        timeoutMs: config.session.timeoutPerTurn_ms,
        maxBudgetPerTurn: config.claude.maxBudgetPerTurn,
      })
    } catch (err) {
      console.error(chalk.red(`\nRound ${round} failed: ${(err as Error).message}`))
      updateSession(db, sessionId, { status: 'failed', rounds: round, total_cost_usd: totalCost })
      return
    }

    totalCost += result.cost_usd
    lastAgentBContent = result.agent_b.content

    updateSession(db, sessionId, {
      rounds: round,
      total_cost_usd: totalCost,
      claude_sid: result.agent_a.session_id || undefined,
      codex_sid: result.agent_b.session_id || undefined,
    })

    if (result.consensus.reached) {
      converged = true
      console.log(CONSENSUS_BANNER)
      console.log(chalk.green(`  Consensus reached in ${round} round${round > 1 ? 's' : ''}!`))
      console.log(chalk.dim(`  Total cost: $${totalCost.toFixed(2)}`))
      console.log(chalk.dim(`  Artifact: ${artifactPath}`))
      break
    }

    console.log()
  }

  if (!converged) {
    console.log(chalk.yellow(`\nMax rounds (${config.session.maxRounds}) reached without consensus.`))
    console.log(chalk.dim(`Total cost: $${totalCost.toFixed(2)}`))
  }

  updateSession(db, sessionId, {
    status: converged ? 'converged' : 'paused',
    total_cost_usd: totalCost,
  })

  closeDb()
}

function resolveArtifactPath(mode: SessionMode, task: string): string {
  if (mode === 'plan') return resolve('plan.md')
  if (mode === 'review') return resolve('review.json')
  return resolve('.duck-build')
}
