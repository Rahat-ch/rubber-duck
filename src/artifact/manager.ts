import { readFileSync, writeFileSync, existsSync } from 'node:fs'
import { createHash } from 'node:crypto'
import type Database from 'better-sqlite3'
import type { SessionMode, ArtifactPhase } from '../types.js'
import { insertArtifact, getArtifact } from '../bus/artifacts.js'

export function hashFileContent(content: string): string {
  return createHash('sha256').update(content).digest('hex')
}

export function readArtifactFile(path: string): string {
  if (!existsSync(path)) return ''
  return readFileSync(path, 'utf-8')
}

export function writeArtifactFile(path: string, content: string): void {
  writeFileSync(path, content, 'utf-8')
}

export function snapshotArtifact(
  db: Database.Database,
  sessionId: string,
  round: number,
  phase: ArtifactPhase,
  kind: SessionMode,
  path: string,
): number {
  if (kind === 'build') {
    // build mode: handled separately via git commits
    throw new Error('Use snapshotBuildArtifact for build mode')
  }

  const content = readArtifactFile(path)
  const hash = hashFileContent(content)

  return insertArtifact(db, {
    session_id: sessionId,
    round,
    phase,
    kind,
    path,
    content,
    hash,
  })
}

export function rollbackArtifact(
  db: Database.Database,
  sessionId: string,
  round: number,
  phase: ArtifactPhase,
  targetPath: string,
): boolean {
  const artifact = getArtifact(db, sessionId, round, phase)
  if (!artifact || artifact.content === null) return false

  writeArtifactFile(targetPath, artifact.content)
  return true
}

export function initPlanArtifact(path: string, task: string): void {
  const content = `# Plan: ${task}\n\n_This plan is being collaboratively developed by two AI agents._\n`
  writeArtifactFile(path, content)
}

export function initReviewArtifact(path: string, target: string): void {
  const content = JSON.stringify({
    target,
    summary: '',
    issues: [],
    recommendations: [],
  }, null, 2)
  writeArtifactFile(path, content)
}

export interface ReviewIssue {
  id: string
  severity: string
  file: string
  line: number
  description: string
  status: string
  resolution: string
}

export function parseReviewArtifact(path: string): { issues: ReviewIssue[] } | null {
  try {
    const content = readArtifactFile(path)
    if (!content) return null
    return JSON.parse(content)
  } catch {
    return null
  }
}

export function reviewHasOpenIssues(path: string): boolean {
  const review = parseReviewArtifact(path)
  if (!review) return false
  return review.issues.some((i: ReviewIssue) => i.status === 'open')
}
