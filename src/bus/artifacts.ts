import type Database from 'better-sqlite3'
import type { Artifact, ArtifactPhase, SessionMode } from '../types.js'

export interface InsertArtifactOpts {
  session_id: string
  round: number
  phase: ArtifactPhase
  kind: SessionMode
  path: string
  content?: string | null
  hash: string
  git_commit?: string | null
}

export function insertArtifact(db: Database.Database, opts: InsertArtifactOpts): number {
  const stmt = db.prepare(`
    INSERT INTO artifacts (session_id, round, phase, kind, path, content, hash, git_commit)
    VALUES (@session_id, @round, @phase, @kind, @path, @content, @hash, @git_commit)
  `)
  const result = stmt.run({
    session_id: opts.session_id,
    round: opts.round,
    phase: opts.phase,
    kind: opts.kind,
    path: opts.path,
    content: opts.content ?? null,
    hash: opts.hash,
    git_commit: opts.git_commit ?? null,
  })
  return Number(result.lastInsertRowid)
}

export function getArtifact(db: Database.Database, sessionId: string, round: number, phase: ArtifactPhase): Artifact | null {
  return (db.prepare('SELECT * FROM artifacts WHERE session_id = ? AND round = ? AND phase = ? ORDER BY id DESC LIMIT 1')
    .get(sessionId, round, phase) as Artifact) ?? null
}

export function getLatestArtifact(db: Database.Database, sessionId: string): Artifact | null {
  return (db.prepare('SELECT * FROM artifacts WHERE session_id = ? ORDER BY id DESC LIMIT 1')
    .get(sessionId) as Artifact) ?? null
}

export function getArtifactById(db: Database.Database, id: number): Artifact | null {
  return (db.prepare('SELECT * FROM artifacts WHERE id = ?').get(id) as Artifact) ?? null
}

export function getArtifactsBySession(db: Database.Database, sessionId: string): Artifact[] {
  return db.prepare('SELECT * FROM artifacts WHERE session_id = ? ORDER BY id').all(sessionId) as Artifact[]
}
