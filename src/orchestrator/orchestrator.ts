import { v4 as uuid } from 'uuid'
import { resolve } from 'node:path'
import { writeFileSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { execSync } from 'node:child_process'
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
import { isTmuxAvailable, createDuckSession, writeToPane, clearPane, killSession, attachToSession, setPaneTitle } from '../tmux/manager.js'
import { BANNER, CONSENSUS_BANNER } from '../ui/ducks.js'
import { printRoundSummary, printDiffSummary, promptUser } from '../ui/control.js'
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
  const useTmux = !opts.noTmux && isTmuxAvailable()

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

  // Set up tmux if available
  let tmuxSession: ReturnType<typeof createDuckSession> | null = null
  if (useTmux) {
    const sessionName = `duck-${sessionId.slice(0, 8)}`
    tmuxSession = createDuckSession(sessionName, config.tmux.layout)

    // Show banner in control pane
    writeToPane(tmuxSession.panes.control, '')
    clearPane(tmuxSession.panes.claude)
    clearPane(tmuxSession.panes.codex)

    setPaneTitle(tmuxSession.panes.claude, 'Claude (Agent A) — waiting')
    setPaneTitle(tmuxSession.panes.codex, 'Codex (Agent B) — waiting')
    setPaneTitle(tmuxSession.panes.control, `Duck Control — ${mode} mode`)

    // Write session info to control pane
    writeToPane(tmuxSession.panes.control, `Session: ${sessionId.slice(0, 8)}`)
    writeToPane(tmuxSession.panes.control, `Mode: ${mode} | Rounds: ${config.session.maxRounds} | Budget: $${config.session.maxBudgetTotal}`)
    writeToPane(tmuxSession.panes.control, `Artifact: ${artifactPath}`)
    writeToPane(tmuxSession.panes.control, '')
  }

  console.log(chalk.dim(`Session: ${sessionId}`))
  console.log(chalk.dim(`Artifact: ${artifactPath}`))
  if (useTmux && tmuxSession) {
    console.log(chalk.dim(`Tmux session: ${tmuxSession.name}`))
    console.log(chalk.dim(`Attach with: tmux attach -t ${tmuxSession.name}`))
  }
  console.log()

  const agentA = new ClaudeAdapter()
  const agentB = new CodexAdapter()

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
      const msg = `Budget limit reached ($${totalCost.toFixed(2)} / $${config.session.maxBudgetTotal})`
      console.log(chalk.red(`\n${msg}`))
      if (tmuxSession) writeToPane(tmuxSession.panes.control, msg)
      updateSession(db, sessionId, { status: 'paused', rounds: round - 1, total_cost_usd: totalCost })
      break
    }

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

    // Update tmux pane titles for active round
    if (tmuxSession) {
      setPaneTitle(tmuxSession.panes.claude, `Claude (Agent A) — Round ${round}`)
      setPaneTitle(tmuxSession.panes.codex, `Codex (Agent B) — Round ${round}`)
      writeToPane(tmuxSession.panes.control, `--- Round ${round} ---`)
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
        tmuxPanes: tmuxSession?.panes,
      })
    } catch (err) {
      const msg = `Round ${round} failed: ${(err as Error).message}`
      console.error(chalk.red(`\n${msg}`))
      if (tmuxSession) writeToPane(tmuxSession.panes.control, msg)
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

    // Show round cost summary
    printRoundSummary(round, result.agent_a.cost_usd, result.agent_b.cost_usd, totalCost, config.session.maxBudgetTotal)

    // For build mode: show git diff after each round
    if (mode === 'build' && artifactPath) {
      try {
        const diffStat = execSync('git diff --stat', { cwd: artifactPath, encoding: 'utf-8' })
        if (diffStat.trim()) {
          printDiffSummary(diffStat)
          if (tmuxSession) writeToPane(tmuxSession.panes.control, diffStat)
        }
      } catch {}
    }

    if (result.consensus.reached) {
      converged = true
      console.log(CONSENSUS_BANNER)
      console.log(chalk.green(`  Consensus reached in ${round} round${round > 1 ? 's' : ''}!`))
      console.log(chalk.dim(`  Total cost: $${totalCost.toFixed(2)}`))
      console.log(chalk.dim(`  Artifact: ${artifactPath}`))

      if (tmuxSession) {
        writeToPane(tmuxSession.panes.control, `Consensus reached in ${round} rounds! Cost: $${totalCost.toFixed(2)}`)
        setPaneTitle(tmuxSession.panes.claude, 'Claude (Agent A) — done')
        setPaneTitle(tmuxSession.panes.codex, 'Codex (Agent B) — done')
      }

      // Plan->build transition prompt
      if (mode === 'plan') {
        const answer = await promptUser('[b]uild from this plan? [q]uit?')
        if (answer.toLowerCase() === 'b' || answer.toLowerCase() === 'build') {
          console.log(chalk.dim('\nTransitioning to build mode...'))
          if (tmuxSession) {
            killSession(tmuxSession.name)
          }
          interrupt.destroy()
          closeDb()
          await runOrchestrator({
            ...opts,
            mode: 'build',
            task: `Build according to the plan in ${artifactPath}: ${task}`,
          })
          return
        }
      }
      break
    }

    // Summarize if needed
    if (shouldSummarize(round, config.session.summarizeEvery)) {
      console.log(chalk.dim('\nSummarizing conversation...'))
      if (tmuxSession) writeToPane(tmuxSession.panes.control, 'Summarizing conversation...')
      try {
        await summarizeAndRotate(db, sessionId, round, config.consensus.model)
        claudeSid = null
        codexSid = null
      } catch (err) {
        console.log(chalk.dim(`Summarization failed: ${(err as Error).message}`))
      }
    }

    console.log()
  }

  if (!converged) {
    console.log(chalk.yellow(`\nMax rounds (${config.session.maxRounds}) reached without consensus.`))
    console.log(chalk.dim(`Total cost: $${totalCost.toFixed(2)}`))
    console.log(chalk.dim(`Resume with: duck resume ${sessionId.slice(0, 8)}`))
    updateSession(db, sessionId, { status: 'paused', total_cost_usd: totalCost })
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
