import { execSync } from 'node:child_process'

export interface TmuxSession {
  name: string
  paneIds: { claude: string; codex: string; control: string }
}

export function isTmuxAvailable(): boolean {
  try {
    execSync('tmux -V', { stdio: 'pipe' })
    return true
  } catch {
    return false
  }
}

export function isInsideTmux(): boolean {
  return !!process.env.TMUX
}

export function createTmuxSession(sessionName: string, layout: 'horizontal' | 'vertical'): TmuxSession {
  execSync(`tmux new-session -d -s "${sessionName}" -x 200 -y 50`, { stdio: 'pipe' })

  if (layout === 'horizontal') {
    execSync(`tmux split-window -h -t "${sessionName}"`, { stdio: 'pipe' })
    execSync(`tmux split-window -v -t "${sessionName}:0.0"`, { stdio: 'pipe' })
  } else {
    execSync(`tmux split-window -v -t "${sessionName}"`, { stdio: 'pipe' })
    execSync(`tmux split-window -v -t "${sessionName}:0.0"`, { stdio: 'pipe' })
  }

  // Pane 0: Claude, Pane 1: Codex (or reversed based on split), Pane 2: Control
  const panes = listPanes(sessionName)

  return {
    name: sessionName,
    paneIds: {
      claude: panes[0] ?? '%0',
      codex: panes[1] ?? '%1',
      control: panes[2] ?? '%2',
    },
  }
}

export function sendToPane(paneId: string, text: string): void {
  const escaped = text.replace(/'/g, "'\\''")
  execSync(`tmux send-keys -t "${paneId}" '${escaped}' Enter`, { stdio: 'pipe' })
}

export function displayInPane(paneId: string, text: string): void {
  const lines = text.split('\n')
  for (const line of lines) {
    const escaped = line.replace(/'/g, "'\\''")
    execSync(`tmux send-keys -t "${paneId}" 'echo "${escaped}"' Enter`, { stdio: 'pipe' })
  }
}

export function killTmuxSession(sessionName: string): void {
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
