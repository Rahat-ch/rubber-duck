import type Database from 'better-sqlite3'
import { execa } from 'execa'
import { getMessages, insertMessage } from '../bus/messages.js'
import { updateSession } from '../bus/sessions.js'

export async function summarizeAndRotate(
  db: Database.Database,
  sessionId: string,
  round: number,
  model: string = 'sonnet',
): Promise<{ summary: string; newClaudeSid?: string; newCodexSid?: string }> {
  const messages = getMessages(db, sessionId)

  const transcript = messages.map(m =>
    `[Round ${m.round}] ${m.agent}: ${m.content.slice(0, 2000)}`
  ).join('\n\n---\n\n')

  const prompt = `Summarize this planning conversation between two AI agents. Capture:
1. All decisions made so far
2. Current state of the plan/review
3. Open questions or unresolved disagreements
4. What each agent's position is

Conversation:
${transcript}

Provide a concise but complete summary that can serve as context for continuing the conversation.`

  const result = await execa('claude', ['-p', '--output-format', 'json', '--model', model, prompt], {
    timeout: 60_000,
    reject: false,
  })

  let summary: string
  if (result.exitCode === 0) {
    try {
      const output = JSON.parse(result.stdout as string)
      summary = output.result ?? result.stdout as string
    } catch {
      summary = result.stdout as string
    }
  } else {
    summary = `[Summarization failed — continuing with full context. Error: ${result.stderr}]`
  }

  insertMessage(db, {
    session_id: sessionId,
    round,
    agent: 'claude',
    type: 'summary',
    content: summary,
  })

  updateSession(db, sessionId, {
    claude_sid: undefined,
    codex_sid: undefined,
  })

  return { summary }
}

export function shouldSummarize(round: number, summarizeEvery: number): boolean {
  return summarizeEvery > 0 && round > 1 && round % summarizeEvery === 0
}
