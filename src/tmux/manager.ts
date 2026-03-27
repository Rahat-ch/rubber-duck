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
  // Create session — this gives us one pane
  execSync(`tmux new-session -d -s "${sessionName}" -x 220 -y 60`, { stdio: 'pipe' })

  // Get the initial pane ID
  const initialPanes = listPanes(sessionName)
  const firstPane = initialPanes[0]

  if (layout === 'horizontal') {
    // Split right for codex pane
    execSync(`tmux split-window -h -t "${firstPane}"`, { stdio: 'pipe' })
    // Split bottom of left (first) pane for control
    execSync(`tmux split-window -v -t "${firstPane}" -l 12`, { stdio: 'pipe' })
  } else {
    // Split bottom for codex pane
    execSync(`tmux split-window -v -t "${firstPane}"`, { stdio: 'pipe' })
    // Split bottom again for control
    const midPanes = listPanes(sessionName)
    execSync(`tmux split-window -v -t "${midPanes[1]}" -l 12`, { stdio: 'pipe' })
  }

  // Get final pane IDs after all splits
  const panes = listPanes(sessionName)
  // horizontal layout: split-h creates pane to the right, split-v on first creates pane below first
  // panes[0] = top-left (claude), panes[1] = bottom-left (control), panes[2] = right (codex)
  const claudePane = panes[0]
  const codexPane = layout === 'horizontal' ? panes[2] : panes[1]
  const controlPane = layout === 'horizontal' ? panes[1] : panes[2]

  // Set pane titles using actual pane IDs
  setPaneTitle(claudePane, 'Claude (Agent A)')
  setPaneTitle(codexPane, 'Codex (Agent B)')
  setPaneTitle(controlPane, 'Duck Control')

  return {
    name: sessionName,
    panes: {
      claude: claudePane,
      codex: codexPane,
      control: controlPane,
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
