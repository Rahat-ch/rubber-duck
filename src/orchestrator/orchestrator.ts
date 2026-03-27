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
import { createSession, updateSession, getSession } from '../bus/sessions.js'
import { getLastMessage } from '../bus/messages.js'
import { getDbPath } from '../config.js'
import { initPlanArtifact, initReviewArtifact } from '../artifact/manager.js'
import { executeRound } from './round.js'
import { shouldSummarize, summarizeAndRotate } from '../summarizer/summarizer.js'
import { InterruptHandler } from '../interrupt/handler.js'
import { isTmuxAvailable, isInsideTmux, launchInTmux, writeToPane, setPaneTitle, getPaneIds } from '../tmux/manager.js'
import { BANNER, CONSENSUS_BANNER } from '../ui/ducks.js'
import { printRoundSummary, printDiffSummary, promptUser } from '../ui/control.js'
import chalk from 'chalk'

export interface OrchestratorOpts {
  mode: SessionMode
  task: string
  config: RubberDuckConfig
  stepByStep?: boolean
  noTmux?: boolean
  _internal?: boolean // set when running inside tmux pane
  _tmuxSessionName?: string
}

export async function runOrchestrator(opts: OrchestratorOpts): Promise<void> {
  const { mode, task, config } = opts
  const useTmux = !opts.noTmux && isTmuxAvailable() && !opts._internal

  // If tmux available and we're not already inside the tmux session: launch tmux and re-exec
  if (useTmux) {
    const sessionId = uuid().slice(0, 8)
    const tmuxName = `duck-${sessionId}`

    // Build the command to run inside the control pane
    const args = process.argv.slice(1).filter(a => a !== '--no-tmux')
    const cmd = `npx tsx ${args.map(a => `'${a}'`).join(' ')} --internal --tmux-session ${tmuxName}`

    console.log(BANNER)
    console.log(chalk.dim(`Launching tmux session: ${tmuxName}`))
    console.log(chalk.dim(`Press Ctrl+\\ to interrupt agents\n`))

    launchInTmux(tmuxName, config.tmux.layout, cmd)
    // launchInTmux attaches and blocks until user detaches/exits
    return
  }

  // Running inside tmux (--internal) or no-tmux mode
  await runOrchestratorCore(opts)
}

