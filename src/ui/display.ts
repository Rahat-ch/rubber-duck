import chalk from 'chalk'
import type { Session, Message } from '../types.js'

export function displaySessionStatus(sessions: Session[]): void {
  if (sessions.length === 0) {
    console.log(chalk.dim('No sessions found.'))
    return
  }

  for (const s of sessions) {
    const status = colorStatus(s.status)
    const cost = chalk.dim(`$${s.total_cost_usd.toFixed(2)}`)
    const rounds = chalk.dim(`${s.rounds}/${s.max_rounds} rounds`)
    console.log(`  ${status} ${chalk.bold(s.id.slice(0, 8))} ${s.mode} — ${s.task.slice(0, 60)}`)
    console.log(`    ${rounds}  ${cost}  ${chalk.dim(s.created_at)}`)
  }
}

export function displaySessionLog(messages: Message[], sessionId: string): void {
  console.log(chalk.bold(`Session: ${sessionId}\n`))

  let currentRound = -1
  for (const m of messages) {
    if (m.round !== currentRound) {
      currentRound = m.round
      console.log(chalk.dim(`--- Round ${currentRound} ---`))
    }

    const agentColor = m.agent === 'claude' ? chalk.blue : m.agent === 'codex' ? chalk.green : chalk.yellow
    const costStr = m.cost_usd != null ? chalk.dim(` $${m.cost_usd.toFixed(2)}`) : ''
    console.log(`${agentColor(`[${m.agent}]`)} ${m.type}${costStr}`)
    console.log(chalk.dim(m.content.slice(0, 200) + (m.content.length > 200 ? '...' : '')))
    console.log()
  }
}

export function exportSessionTranscript(messages: Message[], session: Session): string {
  const lines: string[] = [
    `# Rubber Duck Session: ${session.id}`,
    ``,
    `**Task:** ${session.task}`,
    `**Mode:** ${session.mode}`,
    `**Status:** ${session.status}`,
    `**Rounds:** ${session.rounds}/${session.max_rounds}`,
    `**Total cost:** $${session.total_cost_usd.toFixed(2)}`,
    `**Created:** ${session.created_at}`,
    ``,
    `---`,
    ``,
  ]

  let currentRound = -1
  for (const m of messages) {
    if (m.round !== currentRound) {
      currentRound = m.round
      lines.push(`## Round ${currentRound}`, ``)
    }

    const costStr = m.cost_usd != null ? ` ($${m.cost_usd.toFixed(2)})` : ''
    lines.push(`### ${m.agent} — ${m.type}${costStr}`, ``)
    lines.push(m.content, ``)
  }

  return lines.join('\n')
}

function colorStatus(status: string): string {
  switch (status) {
    case 'active': return chalk.cyan('[active]')
    case 'converged': return chalk.green('[converged]')
    case 'paused': return chalk.yellow('[paused]')
    case 'failed': return chalk.red('[failed]')
    case 'cancelled': return chalk.gray('[cancelled]')
    default: return chalk.dim(`[${status}]`)
  }
}
