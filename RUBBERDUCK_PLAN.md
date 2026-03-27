# Rubber Duck v0.2 — Hardening + Tmux-Native UX

## Context

v0.1 shipped and runs end-to-end (Claude proposes, Codex critiques, consensus detection works). But the current experience is a single terminal stream — not the vision. The goal is: `duck plan` opens tmux with live agent panes, you watch them work, then `duck build` shows git diffs in real time. Below is everything needed to get there.

---

## Phase A: Bug Fixes from Live Testing

These are wiring gaps — the code exists but isn't connected.

### A1. Session resume (--resume) not used in round loop
**Files:** `src/orchestrator/round.ts`, `src/orchestrator/orchestrator.ts`
**Problem:** Each round calls `agentA.send()` instead of `agentA.resume(sessionId)` on rounds 2+. Agents lose conversation context between rounds.
**Fix:** Track claude_sid/codex_sid from first turn, use `resume()` for subsequent turns.

### A2. Summarizer not integrated
**Files:** `src/orchestrator/orchestrator.ts`, `src/summarizer/summarizer.ts`
**Problem:** `shouldSummarize()` and `summarizeAndRotate()` exist but are never called in the main loop.
**Fix:** After each round, check `shouldSummarize(round, config.session.summarizeEvery)`. If true, call summarizer, get new session IDs, continue.

### A3. Interrupt handler not wired
**Files:** `src/orchestrator/orchestrator.ts`, `src/interrupt/handler.ts`
**Problem:** InterruptHandler class exists but orchestrator doesn't instantiate or use it.
**Fix:** Create handler in orchestrator, register agents, check for pending human messages between rounds.

### A4. System prompt passed as CLI arg (too long)
**Files:** `src/adapters/claude.ts`, `src/adapters/codex.ts`
**Problem:** `--system-prompt` with a long string may hit arg length limits. Same issue we fixed for prompts.
**Fix:** For Claude, use `--append-system-prompt-file` and write a temp file. For Codex, `--config instructions=...` may need a file approach too.

### A5. Writable scope validation not implemented
**Files:** `src/orchestrator/round.ts`, new `src/artifact/scope.ts`
**Problem:** Plan says post-turn validation catches out-of-scope edits. Not implemented.
**Fix:** After each agent turn, diff working directory against pre-turn state. Revert unauthorized changes.

### A6. `consensus/judge.ts` — LLM fallback not implemented
**Files:** `src/consensus/judge.ts` (new)
**Problem:** Referenced in plan, file doesn't exist.
**Fix:** Create it. Only called when structured output is contradictory (approve + blocking issues).

---

## Phase B: Tmux-Native UX (the real experience)

This is the core UX overhaul. Running `duck plan` should feel like watching two agents collaborate live.

### B1. Tmux session auto-creation
**What happens when you run `duck plan "task"`:**
```
+------------------------------------------------------------------+
|  Pane 0: Claude (Agent A)      |  Pane 1: Codex (Agent B)       |
|  Live streaming output as      |  Live streaming output as       |
|  Claude thinks and edits       |  Codex critiques and edits      |
|                                |                                 |
+------------------------------------------------------------------+
|  Pane 2: Duck Control                                            |
|  Round status, cost, consensus, human input prompt               |
|  [quack]> _                                                      |
+------------------------------------------------------------------+
```
**Files:** `src/tmux/manager.ts`, `src/orchestrator/orchestrator.ts`
**How:** Orchestrator creates tmux session on startup. Agent stdout is piped to respective panes via `tmux pipe-pane` or by spawning agents directly inside panes.

### B2. Live agent output streaming
**Problem:** Currently we wait for agent to finish, then print summary. User sees nothing during the 60-90s each turn takes.
**Fix:** Stream agent stdout to the tmux pane in real time. The orchestrator still collects the full output for parsing, but the pane shows it live.
**Approach:** Use `execa` with `stdout: 'pipe'` and tee the stream — one copy to tmux pane, one to buffer for parsing.

### B3. Control pane as orchestrator UI
**Problem:** Status output goes to the same terminal as everything else.
**Fix:** Control pane (pane 2) shows:
- Round headers with duck art
- Per-turn cost + timing
- Consensus status
- Budget remaining
- `[quack]>` prompt for human input between rounds
**Files:** `src/ui/control.ts`, `src/orchestrator/orchestrator.ts`

### B4. Plan artifact live view
**Problem:** User can't see plan.md evolving in real time.
**Fix:** Use `chokidar` to watch the artifact file. On change, render a diff or the updated content in a sub-section of the control pane, or optionally a 4th pane.
**Alternative:** After each agent turn, print a short diff summary in the control pane.

### B5. Build mode with live git diffs
**What happens when you run `duck build "task"`:**
- Tmux opens with same 3-pane layout
- Builder pane shows Claude writing code in the worktree
- Reviewer pane shows Codex reading and critiquing
- Control pane shows `git diff --stat` after each turn + verification gate results
- On consensus: control pane shows full `git diff` and merge prompt

