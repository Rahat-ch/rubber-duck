import type Database from 'better-sqlite3'
import type { AgentAdapter, AgentTurn, AgentTurnOutput, SessionMode, RoundResult } from '../types.js'
import { snapshotArtifact, rollbackArtifact, readArtifactFile, hashFileContent } from '../artifact/manager.js'
import { insertMessage } from '../bus/messages.js'
import { checkConsensus } from '../consensus/detector.js'
import { syntheticRequestChanges } from '../consensus/parser.js'
import { wrapTurnPrompt } from '../adapters/prompts.js'
import * as ducks from '../ui/ducks.js'

export interface RoundOpts {
  db: Database.Database
  sessionId: string
  round: number
  mode: SessionMode
  artifactPath: string
  agentA: AgentAdapter
  agentB: AgentAdapter
  systemPromptA: string
  systemPromptB: string
  lastAgentBContent: string | null
  claudeSid?: string | null
  codexSid?: string | null
  humanMessage?: string
  cwd?: string
  timeoutMs?: number
  maxBudgetPerTurn?: number
}

export async function executeRound(opts: RoundOpts): Promise<RoundResult> {
  const { db, sessionId, round, mode, artifactPath, agentA, agentB } = opts

  console.log(ducks.roundHeader(round))

  // 1. PRE-ROUND: snapshot artifact
  const preSnapshotId = snapshotArtifact(db, sessionId, round, 'pre_round', mode, artifactPath)

  // 2. AGENT A TURN
  let turnA: AgentTurn
  const promptA = wrapTurnPrompt(opts.lastAgentBContent, round, opts.humanMessage)
  const sendOptsA = {
    cwd: opts.cwd,
    timeout_ms: opts.timeoutMs,
    maxBudget: opts.maxBudgetPerTurn,
    systemPrompt: opts.systemPromptA,
  }

  try {
    turnA = opts.claudeSid
      ? await opts.agentA.resume(opts.claudeSid, promptA, sendOptsA)
      : await opts.agentA.send(promptA, sendOptsA)
  } catch (err) {
    console.log(ducks.agentStatus('claude', `Failed: ${(err as Error).message}`))
    rollbackArtifact(db, sessionId, round, 'pre_round', artifactPath)
    throw err
  }

  // Post-A: snapshot, then store message
  const postASnapshotId = snapshotArtifact(db, sessionId, round, 'post_agent_a', mode, artifactPath)

  const structuredA = turnA.structured ?? syntheticRequestChanges('Agent did not provide structured output')

  insertMessage(db, {
    session_id: sessionId,
    round,
    agent: 'claude',
    type: 'proposal',
    content: turnA.content,
    structured_output: JSON.stringify(structuredA),
    snapshot_id: postASnapshotId,
    cost_usd: turnA.cost_usd,
    tokens_in: turnA.tokens_in,
    tokens_out: turnA.tokens_out,
    duration_ms: turnA.duration_ms,
  })

  console.log(ducks.agentStatus('claude', structuredA.summary || 'Completed turn', turnA.cost_usd, turnA.duration_ms))

  // 3. AGENT B TURN
  let turnB: AgentTurn
  const promptB = wrapTurnPrompt(turnA.content, round)
  const sendOptsB = {
    cwd: opts.cwd,
    timeout_ms: opts.timeoutMs,
    maxBudget: opts.maxBudgetPerTurn,
    systemPrompt: opts.systemPromptB,
  }

  try {
    turnB = opts.codexSid
      ? await opts.agentB.resume(opts.codexSid, promptB, sendOptsB)
      : await opts.agentB.send(promptB, sendOptsB)
  } catch (err) {
    console.log(ducks.agentStatus('codex', `Failed: ${(err as Error).message}`))
    rollbackArtifact(db, sessionId, round, 'post_agent_a', artifactPath)
    throw err
  }

  // Post-B: snapshot, then store message
  const postBSnapshotId = snapshotArtifact(db, sessionId, round, 'post_agent_b', mode, artifactPath)

  const structuredB = turnB.structured ?? syntheticRequestChanges('Agent did not provide structured output')

  // For build mode: orchestrator computes artifact hash if agent said "auto"
  if (mode !== 'build') {
    const currentContent = readArtifactFile(artifactPath)
    const currentHash = hashFileContent(currentContent)
    if (structuredA.artifact_hash === 'auto') structuredA.artifact_hash = currentHash
    if (structuredB.artifact_hash === 'auto') structuredB.artifact_hash = currentHash
  }

  insertMessage(db, {
    session_id: sessionId,
    round,
    agent: 'codex',
    type: 'critique',
    content: turnB.content,
    structured_output: JSON.stringify(structuredB),
    snapshot_id: postBSnapshotId,
    cost_usd: turnB.cost_usd,
    tokens_in: turnB.tokens_in,
    tokens_out: turnB.tokens_out,
    duration_ms: turnB.duration_ms,
  })

  console.log(ducks.agentStatus('codex', structuredB.summary || 'Completed turn', turnB.cost_usd, turnB.duration_ms))

  // 4. POST-ROUND: consensus check
  const consensus = checkConsensus(structuredA, structuredB, mode, artifactPath)
  console.log(ducks.consensusStatus(consensus.reached, consensus.reason))

  return {
    round,
    agent_a: turnA,
    agent_b: turnB,
    consensus,
    cost_usd: (turnA.cost_usd || 0) + (turnB.cost_usd || 0),
  }
}
