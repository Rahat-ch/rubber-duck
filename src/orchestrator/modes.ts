import type Database from 'better-sqlite3'
import type { SessionMode } from '../types.js'
import { insertArtifact } from '../bus/artifacts.js'
import { checkpointCommit, getGitTreeHash, rollbackToCommit, runVerifyCommands } from '../worktree/manager.js'
import chalk from 'chalk'

export function snapshotBuildArtifact(
  db: Database.Database,
  sessionId: string,
  round: number,
  phase: 'pre_round' | 'post_agent_a' | 'post_agent_b',
  worktreePath: string,
): number {
  const message = `[duck] ${phase} round-${round}`
  const commitSha = checkpointCommit(worktreePath, message)
  const treeHash = getGitTreeHash(worktreePath)

  return insertArtifact(db, {
    session_id: sessionId,
    round,
    phase,
    kind: 'build',
    path: worktreePath,
    content: null,
    hash: treeHash,
    git_commit: commitSha,
  })
}

export function rollbackBuildArtifact(worktreePath: string, commitSha: string): void {
  rollbackToCommit(worktreePath, commitSha)
}

export function runBuildVerificationGate(worktreePath: string, commands: string[]): { passed: boolean; output: string } {
  if (commands.length === 0) {
    return { passed: true, output: 'No verification commands configured' }
  }

  console.log(chalk.dim('\nRunning verification gate...'))
  const result = runVerifyCommands(worktreePath, commands)

  if (result.passed) {
    console.log(chalk.green('  Verification gate passed'))
  } else {
    console.log(chalk.red('  Verification gate failed'))
    console.log(chalk.dim(result.output.slice(0, 500)))
  }

  return result
}