**Files:** `src/orchestrator/orchestrator.ts`, `src/orchestrator/modes.ts`, `src/worktree/manager.ts`
**New:** After each builder turn, run `git diff --stat` in worktree and display in control pane.

### B6. Mode transitions (plan -> build)
**Ideal flow:** User runs `duck plan`, agents converge on plan.md, then user says "build it" and duck transitions to build mode using the plan as context.
**Implementation:** After plan convergence, control pane prompts: "Plan converged. [b]uild from this plan? [q]uit?"
If build: create worktree, inject plan.md as context for builder agent, start build rounds.

---

## Phase C: Resume + Polish

### C1. `duck resume` actually works
**Problem:** Reads session from DB but doesn't restart the round loop from the right point.
**Fix:** Load session state, determine last completed round, set lastAgentBContent from DB, continue loop from round N+1.

### C2. Graceful budget exhaustion
**Problem:** Budget check exists but doesn't save state cleanly.
**Fix:** On budget hit, save session as "paused", print resume instructions.

### C3. `--no-tmux` fallback
**Problem:** When tmux isn't available or `--no-tmux` is passed, should still work (current behavior).
**Fix:** Keep current sequential stdout as fallback. Tmux is the default when available.

---

## Implementation Order

1. **A1-A3** (session resume, summarizer, interrupt) — quick wiring fixes
2. **B1-B3** (tmux session, streaming, control pane) — core UX overhaul
3. **B4-B5** (live plan view, build diffs) — visual polish
4. **B6** (plan->build transition) — workflow feature
5. **A4-A6** (system prompt files, scope validation, judge) — hardening
6. **C1-C3** (resume, budget, no-tmux) — polish

---

## Verification

- `duck plan "task"` opens tmux, shows live agent output in 2 panes, control pane shows rounds + consensus
- Ctrl+\ pauses, injects human message, agents see it next round
- `duck build "task"` shows git diffs in control pane after each builder turn
- `duck plan` -> "build it" -> seamless transition to build mode
- `duck resume <id>` picks up where a paused session left off
- Budget exhaustion gracefully pauses and saves state

**Stack:** TypeScript, SQLite (better-sqlite3), tmux, Claude Code CLI, Codex CLI
**Approach:** Hybrid — custom orchestrator core, PAL MCP deferred to future version

---

## All Decisions

| Decision | Choice |
|----------|--------|
| Language | TypeScript |
| Message queue | SQLite (better-sqlite3) |
| Plan conflicts | Sequential — Agent B always sees Agent A's edits |
| Control pane | Readline (simple text I/O) |
| Build mode | v1 — configurable granularity (full-then-review default, `--step-by-step` for atomic) |
| Build reviewer | Readonly — suggests fixes, builder implements |
| Build workspace | Git worktree (isolated branch, merge on consensus, delete on failure) |
| Plan/review workspace | Shared cwd with enforced writable scope |
| Interrupt | Configurable hotkey (default: Ctrl+\) — SIGTERM running agent, inject human message |
| Convergence | Consensus-based (both agree, no objections) |
| Autonomy | Configurable per task (full, checkpoints, approval) |
| Cost mgmt | Summarize conversation after ~3 rounds, start fresh session with summary |
| Name | Rubber Duck |

---

## Architecture

```
+------------------------------------------------------------------+
|                        TERMINAL (tmux)                           |
|  +---------------------------+  +---------------------------+    |
|  |    Pane 0: Claude Code    |  |    Pane 1: Codex CLI      |    |
|  |    (visual output)        |  |    (visual output)        |    |
|  +---------------------------+  +---------------------------+    |
|  +----------------------------------------------------------+   |
|  |  Pane 2: Duck Control (orchestrator UI, logs, input)           |   |
|  +----------------------------------------------------------+   |
+------------------------------------------------------------------+
                              |
              +---------------+----------------+
              |          ORCHESTRATOR           |
              |                                |
              |  ClaudeAdapter    CodexAdapter  |
              |  (--print/--resume) (exec --json)|
              |        |               |       |
              |  +----------------------------+|
              |  |   MESSAGE BUS (SQLite)     ||
              |  +----------------------------+|
              |        |               |       |
              |  ConsensusDetector  PlanManager |
              |  InterruptHandler   TmuxManager |
              |  Summarizer     WorktreeManager |
              +--------------------------------+
```

### Agent Communication (turn-based, non-interactive)

**Claude Code:**
```bash
claude -p --output-format json --resume <session-id> --permission-mode auto "prompt"
```
- Returns single JSON with `result`, `session_id`, `total_cost_usd`, `usage`
- `--resume` carries full conversation context

**Codex CLI:**
```bash
codex exec --json --full-auto resume <session-id> "prompt"
```
- Returns JSONL stream with typed events: `thread.started`, `turn.completed`, `item.completed`
- `item.completed` with `type: "agent_message"` contains the response text
- `turn.completed` has `usage: {input_tokens, cached_input_tokens, output_tokens}`
- Session persists in `~/.codex/sessions/<uuid>.jsonl`

