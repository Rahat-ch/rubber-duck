import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { checkConsensus } from '../../src/consensus/detector.js'
import { writeFileSync, unlinkSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { randomUUID } from 'node:crypto'
import type { AgentTurnOutput } from '../../src/types.js'

function makeOutput(overrides: Partial<AgentTurnOutput> = {}): AgentTurnOutput {
  return {
    decision: 'approve',
    blocking_issues: [],
    artifact_hash: 'abc123',
    touched_files: ['plan.md'],
    summary: 'test',
    ...overrides,
  }
}

describe('checkConsensus', () => {
  it('returns true when both approve with matching hash', () => {
    const result = checkConsensus(makeOutput(), makeOutput(), 'plan')
    expect(result.reached).toBe(true)
    expect(result.blocking_issues).toEqual([])
  })

  it('returns false when agent A has request_changes', () => {
    const result = checkConsensus(
      makeOutput({ decision: 'request_changes', blocking_issues: ['needs work'] }),
      makeOutput(),
      'plan'
    )
    expect(result.reached).toBe(false)
    expect(result.blocking_issues).toEqual(['needs work'])
  })

  it('returns false when agent B has request_changes', () => {
    const result = checkConsensus(
      makeOutput(),
      makeOutput({ decision: 'request_changes', blocking_issues: ['not ready'] }),
      'plan'
    )
    expect(result.reached).toBe(false)
  })

  it('returns false when hashes mismatch', () => {
    const result = checkConsensus(
      makeOutput({ artifact_hash: 'hash1' }),
      makeOutput({ artifact_hash: 'hash2' }),
      'plan'
    )
    expect(result.reached).toBe(false)
    expect(result.reason).toContain('hash mismatch')
  })

  it('skips hash check when either is "auto" (build mode)', () => {
    const result = checkConsensus(
      makeOutput({ artifact_hash: 'auto' }),
      makeOutput({ artifact_hash: 'auto' }),
      'build'
    )
    expect(result.reached).toBe(true)
  })

  it('returns false when agent A approves but has blocking issues', () => {
    const result = checkConsensus(
      makeOutput({ blocking_issues: ['leftover issue'] }),
      makeOutput(),
      'plan'
    )
    expect(result.reached).toBe(false)
    expect(result.reason).toContain('blocking issues despite approving')
  })

  it('returns false when structured output is null', () => {
    const result = checkConsensus(null, makeOutput(), 'plan')
    expect(result.reached).toBe(false)
    expect(result.reason).toContain('structured output')
  })

  it('returns false for review mode with open issues', () => {
    const dir = join(tmpdir(), `duck-test-${randomUUID()}`)
    mkdirSync(dir, { recursive: true })
    const reviewPath = join(dir, 'review.json')
    writeFileSync(reviewPath, JSON.stringify({
      target: 'src/',
      summary: 'test',
      issues: [{ id: 'R1', severity: 'high', file: 'x.ts', line: 1, description: 'bug', status: 'open', resolution: '' }],
      recommendations: [],
    }))

    const result = checkConsensus(makeOutput(), makeOutput(), 'review', reviewPath)
    expect(result.reached).toBe(false)
    expect(result.blocking_issues).toContain('Open issues remain in review.json')

    unlinkSync(reviewPath)
  })

  it('returns true for review mode when all issues resolved', () => {
    const dir = join(tmpdir(), `duck-test-${randomUUID()}`)
    mkdirSync(dir, { recursive: true })
    const reviewPath = join(dir, 'review.json')
    writeFileSync(reviewPath, JSON.stringify({
      target: 'src/',
      summary: 'test',
      issues: [{ id: 'R1', severity: 'high', file: 'x.ts', line: 1, description: 'bug', status: 'resolved', resolution: 'fixed' }],
      recommendations: [],
    }))

    const result = checkConsensus(makeOutput(), makeOutput(), 'review', reviewPath)
    expect(result.reached).toBe(true)

    unlinkSync(reviewPath)
  })
})
