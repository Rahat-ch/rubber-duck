export type SessionMode = 'plan' | 'review' | 'build'
export type SessionStatus = 'active' | 'paused' | 'converged' | 'failed' | 'cancelled'
export type AutonomyLevel = 'full' | 'checkpoints' | 'approval'
export type AgentName = 'claude' | 'codex'
export type MessageType = 'proposal' | 'critique' | 'response' | 'human' | 'system' | 'summary'
export type ArtifactPhase = 'pre_round' | 'post_agent_a' | 'post_agent_b'
export type Decision = 'approve' | 'request_changes' | 'propose'

export interface AgentTurnOutput {
  decision: Decision
  blocking_issues: string[]
  artifact_hash: string
  touched_files: string[]
  summary: string
}

export interface AgentTurn {
  content: string
  structured: AgentTurnOutput | null
  cost_usd: number
  tokens_in: number
  tokens_out: number
  duration_ms: number
  session_id: string
}

export interface SendOpts {
  cwd?: string
  timeout_ms?: number
  maxBudget?: number
  systemPrompt?: string
}

export interface AgentAdapter {
  readonly name: AgentName
  send(prompt: string, opts?: SendOpts): Promise<AgentTurn>
  resume(sessionId: string, prompt: string, opts?: SendOpts): Promise<AgentTurn>
  abort(): Promise<void>
  isRunning(): boolean
}

export interface Session {
  id: string
  task: string
  mode: SessionMode
  status: SessionStatus
  claude_sid: string | null
  codex_sid: string | null
  rounds: number
  max_rounds: number
  autonomy: AutonomyLevel
  step_by_step: boolean
  worktree_path: string | null
  worktree_branch: string | null
  config: string | null
  artifact_path: string | null
  artifact_kind: SessionMode | null
  total_cost_usd: number
  created_at: string
  updated_at: string
}

export interface Message {
  id: number
  session_id: string
  round: number
  agent: AgentName | 'human'
  type: MessageType
  content: string
  structured_output: string | null
  snapshot_id: number | null
  cost_usd: number | null
  tokens_in: number | null
  tokens_out: number | null
  duration_ms: number | null
  created_at: string
}

export interface Artifact {
  id: number
  session_id: string
  round: number
  phase: ArtifactPhase
  kind: SessionMode
  path: string
  content: string | null
  hash: string
  git_commit: string | null
  created_at: string
}

export interface ConsensusResult {
  reached: boolean
  reason: string
  blocking_issues: string[]
}

export interface RoundResult {
  round: number
  agent_a: AgentTurn
  agent_b: AgentTurn
  consensus: ConsensusResult
  cost_usd: number
}
