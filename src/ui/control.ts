import { createInterface } from 'node:readline'
import chalk from 'chalk'
import { PROMPT } from './ducks.js'

export function printToControl(text: string): void {
  // In tmux mode this writes to the control pane
  // In non-tmux mode this just prints to stdout
  process.stdout.write(text + '\n')
}

export async function promptUser(question: string): Promise<string> {
  const rl = createInterface({ input: process.stdin, output: process.stdout })
  return new Promise(resolve => {
    rl.question(`${PROMPT}${question} `, (answer) => {
      rl.close()
      resolve(answer.trim())
    })
  })
}

export function printRoundSummary(round: number, costA: number, costB: number, totalCost: number, budget: number): void {
  const remaining = budget - totalCost
  printToControl(chalk.dim(`  Cost this round: $${(costA + costB).toFixed(2)} | Total: $${totalCost.toFixed(2)} | Remaining: $${remaining.toFixed(2)}`))
}

export function printDiffSummary(diffOutput: string): void {
  if (!diffOutput.trim()) return
  printToControl(chalk.dim('\n  Files changed:'))
  for (const line of diffOutput.trim().split('\n')) {
    printToControl(chalk.dim(`    ${line}`))
  }
}
