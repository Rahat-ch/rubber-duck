import type { AgentTurnOutput, ConsensusResult, SessionMode } from '../types.js'
import { reviewHasOpenIssues } from '../artifact/manager.js'

export function checkConsensus(
  outputA: AgentTurnOutput | null,
  outputB: AgentTurnOutput | null,
  mode: SessionMode,
  artifactPath?: string,
): ConsensusResult {
  if (!outputA || !outputB) {
    const missing = !outputA && !outputB ? 'both agents' : !outputA ? 'Agent A' : 'Agent B'
    return {
      reached: false,
      reason: `${missing} did not provide structured output`,
      blocking_issues: [`${missing}: missing structured output`],
    }
  }

  // Base rule: both approve, zero blockers, matching hash
  if (outputA.decision !== 'approve') {
    return {
      reached: false,
      reason: `Agent A decision: ${outputA.decision}`,
      blocking_issues: outputA.blocking_issues,
    }
  }
  if (outputB.decision !== 'approve') {
    return {
      reached: false,
      reason: `Agent B decision: ${outputB.decision}`,
      blocking_issues: outputB.blocking_issues,
    }
  }

  if (outputA.blocking_issues.length > 0) {
    return {
      reached: false,
      reason: 'Agent A has blocking issues despite approving',
      blocking_issues: outputA.blocking_issues,
    }
  }
  if (outputB.blocking_issues.length > 0) {
    return {
      reached: false,
      reason: 'Agent B has blocking issues despite approving',
      blocking_issues: outputB.blocking_issues,
    }
  }

  // Hash matching (skip if either is "auto" — build mode)
  if (outputA.artifact_hash !== 'auto' && outputB.artifact_hash !== 'auto') {
    if (outputA.artifact_hash !== outputB.artifact_hash) {
      return {
        reached: false,
        reason: `Artifact hash mismatch: ${outputA.artifact_hash.slice(0, 8)} vs ${outputB.artifact_hash.slice(0, 8)}`,
        blocking_issues: ['Agents are looking at different artifact versions'],
      }
    }
  }

  // Mode-specific checks
  if (mode === 'review' && artifactPath) {
    if (reviewHasOpenIssues(artifactPath)) {
      return {
        reached: false,
        reason: 'review.json still has open issues despite both agents approving',
        blocking_issues: ['Open issues remain in review.json'],
      }
    }
  }

  // Build mode verification gate is handled by the orchestrator after consensus passes

  return {
    reached: true,
    reason: 'Both agents approve with no blocking issues',
    blocking_issues: [],
  }
}