### Round Flow (plan mode)

```
Round N:
  1. Claude gets: Codex's structured output + "read plan.md, propose/address feedback"
  2. Claude output (structured) -> SQLite + display in pane 0
  3. Codex gets: Claude's structured output + "read plan.md, critique and improve"
  4. Codex output (structured) -> SQLite + display in pane 1
  5. Consensus check (structured — see Consensus Detection)
     - Yes -> converged, done
     - No + under maxRounds -> Round N+1
     - No + at maxRounds -> escalate to human
  6. Every 3 rounds: summarize history, start fresh sessions with summary
```

### Round Flow (review mode)

Review mode produces a structured `review.json` artifact (JSON source of truth, not Markdown — reliable for machine parsing):

```
duck review <path>

Artifact: review.json (structured, machine-parseable)

Setup:
  - Generate review.json with: {summary, issues: [], recommendations: []}
  - Each issue: {id, severity, file, line, description, status, resolution}

Round N:
  1. Claude reviews target path, writes findings as structured issues to review.json
  2. Codex reviews same path + Claude's issues, adds/modifies/disputes in review.json
  3. Consensus check: all issues have status != 'open'
     - Unresolved open issues -> Round N+1
     - All resolved/wontfix -> converged

Issue resolution: both agents must agree on disposition.
Agent B can mark A's issue "wontfix" with reasoning. A can reopen next round.
Consensus = zero open issues + both agents explicitly sign off.
```

**review.json format:**
```json
{
  "target": "src/",
  "summary": "High-level assessment of the code",
  "issues": [
    {
      "id": "R1",
      "severity": "high",
      "file": "src/auth.ts",
      "line": 42,
      "description": "SQL injection via unsanitized input",
      "status": "resolved",
      "resolution": "Added parameterized query"
    },
    {
      "id": "R2",
      "severity": "medium",
      "file": "src/auth.ts",
      "line": 88,
      "description": "Missing error handling",
      "status": "wontfix",
      "resolution": "Upstream caller handles this case"
    }
  ],
  "recommendations": [
    "Consider adding integration tests for the auth flow"
  ]
}
```

Orchestrator can optionally render a Markdown summary from review.json for human readability via `duck export`.

### Round Flow (build mode)

```
duck build "task" [--step-by-step]

Setup:
  - Create git worktree at .duck-build/<session-id>
  - Builder agent (Claude) works in worktree
  - Reviewer agent (Codex) reads from worktree (--sandbox read-only)

Default (full-then-review):
  Round 1: Builder implements full task in worktree
  Round 2: Reviewer critiques all changes (readonly)
  Round 3: Builder addresses feedback
  Round 4: Reviewer re-reviews
  ... until consensus

--step-by-step (atomic):
  Round 1: Builder implements piece 1
  Round 2: Reviewer critiques piece 1
  Round 3: Builder fixes piece 1
  Round 4: Reviewer approves piece 1, builder starts piece 2
  ...

On consensus: run verification gate, then prompt user to merge
On merge: squash-merge into main branch (single clean commit, all [duck] checkpoint
  commits are internal orchestration noise and are not preserved in main history).
  Commit message: "duck build: <task summary>" with session id in trailer.
On failure/cancel: delete worktree, no damage to main

Verification gate (runs in worktree before merge prompt):
  1. Run configured test command (e.g., npm test, pytest)
  2. Run configured lint command (e.g., eslint, ruff)
  3. Run configured typecheck command (e.g., tsc --noEmit, mypy)
  All must pass. If any fail -> send failures back to builder for another round.
  Gate commands configured in rubberduck.config.json:
    build.verifyCommands: ["npm test", "npm run lint", "npm run typecheck"]
```

---

## SQLite Schema

```sql
CREATE TABLE sessions (
  id TEXT PRIMARY KEY,
  task TEXT NOT NULL,
  mode TEXT NOT NULL,              -- plan|review|build
  status TEXT DEFAULT 'active',    -- active|paused|converged|failed|cancelled
  claude_sid TEXT,
  codex_sid TEXT,
  rounds INTEGER DEFAULT 0,
  max_rounds INTEGER DEFAULT 10,
  autonomy TEXT DEFAULT 'full',    -- full|checkpoints|approval
  step_by_step INTEGER DEFAULT 0,  -- build mode: atomic reviews
  worktree_path TEXT,              -- build mode: git worktree path
  worktree_branch TEXT,            -- build mode: branch name
  config TEXT,                     -- JSON blob of overrides
  artifact_path TEXT,              -- path to plan.md, review.json, or worktree root
  artifact_kind TEXT,              -- plan|review|build
  total_cost_usd REAL DEFAULT 0,
  created_at TEXT DEFAULT (datetime('now')),
  updated_at TEXT DEFAULT (datetime('now'))
);

CREATE TABLE messages (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id TEXT NOT NULL,
  round INTEGER NOT NULL,
  agent TEXT NOT NULL,              -- claude|codex|human
  type TEXT NOT NULL,               -- proposal|critique|response|human|system|summary
  content TEXT NOT NULL,
  structured_output TEXT,           -- JSON string of AgentTurnOutput (nullable for human/system)
  snapshot_id INTEGER,              -- FK to artifacts.id — the snapshot this message references
  cost_usd REAL,
  tokens_in INTEGER,
  tokens_out INTEGER,
  duration_ms INTEGER,
  created_at TEXT DEFAULT (datetime('now'))
);

CREATE TABLE artifacts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id TEXT NOT NULL,
  round INTEGER NOT NULL,
  phase TEXT NOT NULL,              -- pre_round|post_agent_a|post_agent_b
  kind TEXT NOT NULL,               -- plan|review|build
  path TEXT NOT NULL,               -- file path (plan.md/review.json) or worktree root
  content TEXT,                     -- full file content for plan/review, NULL for build (lives in git)
  hash TEXT NOT NULL,               -- sha256 for plan/review, git tree hash for build
  git_commit TEXT,                  -- build mode only: commit sha for rollback
  created_at TEXT DEFAULT (datetime('now'))
);

CREATE INDEX idx_messages_session ON messages(session_id, round);
CREATE INDEX idx_artifacts_session ON artifacts(session_id, round, phase);
```

