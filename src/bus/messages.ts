import type Database from 'better-sqlite3'
import type { Message, AgentName, MessageType } from '../types.js'

export interface InsertMessageOpts {
  session_id: string
  round: number
  agent: AgentName | 'human'
  type: MessageType
  content: string
  structured_output?: string | null
  snapshot_id?: number | null
  cost_usd?: number | null
  tokens_in?: number | null
  tokens_out?: number | null
  duration_ms?: number | null
}

export function insertMessage(db: Database.Database, opts: InsertMessageOpts): number {
  const stmt = db.prepare(`
    INSERT INTO messages (session_id, round, agent, type, content, structured_output, snapshot_id, cost_usd, tokens_in, tokens_out, duration_ms)
    VALUES (@session_id, @round, @agent, @type, @content, @structured_output, @snapshot_id, @cost_usd, @tokens_in, @tokens_out, @duration_ms)
  `)
  const result = stmt.run({
    session_id: opts.session_id,
    round: opts.round,
    agent: opts.agent,
    type: opts.type,
    content: opts.content,
    structured_output: opts.structured_output ?? null,
    snapshot_id: opts.snapshot_id ?? null,
    cost_usd: opts.cost_usd ?? null,
    tokens_in: opts.tokens_in ?? null,
    tokens_out: opts.tokens_out ?? null,
    duration_ms: opts.duration_ms ?? null,
  })
  return Number(result.lastInsertRowid)
}

export function getMessages(db: Database.Database, sessionId: string, round?: number): Message[] {
  if (round !== undefined) {
    return db.prepare('SELECT * FROM messages WHERE session_id = ? AND round = ? ORDER BY id').all(sessionId, round) as Message[]
  }
  return db.prepare('SELECT * FROM messages WHERE session_id = ? ORDER BY id').all(sessionId) as Message[]
}

export function getLastMessage(db: Database.Database, sessionId: string, agent?: AgentName | 'human'): Message | null {
  if (agent) {
    return (db.prepare('SELECT * FROM messages WHERE session_id = ? AND agent = ? ORDER BY id DESC LIMIT 1').get(sessionId, agent) as Message) ?? null
  }
  return (db.prepare('SELECT * FROM messages WHERE session_id = ? ORDER BY id DESC LIMIT 1').get(sessionId) as Message) ?? null
}

export function getMessageCount(db: Database.Database, sessionId: string): number {
  const row = db.prepare('SELECT COUNT(*) as count FROM messages WHERE session_id = ?').get(sessionId) as { count: number }
  return row.count
}
