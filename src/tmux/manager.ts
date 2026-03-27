import { execSync, spawn } from 'node:child_process'
import type { ChildProcess } from 'node:child_process'

export interface TmuxSession {
  name: string
  panes: { claude: string; codex: string; control: string }
}

export function isTmuxAvailable(): boolean {
  try {
    execSync('which tmux', { stdio: 'pipe' })
    return true
  } catch {
    return false
  }
}

export function isInsideTmux(): boolean {
  return !!process.env.TMUX
}

export function createDuckSession(sessionName: string, layout: 'horizontal' | 'vertical'): TmuxSession {
  // Create session with first pane (will become claude pane)
  execSync(`tmux new-session -d -s "${sessionName}" -x 220 -y 60`, { stdio: 'pipe' })

  // Name the first pane
  execSync(`tmux select-pane -t "${sessionName}:0.0" -T "Claude (Agent A)"`, { stdio: 'pipe' })

  if (layout === 'horizontal') {
    // Split right for codex
    execSync(`tmux split-window -h -t "${sessionName}:0.0"`, { stdio: 'pipe' })
    execSync(`tmux select-pane -t "${sessionName}:0.1" -T "Codex (Agent B)"`, { stdio: 'pipe' })
    // Split bottom of left pane for control
    execSync(`tmux split-window -v -t "${sessionName}:0.0" -l 12`, { stdio: 'pipe' })
    execSync(`tmux select-pane -t "${sessionName}:0.1" -T "Duck Control"`, { stdio: 'pipe' })
  } else {
    // Split bottom for codex
    execSync(`tmux split-window -v -t "${sessionName}:0.0"`, { stdio: 'pipe' })
    execSync(`tmux select-pane -t "${sessionName}:0.1" -T "Codex (Agent B)"`, { stdio: 'pipe' })
    // Split bottom again for control
    execSync(`tmux split-window -v -t "${sessionName}:0.1" -l 12`, { stdio: 'pipe' })
    execSync(`tmux select-pane -t "${sessionName}:0.2" -T "Duck Control"`, { stdio: 'pipe' })
  }

  const panes = listPanes(sessionName)

  return {
    name: sessionName,
    panes: {
      claude: panes[0] ?? '%0',
      codex: layout === 'horizontal' ? (panes[2] ?? '%2') : (panes[1] ?? '%1'),
      control: layout === 'horizontal' ? (panes[1] ?? '%1') : (panes[2] ?? '%2'),
    },
  }
}

export function writeToPane(paneId: string, text: string): void {
  // Use display-message or send raw text by echoing
  for (const line of text.split('\n')) {
    const escaped = line.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\$/g, '\\$').replace(/`/g, '\\`')
    try {
      execSync(`tmux send-keys -t "${paneId}" "echo \\"${escaped}\\"" Enter`, { stdio: 'pipe' })
    } catch {}
  }
}

export function clearPane(paneId: string): void {
  try {
    execSync(`tmux send-keys -t "${paneId}" "clear" Enter`, { stdio: 'pipe' })
  } catch {}
}

export function streamToPane(paneId: string, data: string): void {
  // Write raw data to pane using display-message for single lines
  // For streaming, we pipe directly
  const lines = data.split('\n')
  for (const line of lines) {
    if (!line) continue
    const escaped = line.replace(/'/g, "'\\''")
    try {
      execSync(`tmux display-message -t "${paneId}" -p '${escaped}'`, { stdio: 'pipe' })
    } catch {
      // Fallback: use send-keys with echo
      writeToPane(paneId, line)
    }
  }
}

export function setPaneTitle(paneId: string, title: string): void {
  try {
    execSync(`tmux select-pane -t "${paneId}" -T "${title}"`, { stdio: 'pipe' })
  } catch {}
}

export function attachToSession(sessionName: string): void {
  // Replace current process with tmux attach
  const child = spawn('tmux', ['attach-session', '-t', sessionName], {
    stdio: 'inherit',
  })
  child.on('exit', (code) => {
    process.exit(code ?? 0)
  })
}

export function killSession(sessionName: string): void {
  try {
    execSync(`tmux kill-session -t "${sessionName}"`, { stdio: 'pipe' })
  } catch {}
}

function listPanes(sessionName: string): string[] {
  try {
    const output = execSync(`tmux list-panes -t "${sessionName}" -F "#{pane_id}"`, { encoding: 'utf-8' })
    return output.trim().split('\n').filter(Boolean)
  } catch {
    return []
  }
}

export function runInPane(paneId: string, command: string): void {
  try {
    execSync(`tmux send-keys -t "${paneId}" "${command}" Enter`, { stdio: 'pipe' })
  } catch {}
}