async function runOrchestratorCore(opts: OrchestratorOpts): Promise<void> {
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

  // Get tmux pane IDs if we're running inside a tmux session
  const tmuxPanes = opts._tmuxSessionName ? getPaneIds(opts._tmuxSessionName) : null

  console.log(BANNER)
  console.log(chalk.dim(`Session: ${sessionId.slice(0, 8)}`))
  console.log(chalk.dim(`Mode: ${mode} | Max rounds: ${config.session.maxRounds}`))
  console.log(chalk.dim(`Artifact: ${artifactPath}\n`))

  const agentA = new ClaudeAdapter()
  const agentB = new CodexAdapter()

  if (tmuxPanes) {
    agentA.setTmuxPane(tmuxPanes.claude)
    agentB.setTmuxPane(tmuxPanes.codex)
  }

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

    // Update tmux pane titles
    if (tmuxPanes) {
      setPaneTitle(tmuxPanes.claude, `Claude (Agent A) — Round ${round}`)
      setPaneTitle(tmuxPanes.codex, `Codex (Agent B) — waiting`)
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
        tmuxPanes: tmuxPanes ?? undefined,
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

    printRoundSummary(round, result.agent_a.cost_usd, result.agent_b.cost_usd, totalCost, config.session.maxBudgetTotal)

    if (mode === 'build' && artifactPath) {
      try {
        const diffStat = execSync('git diff --stat', { cwd: artifactPath, encoding: 'utf-8' })
        if (diffStat.trim()) printDiffSummary(diffStat)
      } catch {}
    }

    if (result.consensus.reached) {
      converged = true
      console.log(CONSENSUS_BANNER)
      console.log(chalk.green(`  Consensus reached in ${round} round${round > 1 ? 's' : ''}!`))
      console.log(chalk.dim(`  Total cost: $${totalCost.toFixed(2)}`))
      console.log(chalk.dim(`  Artifact: ${artifactPath}`))

      if (tmuxPanes) {
        setPaneTitle(tmuxPanes.claude, 'Claude — done')
        setPaneTitle(tmuxPanes.codex, 'Codex — done')
      }

      if (mode === 'plan') {
        const answer = await promptUser('[b]uild from this plan? [q]uit?')
        if (answer.toLowerCase() === 'b' || answer.toLowerCase() === 'build') {
          console.log(chalk.dim('\nTransitioning to build mode...'))
          interrupt.destroy()
          closeDb()
          await runOrchestratorCore({
            ...opts,
            mode: 'build',
            task: `Build according to the plan in ${artifactPath}: ${task}`,
          })
          return
        }
      }
      break
    }

    if (shouldSummarize(round, config.session.summarizeEvery)) {
      console.log(chalk.dim('\nSummarizing conversation...'))
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

export interface ResumeOpts {
  sessionId: string
  config: RubberDuckConfig
  noTmux?: boolean
}

export async function resumeOrchestrator(opts: ResumeOpts): Promise<void> {
  const { sessionId, config } = opts
  const db = getDb(getDbPath(config))
  const session = getSession(db, sessionId)

  if (!session) {
    console.error(chalk.red(`Session not found: ${sessionId}`))
    closeDb()
    return
  }

  if (session.status === 'converged') {
    console.log(chalk.green('Session already converged.'))
    closeDb()
    return
  }

  const lastB = getLastMessage(db, sessionId, 'codex')
  updateSession(db, sessionId, { status: 'active' })

  const artifactPath = session.artifact_path ?? resolveArtifactPath(session.mode, session.task)

  console.log(BANNER)
  console.log(chalk.dim(`Resuming session: ${session.id.slice(0, 8)}`))
  console.log(chalk.dim(`Mode: ${session.mode} | Round: ${session.rounds + 1}/${session.max_rounds}\n`))

  const agentA = new ClaudeAdapter()
  const agentB = new CodexAdapter()

  const promptVars = {
    artifact_path: artifactPath,
    review_target_path: session.mode === 'review' ? session.task : undefined,
    task: session.task,
    step_by_step: session.step_by_step,
  }
  const systemPromptA = writeSystemPromptFile(getSystemPrompt(session.mode, 'a', promptVars), 'claude')
  const systemPromptB = writeSystemPromptFile(getSystemPrompt(session.mode, 'b', promptVars), 'codex')

  const interrupt = new InterruptHandler(config.interrupt.hotkey)
  interrupt.registerAgents(agentA, agentB)

  let totalCost = session.total_cost_usd
  let claudeSid = session.claude_sid
  let codexSid = session.codex_sid
  let currentLastB = lastB?.content ?? null
  let converged = false
  const startRound = session.rounds + 1

  for (let round = startRound; round <= session.max_rounds; round++) {
    if (totalCost >= config.session.maxBudgetTotal) {
      console.log(chalk.red(`\nBudget limit reached ($${totalCost.toFixed(2)})`))
      updateSession(db, sessionId, { status: 'paused', rounds: round - 1, total_cost_usd: totalCost })
      break
    }

    let result: RoundResult
    try {
      result = await executeRound({
        db,
        sessionId,
        round,
        mode: session.mode,
        artifactPath,
        agentA,
        agentB,
        systemPromptA,
        systemPromptB,
        lastAgentBContent: currentLastB,
        claudeSid,
        codexSid,
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
    currentLastB = result.agent_b.content
    claudeSid = result.agent_a.session_id || claudeSid
    codexSid = result.agent_b.session_id || codexSid

    updateSession(db, sessionId, {
      rounds: round,
      total_cost_usd: totalCost,
      claude_sid: claudeSid || undefined,
      codex_sid: codexSid || undefined,
    })

    printRoundSummary(round, result.agent_a.cost_usd, result.agent_b.cost_usd, totalCost, config.session.maxBudgetTotal)

    if (result.consensus.reached) {
      converged = true
      console.log(CONSENSUS_BANNER)
      console.log(chalk.green(`  Consensus reached in round ${round}!`))
      console.log(chalk.dim(`  Total cost: $${totalCost.toFixed(2)}`))
      updateSession(db, sessionId, { status: 'converged', total_cost_usd: totalCost })
      break
    }

    if (shouldSummarize(round, config.session.summarizeEvery)) {
      try {
        await summarizeAndRotate(db, sessionId, round, config.consensus.model)
        claudeSid = null
        codexSid = null
      } catch {}
    }

    console.log()
  }

  if (!converged) {
    console.log(chalk.yellow(`\nMax rounds reached. Resume with: duck resume ${sessionId.slice(0, 8)}`))
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
