import chalk from 'chalk'

const yellow = chalk.yellow
const orange = chalk.hex('#FFA500')

export const BANNER = `
${yellow('    __')}
${yellow('  >')}${orange('(o )')}${yellow('___')}
${yellow('   ( ._> /')}    ${chalk.bold('Rubber Duck')} v0.1.2
${yellow("    `---'")}     Two agents. One plan.
`

export const CONSENSUS_BANNER = `
${yellow('    __    __')}
${yellow('  >')}${orange('(o )')}${yellow('__')}${orange('(o )')}${yellow('>')}
${yellow('   ( ._>( ._>')}
${yellow("    `---'`---'")}
`

export const DUCK_CLAUDE = `${yellow('[')}${orange('>o)')}${yellow('  Claude]')}`
export const DUCK_CODEX = `${yellow('[')}${orange('o<)')}${yellow('  Codex ]')}`
export const DUCK_CONSENSUS = `${yellow('[')}>o) <o<)${yellow(']')}`
export const DUCK_QUACK = chalk.red('[!! QUACK]')
export const DUCK_BUDGET = `${yellow('[')}${orange('>o)')}${yellow('  $$$]')}`

export const PROMPT = chalk.yellow('[quack]> ')

export function roundHeader(n: number): string {
  const label = `--- Round ${n} `
  return chalk.dim(label + '-'.repeat(Math.max(0, 60 - label.length)))
}

export function agentStatus(agent: 'claude' | 'codex', msg: string, cost?: number, duration_ms?: number): string {
  const duck = agent === 'claude' ? DUCK_CLAUDE : DUCK_CODEX
  const costStr = cost != null ? chalk.dim(`  $${cost.toFixed(2)}`) : ''
  const timeStr = duration_ms != null ? chalk.dim(`  (${Math.round(duration_ms / 1000)}s)`) : ''
  return `  ${duck} ${msg}${costStr}${timeStr}`
}

export function consensusStatus(reached: boolean, reason: string): string {
  const icon = reached ? DUCK_CONSENSUS : chalk.dim('[====]')
  const label = reached ? chalk.green('Consensus!') : chalk.yellow('No consensus')
  return `  ${icon} ${label} ${chalk.dim('—')} ${reason}`
}