---

## Consensus Detection (structured output model)

Agents are required to end each turn with a structured JSON block. The orchestrator parses this from agent output (fenced ```json block at end of response):

```typescript
interface AgentTurnOutput {
  decision: 'approve' | 'request_changes' | 'propose'
  blocking_issues: string[]        // must be empty for consensus
  artifact_hash: string            // see "Artifact Hashing" below
  touched_files: string[]          // files the agent read or edited this turn
  summary: string                  // one-line summary of what agent did
}
```

**Artifact hashing (mode-specific):**
- **plan mode:** sha256 of `plan.md` file content
- **review mode:** sha256 of `review.json` file content
- **build mode:** `git rev-parse HEAD:` (git tree hash of worktree root) — captures the full multi-file state in a single hash. Agents are instructed to run `git add -A && git rev-parse $(git write-tree)` or the orchestrator computes it post-turn.

**Build-mode snapshots:** Instead of storing file content in the `artifacts` table (impractical for multi-file worktrees), build mode uses git commits as snapshots:
- Pre-round: `git stash create` or auto-commit with message `[duck] pre-round-N`
- Post-agent-A: auto-commit `[duck] round-N-post-A`
- Post-agent-B: auto-commit `[duck] round-N-post-B`
- Rollback: `git reset --hard <commit>` to the appropriate checkpoint
- The `artifacts` table stores `hash` (git tree hash) and `content` = NULL for build mode (content lives in git)

**Consensus rule (hard, no heuristics):**
```
// Base rule (all modes):
base_consensus =
  agent_a.decision == 'approve' &&
  agent_b.decision == 'approve' &&
  agent_a.blocking_issues.length == 0 &&
  agent_b.blocking_issues.length == 0 &&
  agent_a.artifact_hash == agent_b.artifact_hash

// Mode-specific additional checks:
plan_consensus  = base_consensus
review_consensus = base_consensus && review_json_has_no_open_issues(artifact)
build_consensus = base_consensus && verification_gate_passes(worktree)

// Final:
consensus = base_consensus && mode_specific_check
```

**Review-mode extra validation:** After base consensus passes, orchestrator parses `review.json` and verifies every issue has `status != 'open'`. If any open issues remain despite agents saying "approve", consensus is rejected with a synthetic blocking issue listing the open issue IDs. This prevents agents from approving while forgetting to resolve issues.

**Build-mode extra validation:** After base consensus passes, orchestrator runs `build.verifyCommands` in the worktree. If any command fails, consensus is rejected and failures are sent back to the builder.

If an agent's output doesn't contain valid structured JSON, the orchestrator treats it as `decision: 'request_changes'` with a synthetic blocking issue: "Agent did not provide structured output."

**Fallback LLM judge** (sonnet, ~$0.01) — only used when structured output is present but ambiguous (e.g., agent says "approve" but lists blocking issues). Judge resolves the contradiction, doesn't determine consensus independently.

System prompts instruct agents to always end with this block. If agent consistently fails to produce it, orchestrator injects a reminder in next turn.

---

## Round Transaction Model (crash recovery)

Each round is an atomic transaction. The orchestrator follows this exact sequence:

```
1. PRE-ROUND: snapshot artifact -> artifacts table (before agent touches it)
   This is the rollback point for agent A failures.

2. AGENT A TURN:
   a. Spawn agent A subprocess, wait for exit
   b. On crash/timeout -> rollback artifact to step 1 snapshot, retry once, then fail round
   c. On success:
      i.   Snapshot artifact (post-A version) -> artifacts table
      ii.  Parse structured output from agent response
      iii. Store message in SQLite (references post-A snapshot id)
   Ordering: snapshot FIRST, then message. This ensures the snapshot exists
   before anything references it. If process dies between i and iii,
   resume sees the snapshot but no message -> knows A's turn is incomplete.

3. AGENT B TURN:
   a. Spawn agent B subprocess, wait for exit
   b. On crash/timeout -> rollback artifact to step 2c-i snapshot, retry once, then fail round
   c. On success:
      i.   Snapshot artifact (post-B version) -> artifacts table
      ii.  Parse structured output from agent response
      iii. Store message in SQLite (references post-B snapshot id)

4. POST-ROUND: consensus check using both stored messages' structured output
```

**Key invariant:** snapshot artifact BEFORE storing message. Message references snapshot. If crash occurs between snapshot and message write, resume detects "snapshot with no corresponding message" and knows the turn is incomplete.

**Resume after crash:**
- `duck resume <id>` reads last complete round from SQLite
- Determines which agent turn was incomplete (if any)
- Rolls artifact back to last good snapshot
- Restarts from that point

SQLite WAL mode ensures the database itself survives process crashes.

---

## Conversation Summarization (cost management)

Every 3 rounds:
1. Collect all messages from the session
2. Send to sonnet: "Summarize this planning conversation. Capture all decisions, open questions, and current state of the plan."
3. Store summary as `{type: 'summary'}` message
4. Start new Claude session (`--session-id <new-uuid>`) with summary as initial context
5. Start new Codex session (`codex exec --json --full-auto "summary context..."`)
6. Update session record with new `claude_sid` and `codex_sid`

This keeps per-turn cost roughly constant instead of growing linearly with round count.

---

## Interrupt Flow

Default hotkey: `Ctrl+\` (configurable via `config.interrupt.hotkey`). Chosen over Ctrl+D to avoid colliding with EOF behavior in readline/tmux.

1. Hotkey in control pane (readline raw mode keypress handler)
2. If agent subprocess is running: SIGTERM it, discard partial output
3. Display prompt: `[!! QUACK] Type your message (or 'resume' to continue):`
4. User types message -> stored as `{agent:'human', type:'human'}` in SQLite
5. Next turn for both agents includes: `"Human operator interjected: <message>. Take this into account."`
6. Resume round loop

Alternative: user can also type directly in control pane between rounds (no hotkey needed when agents are idle).

---

## Configuration

```typescript
interface RubberDuckConfig {
  claude: {
    model?: string              // default: system default
    permissionMode?: string     // default: 'auto'
    maxBudgetPerTurn?: number   // default: 2.0
    systemPromptExtra?: string
  }
  codex: {
    model?: string
    sandbox?: string            // default: 'workspace-write' for plan/review (needs artifact write), 'read-only' for build reviewer
    maxBudgetPerTurn?: number
    systemPromptExtra?: string
  }
  session: {
    maxRounds?: number          // default: 10
    autonomy?: 'full' | 'checkpoints' | 'approval'
    checkpointEvery?: number    // for checkpoints mode
    timeoutPerTurn_ms?: number  // default: 120000
    summarizeEvery?: number     // default: 3
    maxBudgetTotal?: number     // default: 10.0
  }
  consensus: {
    model?: string              // default: sonnet (for fallback judge only)
    minRounds?: number          // default: 2
  }
  build: {
    verifyCommands?: string[]   // default: [] — e.g. ["npm test", "npm run lint", "tsc --noEmit"]
  }
  interrupt: {
    hotkey?: string             // default: 'ctrl+\\'
  }
  tmux: {
    layout?: 'horizontal' | 'vertical'  // default: horizontal
  }
  db: {
    path?: string               // default: ~/.rubberduck/rubberduck.db
  }
}
```

Loaded: CLI flags > `./rubberduck.config.json` > `~/.rubberduck/config.json` > defaults

---

## CLI Commands

```
duck plan <task>                 Plan session — both agents converge on plan.md
duck review <path>               Both agents review code, converge on feedback
duck build <task>                One builds (worktree), one reviews (readonly)
duck build --step-by-step <task> Atomic build: review after each piece
duck resume <id>                 Resume paused/interrupted session
duck status                      Show active/recent sessions
duck log <id>                    Message history for a session
duck export <id>                 Export transcript to markdown

Options:
  -r, --rounds <n>         Max rounds (default: 10)
  -a, --autonomy <mode>    full | checkpoints | approval
  --claude-model <model>   Override Claude model
  --codex-model <model>    Override Codex model
  --layout <dir>           horizontal | vertical tmux layout
  --no-tmux                Run without tmux (sequential stdout)
  --plan-file <path>       Custom plan file path
  --budget <usd>           Max session budget in USD
  -v, --verbose            Verbose output
```

---

## File Structure

```
rubberduck/
├── bin/duck.ts                     # CLI entry (commander)
├── src/
│   ├── index.ts                    # Main exports
│   ├── types.ts                    # All interfaces/types
│   ├── config.ts                   # Zod schema + config loader
│   ├── orchestrator/
│   │   ├── orchestrator.ts         # Core round loop
│   │   ├── round.ts               # Single round logic
│   │   └── modes.ts               # plan/review/build mode logic
│   ├── adapters/
│   │   ├── base.ts                # AgentAdapter interface
│   │   ├── claude.ts              # Claude CLI: spawn, parse JSON, resume
│   │   ├── codex.ts               # Codex CLI: spawn, parse JSONL, resume
│   │   └── prompts.ts            # System prompt templates per mode
│   ├── bus/
│   │   ├── db.ts                  # SQLite init (WAL mode) + migrations
│   │   ├── messages.ts            # Message CRUD
│   │   ├── sessions.ts            # Session CRUD
│   │   └── artifacts.ts           # Artifact snapshot CRUD
│   ├── consensus/
│   │   ├── parser.ts              # Extract + validate AgentTurnOutput from agent response
│   │   ├── detector.ts            # Hard consensus rule (both approve + matching hash)
│   │   └── judge.ts               # LLM fallback for contradictory output
│   ├── summarizer/
│   │   └── summarizer.ts          # Conversation summarization + session rotation
│   ├── interrupt/
│   │   └── handler.ts             # Configurable hotkey (Ctrl+\), SIGTERM, human inject
│   ├── tmux/
│   │   └── manager.ts             # Session/pane create, pipe output
│   ├── worktree/
│   │   └── manager.ts             # Git worktree create/delete/merge
│   ├── artifact/
│   │   └── manager.ts             # Artifact read/write/hash (plan.md, review.json, git tree)
│   └── ui/
│       ├── ducks.ts               # ASCII art, duck indicators, chalk styling
│       ├── display.ts             # Round summaries, cost tracking
│       └── control.ts             # Readline input handler
├── test/
│   ├── adapters/
│   │   ├── claude.test.ts
│   │   └── codex.test.ts
│   ├── consensus/
│   │   └── detector.test.ts
│   ├── bus/
│   │   └── messages.test.ts
│   ├── summarizer/
│   │   └── summarizer.test.ts
│   └── orchestrator/
│       └── orchestrator.test.ts
├── fixtures/
│   ├── claude-response.json        # Sample Claude JSON output
│   └── codex-response.jsonl        # Sample Codex JSONL output
├── package.json
├── tsconfig.json
└── tsup.config.ts
```

---

## Key Dependencies

| Package | Purpose |
|---------|---------|
| `better-sqlite3` | Message bus, sessions, artifact snapshots |
| `commander` | CLI argument parsing |
| `execa` | Subprocess management (spawn/kill Claude + Codex) |
| `zod` | Config + message schema validation |
| `chalk` + `ora` | Terminal colors + spinners |
| `uuid` | Session ID generation |
| `chokidar` | Plan file change watching |
| `fast-diff` | Plan version diffing for consensus |
| `vitest` | Testing |
| `tsup` | Build/bundle |
| `tsx` | Dev runner |

---

## Implementation Sequence

### Week 1: Core Infrastructure

**Step 1: Scaffold**
- Init npm project, tsconfig, tsup config
- Set up commander CLI skeleton in `bin/duck.ts`
- Define all types in `src/types.ts`
- Config schema with zod in `src/config.ts`

**Step 2: Agent Adapters**
- `src/adapters/base.ts` — AgentAdapter interface
- `src/adapters/claude.ts` — spawn `claude -p`, parse JSON response, `--resume` for session continuity
- `src/adapters/codex.ts` — spawn `codex exec --json`, parse JSONL stream, `resume` subcommand
- `src/adapters/prompts.ts` — system prompt templates for plan/review/build modes
- Test with fixtures

**Step 3: Message Bus + Artifact Store**
- `src/bus/db.ts` — SQLite init (WAL mode), create sessions/messages/artifacts tables
- `src/bus/messages.ts` — insert/query messages with structured_output and snapshot_id
- `src/bus/sessions.ts` — create/update/get sessions
- `src/bus/artifacts.ts` — artifact snapshot CRUD (insert, get by session+round+phase, get latest)

**Step 4: Orchestrator Core**
- `src/orchestrator/orchestrator.ts` — main loop: create session, run rounds, check consensus
- `src/orchestrator/round.ts` — single round with transaction model: pre-snapshot -> agent A -> post-A snapshot -> message -> agent B -> post-B snapshot -> message -> consensus check
- Structured consensus (parse AgentTurnOutput, hard rule check)
- `duck plan <task>` working end-to-end (no tmux, sequential stdout)

### Week 2: Features + Polish

**Step 5: Consensus Detection**
- `src/consensus/parser.ts` — extract fenced JSON block from agent output, validate against AgentTurnOutput schema
- `src/consensus/detector.ts` — hard consensus rule: both approve + zero blockers + matching artifact hash
- `src/consensus/judge.ts` — LLM fallback judge for contradictory structured output only
- Tests with fixture conversations (approve/approve, approve/request_changes, missing JSON, hash mismatch)

**Step 6: Summarizer**
- `src/summarizer/summarizer.ts` — summarize conversation, rotate sessions
- Integrate into orchestrator: trigger every N rounds

**Step 7: Tmux Integration**
- `src/tmux/manager.ts` — create session, split panes, pipe-pane for output routing
- Wire orchestrator output to correct panes

**Step 8: Interrupt Handler**
- `src/interrupt/handler.ts` — raw mode stdin, configurable hotkey (default Ctrl+\)
- SIGTERM running subprocess, readline for human message
- Inject human message into next round

**Step 9: Build Mode + Worktree**
- `src/worktree/manager.ts` — git worktree create/delete/merge
- `src/orchestrator/modes.ts` — build mode logic (full-then-review + step-by-step)
- Builder in worktree, reviewer readonly
- Merge prompt on consensus

**Step 10: Review Mode + Remaining Commands**
- `duck review <path>` mode prompts
- `duck resume`, `duck status`, `duck log`, `duck export`
- Config file loading from project + user level
- Edge cases: agent timeout, crash, empty response, budget exceeded

---

## System Prompts (critical for convergence)

All prompts include a shared structured output footer (see Consensus Detection):

```
REQUIRED: End every response with a fenced JSON block exactly like this:

\`\`\`json
{
  "decision": "approve" | "request_changes" | "propose",
  "blocking_issues": [],
  "artifact_hash": "<see below>",
  "touched_files": ["<files you read or edited>"],
  "summary": "<one-line summary of what you did>"
}
\`\`\`

artifact_hash rules:
- Plan/review mode: sha256 of the artifact file (plan.md or review.json) after your edits.
- Build mode (builder): the orchestrator computes and injects the git tree hash for you after
  your turn. Set artifact_hash to "auto" and the orchestrator will replace it.
- Build mode (reviewer, readonly): set artifact_hash to "auto" — the orchestrator injects the
  current git tree hash since you cannot edit files.

The orchestrator parses this block to determine consensus. If you omit it,
your turn is treated as "request_changes" with a blocking issue.
```

**Plan mode — Agent A (Claude):**
```
You are Agent A in a dual-agent planning session managed by Rubber Duck.
You are collaborating with Agent B to produce a high-quality plan.

Artifact: {artifact_path} (plan.md)
You may ONLY edit this file. Do not create or modify any other files.

Rules:
- Read the artifact before responding
- Make proposed changes BY EDITING the artifact directly
- Be specific and actionable
- When you agree with Agent B, say so explicitly
- When you disagree, explain WHY with concrete reasoning
- When you have no objections, set decision to "approve" with empty blocking_issues

{structured_output_footer}
```

**Plan mode — Agent B (Codex):**
```
You are Agent B in a dual-agent planning session managed by Rubber Duck.
You are the critical reviewer. Your job is to find gaps, risks, and better alternatives.

Artifact: {artifact_path} (plan.md)
You may ONLY edit this file. Do not create or modify any other files.

Rules:
- Read the artifact before responding
- Critically evaluate Agent A's work
- Be constructive — don't just criticize, propose improvements
- Edit the artifact with your improvements
- When you have no objections, set decision to "approve" with empty blocking_issues

{structured_output_footer}
```

**Review mode — Agent A (Claude):**
```
You are Agent A in a dual-agent code review managed by Rubber Duck.

Target: {review_target_path}
Artifact: {artifact_path} (review.json)
You may ONLY edit the artifact file. Do not modify the code under review.

Rules:
- Read the target code thoroughly
- Write findings as structured issues in review.json
- Each issue: {id, severity, file, line, description, status, resolution}
- Set status to "open" for new issues, "resolved"/"wontfix" for Agent B's issues you agree with
- When all issues are resolved/wontfix and you have no new findings: decision = "approve"

{structured_output_footer}
```

**Review mode — Agent B (Codex):**
```
You are Agent B in a dual-agent code review managed by Rubber Duck.
You are the second reviewer and issue resolver.

Target: {review_target_path}
Artifact: {artifact_path} (review.json)
You may ONLY edit the artifact file. Do not modify the code under review.

Rules:
- Read the target code and Agent A's issues in review.json
- Add new issues you find, dispute or confirm Agent A's issues
- Mark issues "resolved" (with resolution) or "wontfix" (with justification)
- When all issues are resolved/wontfix and you have no new findings: decision = "approve"

{structured_output_footer}
```

**Build mode — Builder (Claude):**
```
You are the Builder in a Rubber Duck build session.
Working directory: {worktree_path}

Task: {task}
{step_by_step ? "Implement ONE piece at a time. Wait for reviewer feedback." : "Implement the full task. The reviewer will critique after."}

Rules:
- Write clean, working code
- Explain what you built and why
- Address reviewer feedback in subsequent rounds
- When reviewer approves: decision = "approve"

{structured_output_footer}
```

**Build mode — Reviewer (Codex, readonly):**
```
You are the Reviewer in a Rubber Duck build session. You have READONLY access.
Working directory: {worktree_path}

Rules:
- Review the Builder's code changes thoroughly
- Check for: bugs, edge cases, security issues, code quality, missing tests
- Be specific — reference file paths and line numbers
- Suggest fixes but do NOT edit files yourself
- When satisfied: decision = "approve" with empty blocking_issues

{structured_output_footer}
```

---

## Duck Visuals (CLI theming)

### Startup Banner
```
    __
  >(o )___
   ( ._> /    Rubber Duck v1.0
    `---'     Two agents. One plan.
```

### Per-agent duck indicators in output
```
--- Round 2 ---------------------------------------------------
  [>o)  Claude] Proposing auth middleware...     $0.12  (14s)
  [o<)  Codex ] Reviewing — 3 issues found...   $0.08  (11s)
  [====] Consensus? No — token rotation unresolved
