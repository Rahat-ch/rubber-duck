import { z } from 'zod/v4'
import { readFileSync, existsSync } from 'node:fs'
import { resolve, join } from 'node:path'
import { homedir } from 'node:os'

const AgentConfigSchema = z.object({
  model: z.string().optional(),
  maxBudgetPerTurn: z.number().positive().optional(),
  systemPromptExtra: z.string().optional(),
})

const ClaudeConfigSchema = AgentConfigSchema.extend({
  permissionMode: z.string().optional(),
})

const CodexConfigSchema = AgentConfigSchema.extend({
  sandbox: z.string().optional(),
})

const SessionConfigSchema = z.object({
  maxRounds: z.number().int().positive().optional(),
  autonomy: z.enum(['full', 'checkpoints', 'approval']).optional(),
  checkpointEvery: z.number().int().positive().optional(),
  timeoutPerTurn_ms: z.number().int().positive().optional(),
  summarizeEvery: z.number().int().positive().optional(),
  maxBudgetTotal: z.number().positive().optional(),
})

const ConsensusConfigSchema = z.object({
  model: z.string().optional(),
  minRounds: z.number().int().positive().optional(),
})

const BuildConfigSchema = z.object({
  verifyCommands: z.array(z.string()).optional(),
})

const InterruptConfigSchema = z.object({
  hotkey: z.string().optional(),
})

const TmuxConfigSchema = z.object({
  layout: z.enum(['horizontal', 'vertical']).optional(),
})

const DbConfigSchema = z.object({
  path: z.string().optional(),
})

export const ConfigSchema = z.object({
  claude: ClaudeConfigSchema.optional(),
  codex: CodexConfigSchema.optional(),
  session: SessionConfigSchema.optional(),
  consensus: ConsensusConfigSchema.optional(),
  build: BuildConfigSchema.optional(),
  interrupt: InterruptConfigSchema.optional(),
  tmux: TmuxConfigSchema.optional(),
  db: DbConfigSchema.optional(),
})

type RawConfig = z.infer<typeof ConfigSchema>

export interface RubberDuckConfig {
  claude: { model?: string; permissionMode?: string; maxBudgetPerTurn: number; systemPromptExtra?: string }
  codex: { model?: string; sandbox?: string; maxBudgetPerTurn: number; systemPromptExtra?: string }
  session: { maxRounds: number; autonomy: 'full' | 'checkpoints' | 'approval'; checkpointEvery: number; timeoutPerTurn_ms: number; summarizeEvery: number; maxBudgetTotal: number }
  consensus: { model: string; minRounds: number }
  build: { verifyCommands: string[] }
  interrupt: { hotkey: string }
  tmux: { layout: 'horizontal' | 'vertical' }
  db: { path: string }
}

const DEFAULTS: RubberDuckConfig = {
  claude: { maxBudgetPerTurn: 2.0 },
  codex: { maxBudgetPerTurn: 2.0 },
  session: { maxRounds: 10, autonomy: 'full', checkpointEvery: 3, timeoutPerTurn_ms: 300_000, summarizeEvery: 3, maxBudgetTotal: 10.0 },
  consensus: { model: 'sonnet', minRounds: 2 },
  build: { verifyCommands: [] },
  interrupt: { hotkey: 'ctrl+\\' },
  tmux: { layout: 'horizontal' },
  db: { path: join(homedir(), '.rubberduck', 'rubberduck.db') },
}

function tryReadJson(path: string): Record<string, unknown> | null {
  if (!existsSync(path)) return null
  try {
    return JSON.parse(readFileSync(path, 'utf-8'))
  } catch {
    return null
  }
}

export function loadConfig(cliOverrides: Record<string, unknown> = {}): RubberDuckConfig {
  const userPath = join(homedir(), '.rubberduck', 'config.json')
  const projectPath = resolve('rubberduck.config.json')

  const userConfig = tryReadJson(userPath) ?? {}
  const projectConfig = tryReadJson(projectPath) ?? {}

  const merged = deepMerge(deepMerge(userConfig, projectConfig), cliOverrides)
  const parsed = ConfigSchema.parse(merged)

  return applyDefaults(parsed)
}

function applyDefaults(raw: RawConfig): RubberDuckConfig {
  return {
    claude: { ...DEFAULTS.claude, ...stripUndefined(raw.claude ?? {}) },
    codex: { ...DEFAULTS.codex, ...stripUndefined(raw.codex ?? {}) },
    session: { ...DEFAULTS.session, ...stripUndefined(raw.session ?? {}) },
    consensus: { ...DEFAULTS.consensus, ...stripUndefined(raw.consensus ?? {}) },
    build: { ...DEFAULTS.build, ...stripUndefined(raw.build ?? {}) },
    interrupt: { ...DEFAULTS.interrupt, ...stripUndefined(raw.interrupt ?? {}) },
    tmux: { ...DEFAULTS.tmux, ...stripUndefined(raw.tmux ?? {}) },
    db: { ...DEFAULTS.db, ...stripUndefined(raw.db ?? {}) },
  } as RubberDuckConfig
}

function stripUndefined(obj: Record<string, unknown>): Record<string, unknown> {
  const result: Record<string, unknown> = {}
  for (const [k, v] of Object.entries(obj)) {
    if (v !== undefined) result[k] = v
  }
  return result
}

function deepMerge(base: Record<string, unknown>, override: Record<string, unknown>): Record<string, unknown> {
  const result = { ...base }
  for (const key of Object.keys(override)) {
    const val = override[key]
    if (val && typeof val === 'object' && !Array.isArray(val) && typeof result[key] === 'object' && result[key] && !Array.isArray(result[key])) {
      result[key] = deepMerge(result[key] as Record<string, unknown>, val as Record<string, unknown>)
    } else if (val !== undefined) {
      result[key] = val
    }
  }
  return result
}

export function getDbPath(config: RubberDuckConfig): string {
  return config.db.path
}
