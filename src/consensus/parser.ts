import type { AgentTurnOutput } from '../types.js'

export function parseStructuredOutput(content: string): AgentTurnOutput | null {
  const jsonBlockRegex = /```json\s*\n([\s\S]*?)\n\s*```/g
  let lastMatch: RegExpExecArray | null = null
  let match: RegExpExecArray | null
  while ((match = jsonBlockRegex.exec(content)) !== null) {
    lastMatch = match
  }
  if (!lastMatch) return null

  try {
    const parsed = JSON.parse(lastMatch[1])
    if (
      typeof parsed.decision === 'string' &&
      ['approve', 'request_changes', 'propose'].includes(parsed.decision) &&
      Array.isArray(parsed.blocking_issues) &&
      typeof parsed.artifact_hash === 'string' &&
      Array.isArray(parsed.touched_files) &&
      typeof parsed.summary === 'string'
    ) {
      return parsed as AgentTurnOutput
    }
  } catch {}
  return null
}

export function syntheticRequestChanges(reason: string): AgentTurnOutput {
  return {
    decision: 'request_changes',
    blocking_issues: [reason],
    artifact_hash: '',
    touched_files: [],
    summary: reason,
  }
}