```

### Status indicators
```
  [>o)  ...] = Claude thinking (animated dots)
  [o<)  ...] = Codex thinking
  [>o) <o<)] = Consensus! Both ducks agree
  [!! QUACK] = Human interrupt
  [>o)  $$$] = Budget warning
```

### Session complete
```
    __    __
  >(o )__(o )>
   ( ._>( ._>   Consensus reached in 3 rounds!
    `---'`---'   Total cost: $0.61
                 Artifact: ./plan.md        (plan mode)
                       or: ./review.json    (review mode)
                       or: .duck-build/abc  (build mode)
```

### Implementation notes
- Duck ASCII rendered via chalk (yellow body, orange beak)
- Animated spinner replaces `...` during agent execution
- Stored in `src/ui/ducks.ts` — all ASCII art constants + chalk styling
- Control pane prompt: `[quack]> ` when waiting for human input

---

## Writable Scope Enforcement

System prompts alone don't prevent wrong-file edits. Each mode has an explicit allowed-write set:

| Mode | Agent A (Claude) writable | Agent B (Codex) writable |
|------|---------------------------|--------------------------|
| plan | `plan.md` only | `plan.md` only |
| review | `review.json` only | `review.json` only |
| build | worktree (full access) | nothing (readonly sandbox) |

**Enforcement: both agents can write the artifact, but ONLY the artifact.**

- **Claude (plan/review):** `--permission-mode auto` (needs write access to artifact). Writable scope enforced by post-turn validation.
- **Codex (plan/review):** `--sandbox workspace-write` (needs write access to artifact). Writable scope enforced by post-turn validation.
- **Codex (build reviewer):** `--sandbox read-only` (truly readonly — review feedback is in structured output only, not file edits).
- **Post-turn validation (all modes):** After each agent turn, orchestrator checksums all tracked files AND checks for newly created files (via `git status --porcelain` or directory listing diff). Any file modified or created outside the allowed set is reverted/deleted using the pre-turn snapshot and a warning is logged. This is the hard enforcement layer — sandbox flags are defense-in-depth.

---

## Risk Mitigations

| Risk | Mitigation |
|------|------------|
| Agents edit wrong files | Enforced writable scope per mode (see below) |
| Never converge | maxRounds hard limit + escalate to human |
| CLI output format changes | Adapter layer isolates parsing, integration tests catch |
| Cost blowup | Per-turn budget + session total budget + summarization |
| Agent crashes | Catch exit codes, retry once, surface error to control pane |
| Session corruption | SQLite transactions + artifact snapshots for rollback |
| Bad build code | Git worktree isolation — delete worktree to undo everything |
| Worktree merge conflicts | Prompt user to resolve manually before merging |

---

## Verification Plan

**Unit tests:**
1. Adapters parse fixture JSON/JSONL correctly, extract structured output block
2. Consensus logic: approve+approve+matching hash = true, any mismatch = false
3. SQLite CRUD: messages, sessions, artifact snapshots
4. Summarizer produces valid summaries
5. Writable scope validator detects out-of-scope file changes

**Integration tests (happy path):**
6. `duck plan "Design a REST API"` — runs 2-3 rounds, produces plan.md, consensus detected
7. `duck build "add hello world endpoint"` — creates worktree, builds, reviews, verification gate passes, merge prompt
8. `duck review src/` — structured review.json with issues, both agents resolve all issues, no open issues remain
9. `duck resume <id>` — resumes mid-session correctly

**Integration tests (failure scenarios):**
10. **Partial round resume** — kill orchestrator mid-round, resume, verify artifact rolled back to last snapshot
11. **Agent timeout after file edits** — agent edits plan.md then times out before structured output. Verify rollback to pre-turn snapshot.
12. **Malformed CLI output** — agent returns non-JSON or missing structured block. Verify treated as request_changes + reminder injected.
13. **Wrong-file edits** — agent edits file outside writable scope. Verify revert + warning.
14. **Budget exhaustion** — session hits maxBudgetTotal mid-round. Verify graceful stop + status saved.
15. **Verification gate failure** — build consensus reached but `npm test` fails. Verify sent back to builder.

**Manual tests:**
16. Tmux — 3-pane layout, output routing
17. Interrupt — hotkey pauses, inject message, agents receive it
18. Cost tracking — per-turn and total displayed accurately
19. Summarization — session rotates at configured interval
