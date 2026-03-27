import Database from 'better-sqlite3'
import { mkdirSync } from 'node:fs'
import { dirname } from 'node:path'

let db: Database.Database | null = null

export function getDb(dbPath: string): Database.Database {
  if (db) return db

  mkdirSync(dirname(dbPath), { recursive: true })
  db = new Database(dbPath)
  db.pragma('journal_mode = WAL')
  db.pragma('foreign_keys = ON')

  migrate(db)
  return db
}

export function closeDb(): void {
  if (db) {
    db.close()
    db = null
  }
}

function migrate(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS sessions (
      id TEXT PRIMARY KEY,
      task TEXT NOT NULL,
      mode TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'active',
      claude_sid TEXT,
      codex_sid TEXT,
      rounds INTEGER NOT NULL DEFAULT 0,
      max_rounds INTEGER NOT NULL DEFAULT 10,
      autonomy TEXT NOT NULL DEFAULT 'full',
      step_by_step INTEGER NOT NULL DEFAULT 0,
      worktree_path TEXT,
      worktree_branch TEXT,
      config TEXT,
      artifact_path TEXT,
      artifact_kind TEXT,
      total_cost_usd REAL NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS messages (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      session_id TEXT NOT NULL,
      round INTEGER NOT NULL,
      agent TEXT NOT NULL,
      type TEXT NOT NULL,
      content TEXT NOT NULL,
      structured_output TEXT,
      snapshot_id INTEGER,
      cost_usd REAL,
      tokens_in INTEGER,
      tokens_out INTEGER,
      duration_ms INTEGER,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS artifacts (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      session_id TEXT NOT NULL,
      round INTEGER NOT NULL,
      phase TEXT NOT NULL,
      kind TEXT NOT NULL,
      path TEXT NOT NULL,
      content TEXT,
      hash TEXT NOT NULL,
      git_commit TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE INDEX IF NOT EXISTS idx_messages_session ON messages(session_id, round);
    CREATE INDEX IF NOT EXISTS idx_artifacts_session ON artifacts(session_id, round, phase);
  `)
}
