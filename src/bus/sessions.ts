import type Database from 'better-sqlite3'
import type { Session, SessionMode, SessionStatus, AutonomyLevel } from '../types.js'

export interface CreateSessionOpts {
  id: string
  task: string
  mode: SessionMode
  max_rounds: number
  autonomy: AutonomyLevel
  step_by_step?: boolean
  worktree_path?: string
  worktree_branch?: string
  config?: string
  artifact_path?: string
  artifact_kind?: SessionMode
}

export function createSession(db: Database.Database, opts: CreateSessionOpts): Session {
  const stmt = db.prepare(`
    INSERT INTO sessions (id, task, mode, max_rounds, autonomy, step_by_step, worktree_path, worktree_branch, config, artifact_path, artifact_kind)
    VALUES (@id, @task, @mode, @max_rounds, @autonomy, @step_by_step, @worktree_path, @worktree_branch, @config, @artifact_path, @artifact_kind)
  `)
  stmt.run({
    ...opts,
    step_by_step: opts.step_by_step ? 1 : 0,
    worktree_path: opts.worktree_path ?? null,
    worktree_branch: opts.worktree_branch ?? null,
    config: opts.config ?? null,
    artifact_path: opts.artifact_path ?? null,
    artifact_kind: opts.artifact_kind ?? null,
  })
  return getSession(db, opts.id)!
}

export function getSession(db: Database.Database, id: string): Session | null {
  const row = db.prepare('SELECT * FROM sessions WHERE id = ?').get(id) as Record<string, unknown> | undefined
  if (!row) return null
  return {
    ...row,
    step_by_step: Boolean(row.step_by_step),
  } as unknown as Session
}

export function updateSession(db: Database.Database, id: string, updates: Partial<Pick<Session, 'status' | 'claude_sid' | 'codex_sid' | 'rounds' | 'total_cost_usd'>>): void {
  const fields: string[] = []
  const values: Record<string, unknown> = { id }

  for (const [key, val] of Object.entries(updates)) {
    if (val !== undefined) {
      fields.push(`${key} = @${key}`)
      values[key] = val
    }
  }

  if (fields.length === 0) return
  fields.push("updated_at = datetime('now')")

  db.prepare(`UPDATE sessions SET ${fields.join(', ')} WHERE id = @id`).run(values)
}

export function listSessions(db: Database.Database, status?: SessionStatus): Session[] {
  const query = status
    ? 'SELECT * FROM sessions WHERE status = ? ORDER BY updated_at DESC'
    : 'SELECT * FROM sessions ORDER BY updated_at DESC'
  const rows = (status ? db.prepare(query).all(status) : db.prepare(query).all()) as Record<string, unknown>[]
  return rows.map(row => ({ ...row, step_by_step: Boolean(row.step_by_step) }) as unknown as Session)
}
