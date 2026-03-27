import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { getDb, closeDb } from '../../src/bus/db.js'
import { createSession, getSession, updateSession, listSessions } from '../../src/bus/sessions.js'
import { insertMessage, getMessages, getLastMessage, getMessageCount } from '../../src/bus/messages.js'
import { insertArtifact, getArtifact, getLatestArtifact, getArtifactsBySession } from '../../src/bus/artifacts.js'
import { unlinkSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { randomUUID } from 'node:crypto'

const testDbPath = join(tmpdir(), `duck-test-${randomUUID()}.db`)

describe('bus', () => {
  let db: ReturnType<typeof getDb>

  beforeEach(() => {
    db = getDb(testDbPath)
  })

  afterEach(() => {
    closeDb()
    try { unlinkSync(testDbPath) } catch {}
    try { unlinkSync(testDbPath + '-wal') } catch {}
    try { unlinkSync(testDbPath + '-shm') } catch {}
  })

  describe('sessions', () => {
    it('creates and retrieves a session', () => {
      const session = createSession(db, {
        id: 'test-1',
        task: 'Design auth system',
        mode: 'plan',
        max_rounds: 10,
        autonomy: 'full',
        artifact_path: './plan.md',
        artifact_kind: 'plan',
      })
      expect(session.id).toBe('test-1')
      expect(session.task).toBe('Design auth system')
      expect(session.mode).toBe('plan')
      expect(session.status).toBe('active')
      expect(session.rounds).toBe(0)
    })

    it('updates session fields', () => {
      createSession(db, { id: 's-2', task: 'test', mode: 'plan', max_rounds: 5, autonomy: 'full' })
      updateSession(db, 's-2', { status: 'converged', rounds: 3, total_cost_usd: 1.5 })
      const updated = getSession(db, 's-2')!
      expect(updated.status).toBe('converged')
      expect(updated.rounds).toBe(3)
      expect(updated.total_cost_usd).toBe(1.5)
    })

    it('lists sessions', () => {
      createSession(db, { id: 's-a', task: 'a', mode: 'plan', max_rounds: 10, autonomy: 'full' })
      createSession(db, { id: 's-b', task: 'b', mode: 'review', max_rounds: 5, autonomy: 'checkpoints' })
      const all = listSessions(db)
      expect(all.length).toBe(2)
      const active = listSessions(db, 'active')
      expect(active.length).toBe(2)
    })
  })

  describe('messages', () => {
    it('inserts and retrieves messages', () => {
      createSession(db, { id: 'ms-1', task: 'test', mode: 'plan', max_rounds: 10, autonomy: 'full' })
      const id = insertMessage(db, {
        session_id: 'ms-1',
        round: 1,
        agent: 'claude',
        type: 'proposal',
        content: 'Here is my plan...',
        structured_output: '{"decision":"propose"}',
        cost_usd: 0.12,
        tokens_in: 100,
        tokens_out: 50,
        duration_ms: 5000,
      })
      expect(id).toBeGreaterThan(0)

      const msgs = getMessages(db, 'ms-1', 1)
      expect(msgs.length).toBe(1)
      expect(msgs[0].agent).toBe('claude')
      expect(msgs[0].content).toBe('Here is my plan...')
    })

    it('gets last message by agent', () => {
      createSession(db, { id: 'ms-2', task: 'test', mode: 'plan', max_rounds: 10, autonomy: 'full' })
      insertMessage(db, { session_id: 'ms-2', round: 1, agent: 'claude', type: 'proposal', content: 'first' })
      insertMessage(db, { session_id: 'ms-2', round: 1, agent: 'codex', type: 'critique', content: 'review' })
      insertMessage(db, { session_id: 'ms-2', round: 2, agent: 'claude', type: 'response', content: 'second' })

      const last = getLastMessage(db, 'ms-2', 'claude')!
      expect(last.content).toBe('second')
      expect(getMessageCount(db, 'ms-2')).toBe(3)
    })
  })

  describe('artifacts', () => {
    it('inserts and retrieves artifacts', () => {
      createSession(db, { id: 'ar-1', task: 'test', mode: 'plan', max_rounds: 10, autonomy: 'full' })
      const id = insertArtifact(db, {
        session_id: 'ar-1',
        round: 1,
        phase: 'pre_round',
        kind: 'plan',
        path: './plan.md',
        content: '# Plan\n\nInitial content',
        hash: 'abc123',
      })
      expect(id).toBeGreaterThan(0)

      const artifact = getArtifact(db, 'ar-1', 1, 'pre_round')!
      expect(artifact.content).toBe('# Plan\n\nInitial content')
      expect(artifact.hash).toBe('abc123')
    })

    it('gets latest artifact', () => {
      createSession(db, { id: 'ar-2', task: 'test', mode: 'plan', max_rounds: 10, autonomy: 'full' })
      insertArtifact(db, { session_id: 'ar-2', round: 1, phase: 'pre_round', kind: 'plan', path: './plan.md', content: 'v1', hash: 'h1' })
      insertArtifact(db, { session_id: 'ar-2', round: 1, phase: 'post_agent_a', kind: 'plan', path: './plan.md', content: 'v2', hash: 'h2' })
      insertArtifact(db, { session_id: 'ar-2', round: 1, phase: 'post_agent_b', kind: 'plan', path: './plan.md', content: 'v3', hash: 'h3' })

      const latest = getLatestArtifact(db, 'ar-2')!
      expect(latest.content).toBe('v3')
      expect(latest.hash).toBe('h3')
    })

    it('stores build-mode artifacts with git_commit and null content', () => {
      createSession(db, { id: 'ar-3', task: 'build', mode: 'build', max_rounds: 10, autonomy: 'full' })
      insertArtifact(db, {
        session_id: 'ar-3',
        round: 1,
        phase: 'pre_round',
        kind: 'build',
        path: '.duck-build/ar-3',
        content: null,
        hash: 'gitTreeHash123',
        git_commit: 'abc123def',
      })

      const artifact = getArtifact(db, 'ar-3', 1, 'pre_round')!
      expect(artifact.content).toBeNull()
      expect(artifact.git_commit).toBe('abc123def')
      expect(artifact.hash).toBe('gitTreeHash123')
    })

    it('lists all artifacts for a session', () => {
      createSession(db, { id: 'ar-4', task: 'test', mode: 'plan', max_rounds: 10, autonomy: 'full' })
      insertArtifact(db, { session_id: 'ar-4', round: 1, phase: 'pre_round', kind: 'plan', path: 'p', content: 'a', hash: 'h1' })
      insertArtifact(db, { session_id: 'ar-4', round: 1, phase: 'post_agent_a', kind: 'plan', path: 'p', content: 'b', hash: 'h2' })

      const all = getArtifactsBySession(db, 'ar-4')
      expect(all.length).toBe(2)
    })
  })
})
