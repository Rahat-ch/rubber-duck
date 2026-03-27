import { Command } from 'commander'
import { writeFileSync } from 'node:fs'
import { loadConfig, getDbPath } from '../src/config.js'
import { BANNER } from '../src/ui/ducks.js'
import { runOrchestrator } from '../src/orchestrator/orchestrator.js'
import { getDb, closeDb } from '../src/bus/db.js'
import { listSessions, getSession } from '../src/bus/sessions.js'
import { getMessages } from '../src/bus/messages.js'
import { displaySessionStatus, displaySessionLog, exportSessionTranscript } from '../src/ui/display.js'
import type { SessionMode } from '../src/types.js'

const program = new Command()

program
  .name('duck')
  .description('Rubber Duck — dual-agent AI orchestrator')
  .version('0.1.2')
  .hook('preAction', (thisCommand) => {
    // Only show banner for non-session commands (status, log, export)
    const cmd = thisCommand.args?.[0]
    if (['status', 'log', 'export'].includes(cmd as string)) {
      console.log(BANNER)
    }
  })

program
  .command('plan')
  .description('Start a planning session — both agents converge on plan.md')
  .argument('<task>', 'Task description')
  .option('-r, --rounds <n>', 'Max rounds', '10')
  .option('-a, --autonomy <mode>', 'Autonomy level: full | checkpoints | approval', 'full')
  .option('--claude-model <model>', 'Override Claude model')
  .option('--codex-model <model>', 'Override Codex model')
  .option('--layout <dir>', 'Tmux layout: horizontal | vertical', 'horizontal')
  .option('--no-tmux', 'Run without tmux')
  .option('--internal', 'Internal: running inside tmux pane')
  .option('--tmux-session <name>', 'Internal: tmux session name')
  .option('--plan-file <path>', 'Custom plan file path')
  .option('--budget <usd>', 'Max session budget in USD', '10')
  .option('-v, --verbose', 'Verbose output')
  .action(async (task: string, opts: Record<string, string>) => {
    await runSession('plan', task, opts)
  })

program
  .command('review')
  .description('Both agents review code, converge on review.json')
  .argument('<path>', 'Path to review')
  .option('-r, --rounds <n>', 'Max rounds', '10')
  .option('-a, --autonomy <mode>', 'Autonomy level', 'full')
  .option('--claude-model <model>', 'Override Claude model')
  .option('--codex-model <model>', 'Override Codex model')
  .option('--budget <usd>', 'Max session budget in USD', '10')
  .option('--internal', 'Internal: running inside tmux pane')
  .option('--tmux-session <name>', 'Internal: tmux session name')
  .option('-v, --verbose', 'Verbose output')
  .action(async (path: string, opts: Record<string, string>) => {
    await runSession('review', path, opts)
  })

program
  .command('build')
  .description('One agent builds (in worktree), one reviews (readonly)')
  .argument('<task>', 'Build task description')
  .option('--step-by-step', 'Atomic: review after each piece')
  .option('-r, --rounds <n>', 'Max rounds', '10')
  .option('-a, --autonomy <mode>', 'Autonomy level', 'full')
  .option('--claude-model <model>', 'Override Claude model')
  .option('--codex-model <model>', 'Override Codex model')
  .option('--budget <usd>', 'Max session budget in USD', '10')
  .option('--internal', 'Internal: running inside tmux pane')
  .option('--tmux-session <name>', 'Internal: tmux session name')
  .option('-v, --verbose', 'Verbose output')
  .action(async (task: string, opts: Record<string, string>) => {
    await runSession('build', task, opts)
  })

program
  .command('resume')
  .description('Resume a paused/interrupted session')
  .argument('<id>', 'Session ID')
  .action(async (id: string) => {
    const config = loadConfig()
    const db = getDb(getDbPath(config))
    const session = getSession(db, id) ?? getSession(db, findSessionByPrefix(db, id))
    if (!session) {
      console.error(`Session not found: ${id}`)
      process.exit(1)
    }
    console.log(`Resuming session ${session.id} (round ${session.rounds + 1})...`)
    await runOrchestrator({
      mode: session.mode,
      task: session.task,
      config,
      stepByStep: session.step_by_step,
    })
    closeDb()
  })

program
  .command('status')
  .description('Show active/recent sessions')
  .action(async () => {
    const config = loadConfig()
    const db = getDb(getDbPath(config))
    const sessions = listSessions(db)
    displaySessionStatus(sessions)
    closeDb()
  })

program
  .command('log')
  .description('Show message history for a session')
  .argument('<id>', 'Session ID')
  .action(async (id: string) => {
    const config = loadConfig()
    const db = getDb(getDbPath(config))
    const session = getSession(db, id) ?? getSession(db, findSessionByPrefix(db, id))
    if (!session) {
      console.error(`Session not found: ${id}`)
      process.exit(1)
    }
    const messages = getMessages(db, session.id)
    displaySessionLog(messages, session.id)
    closeDb()
  })

program
  .command('export')
  .description('Export session transcript to markdown')
  .argument('<id>', 'Session ID')
  .option('-o, --output <path>', 'Output file path')
  .action(async (id: string, opts: Record<string, string>) => {
    const config = loadConfig()
    const db = getDb(getDbPath(config))
    const session = getSession(db, id) ?? getSession(db, findSessionByPrefix(db, id))
    if (!session) {
      console.error(`Session not found: ${id}`)
      process.exit(1)
    }
    const messages = getMessages(db, session.id)
    const transcript = exportSessionTranscript(messages, session)
    const outPath = opts.output ?? `duck-export-${session.id.slice(0, 8)}.md`
    writeFileSync(outPath, transcript)
    console.log(`Exported to ${outPath}`)
    closeDb()
  })

function findSessionByPrefix(db: ReturnType<typeof getDb>, prefix: string): string {
  const sessions = listSessions(db)
  const match = sessions.find(s => s.id.startsWith(prefix))
  return match?.id ?? prefix
}

async function runSession(mode: SessionMode, taskOrPath: string, opts: Record<string, unknown>) {
  const config = loadConfig({
    session: {
      maxRounds: opts.rounds ? parseInt(String(opts.rounds)) : undefined,
      autonomy: opts.autonomy as string | undefined,
      maxBudgetTotal: opts.budget ? parseFloat(String(opts.budget)) : undefined,
    },
    claude: { model: opts.claudeModel as string | undefined },
    codex: { model: opts.codexModel as string | undefined },
    tmux: { layout: opts.layout as string | undefined },
  })

  await runOrchestrator({
    mode,
    task: taskOrPath,
    config,
    stepByStep: Boolean(opts.stepByStep),
    noTmux: !opts.tmux,
    _internal: Boolean(opts.internal),
    _tmuxSessionName: opts.tmuxSession as string | undefined,
  })
}

program.parse()
