import { execSync } from 'node:child_process'
import { existsSync, rmSync } from 'node:fs'
import { resolve } from 'node:path'

export interface WorktreeInfo {
  path: string
  branch: string
}

export function createWorktree(sessionId: string, basePath: string = '.'): WorktreeInfo {
  const worktreePath = resolve(basePath, '.duck-build', sessionId)
  const branch = `duck-build-${sessionId.slice(0, 8)}`

  execSync(`git worktree add -b "${branch}" "${worktreePath}"`, { stdio: 'pipe', cwd: basePath })

  return { path: worktreePath, branch }
}

export function deleteWorktree(worktreePath: string, basePath: string = '.'): void {
  try {
    execSync(`git worktree remove "${worktreePath}" --force`, { stdio: 'pipe', cwd: basePath })
  } catch {
    if (existsSync(worktreePath)) {
      rmSync(worktreePath, { recursive: true, force: true })
      try {
        execSync('git worktree prune', { stdio: 'pipe', cwd: basePath })
      } catch {}
    }
  }
}

export function getGitTreeHash(worktreePath: string): string {
  execSync('git add -A', { stdio: 'pipe', cwd: worktreePath })
  const hash = execSync('git write-tree', { encoding: 'utf-8', cwd: worktreePath }).trim()
  return hash
}

export function checkpointCommit(worktreePath: string, message: string): string {
  execSync('git add -A', { stdio: 'pipe', cwd: worktreePath })

  try {
    execSync(`git commit -m "${message}" --allow-empty`, { stdio: 'pipe', cwd: worktreePath })
  } catch {}

  const sha = execSync('git rev-parse HEAD', { encoding: 'utf-8', cwd: worktreePath }).trim()
  return sha
}

export function rollbackToCommit(worktreePath: string, commitSha: string): void {
  execSync(`git reset --hard "${commitSha}"`, { stdio: 'pipe', cwd: worktreePath })
}

export function squashMerge(worktreePath: string, branch: string, basePath: string, message: string): void {
  execSync(`git merge --squash "${branch}"`, { stdio: 'pipe', cwd: basePath })
  execSync(`git commit -m "${message}"`, { stdio: 'pipe', cwd: basePath })
}

export function runVerifyCommands(worktreePath: string, commands: string[]): { passed: boolean; output: string } {
  const results: string[] = []

  for (const cmd of commands) {
    try {
      const output = execSync(cmd, { encoding: 'utf-8', cwd: worktreePath, timeout: 120_000 })
      results.push(`PASS: ${cmd}\n${output}`)
    } catch (err) {
      const output = (err as { stdout?: string; stderr?: string }).stdout ?? (err as { stderr?: string }).stderr ?? String(err)
      results.push(`FAIL: ${cmd}\n${output}`)
      return { passed: false, output: results.join('\n---\n') }
    }
  }

  return { passed: true, output: results.join('\n---\n') }
}
