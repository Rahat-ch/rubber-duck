import { execa } from 'execa'
import type { AgentTurnOutput, ConsensusResult } from '../types.js'

export async function judgeConcensus(
  outputA: AgentTurnOutput,
  outputB: AgentTurnOutput,
  model: string = 'sonnet',
): Promise<ConsensusResult> {
  const prompt = `Two AI agents are collaborating. Determine if they have reached consensus.

Agent A output:
- Decision: ${outputA.decision}
- Blocking issues: ${JSON.stringify(outputA.blocking_issues)}
- Summary: ${outputA.summary}

Agent B output:
- Decision: ${outputB.decision}
- Blocking issues: ${JSON.stringify(outputB.blocking_issues)}
- Summary: ${outputB.summary}

There is a contradiction (e.g., agent says "approve" but lists blocking issues).
Resolve it. Reply with ONLY a JSON object:
{"reached": true/false, "reason": "explanation", "blocking_issues": ["list or empty"]}`

  try {
    const result = await execa('claude', [
      '-p', '--output-format', 'json', '--model', model,
    ], {
      input: prompt,
      timeout: 30_000,
      reject: false,
    })

    if (result.exitCode !== 0) {
      return { reached: false, reason: 'Judge call failed', blocking_issues: ['LLM judge error'] }
    }

    const output = JSON.parse(result.stdout as string)
    const text = output.result ?? ''
    const jsonMatch = text.match(/\{[\s\S]*\}/)
    if (jsonMatch) {
      const parsed = JSON.parse(jsonMatch[0])
      return {
        reached: Boolean(parsed.reached),
        reason: parsed.reason ?? 'Judge decision',
        blocking_issues: parsed.blocking_issues ?? [],
      }
    }
  } catch {}

  return { reached: false, reason: 'Could not parse judge response', blocking_issues: ['Judge parse error'] }
}
