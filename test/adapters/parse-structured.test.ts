import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { BaseAdapter } from '../../src/adapters/base.js'
import type { AgentTurn, SendOpts } from '../../src/types.js'

class TestAdapter extends BaseAdapter {
  readonly name = 'claude' as const
  async send(_p: string, _o?: SendOpts): Promise<AgentTurn> { throw new Error('not implemented') }
  async resume(_s: string, _p: string, _o?: SendOpts): Promise<AgentTurn> { throw new Error('not implemented') }

  testParse(content: string) {
    return this.parseStructuredOutput(content)
  }
}

describe('parseStructuredOutput', () => {
  const adapter = new TestAdapter()

  it('parses structured output from claude fixture', () => {
    const fixture = JSON.parse(readFileSync(resolve('fixtures/claude-response.json'), 'utf-8'))
    const result = adapter.testParse(fixture.result)
    expect(result).not.toBeNull()
    expect(result!.decision).toBe('request_changes')
    expect(result!.blocking_issues).toEqual(['Missing authentication strategy'])
    expect(result!.artifact_hash).toBe('abc123def456')
    expect(result!.touched_files).toEqual(['plan.md'])
    expect(result!.summary).toBe('Added error handling, flagged missing auth strategy')
  })

  it('parses structured output from codex fixture', () => {
    const lines = readFileSync(resolve('fixtures/codex-response.jsonl'), 'utf-8').trim().split('\n')
    let content = ''
    for (const line of lines) {
      const event = JSON.parse(line)
      if (event.type === 'item.completed' && event.item?.type === 'agent_message') {
        content = event.item.text
      }
    }
    const result = adapter.testParse(content)
    expect(result).not.toBeNull()
    expect(result!.decision).toBe('approve')
    expect(result!.blocking_issues).toEqual([])
    expect(result!.artifact_hash).toBe('abc123def456')
  })

  it('returns null for content without json block', () => {
    const result = adapter.testParse('Just some text without any json block')
    expect(result).toBeNull()
  })

  it('returns null for invalid json in block', () => {
    const result = adapter.testParse('```json\n{invalid json}\n```')
    expect(result).toBeNull()
  })

  it('returns null for json missing required fields', () => {
    const result = adapter.testParse('```json\n{"decision": "approve"}\n```')
    expect(result).toBeNull()
  })

  it('picks the last json block when multiple exist', () => {
    const content = `Some text
\`\`\`json
{"decision": "propose", "blocking_issues": ["old"], "artifact_hash": "old", "touched_files": [], "summary": "old"}
\`\`\`
More text
\`\`\`json
{"decision": "approve", "blocking_issues": [], "artifact_hash": "new", "touched_files": ["plan.md"], "summary": "final"}
\`\`\``
    const result = adapter.testParse(content)
    expect(result).not.toBeNull()
    expect(result!.decision).toBe('approve')
    expect(result!.artifact_hash).toBe('new')
  })
})
