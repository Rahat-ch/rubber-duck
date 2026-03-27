import { execSync, spawnSync } from 'node:child_process'

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

export function launchInTmux(sessionName: string, layout: 'horizontal' | 'vertical', controlCommand: string): void {
  // Create session running the orchestrator command in the first pane (control)
  execSync(`tmux new-session -d -s "${sessionName}" -x 220 -y 60 "${controlCommand}"`, { stdio: 'pipe' })

  const initialPanes = listPanes(sessionName)
  const controlPane = initialPanes[0]

  if (layout === 'horizontal') {
    // Split right — this will be the claude pane (top-right)
    execSync(`tmux split-window -h -t "${controlPane}" "echo 'Claude (Agent A) — waiting for turn...'; cat"`, { stdio: 'pipe' })
    const afterFirst = listPanes(sessionName)
    const claudePane = afterFirst[1] // new pane is to the right

    // Split the right pane vertically — codex pane (bottom-right)
    execSync(`tmux split-window -v -t "${claudePane}" "echo 'Codex (Agent B) — waiting for turn...'; cat"`, { stdio: 'pipe' })
  } else {
    // Split bottom for claude
    execSync(`tmux split-window -v -t "${controlPane}" "echo 'Claude (Agent A) — waiting for turn...'; cat"`, { stdio: 'pipe' })
    const afterFirst = listPanes(sessionName)
    // Split again for codex
    execSync(`tmux split-window -v -t "${afterFirst[1]}" "echo 'Codex (Agent B) — waiting for turn...'; cat"`, { stdio: 'pipe' })
  }

  // Get final pane layout
  const panes = listPanes(sessionName)
  // Control is always pane 0 (where the orchestrator runs)
  setPaneTitle(panes[0], 'Duck Control')
  setPaneTitle(panes[1], 'Claude (Agent A)')
  setPaneTitle(panes[2] ?? panes[1], 'Codex (Agent B)')

  // Focus control pane but make agent panes visible
  execSync(`tmux select-pane -t "${panes[0]}"`, { stdio: 'pipe' })

  // Attach — this replaces the current process
  spawnSync('tmux', ['attach-session', '-t', sessionName], { stdio: 'inherit' })
}

export function writeToPane(paneId: string, text: string): void {
  // Write text to a pane by piping to its tty
  try {
    const tty = execSync(`tmux display-message -t "${paneId}" -p "#{pane_tty}"`, { encoding: 'utf-8' }).trim()
    if (tty) {
      // Write directly to the pane's tty
      for (const line of text.split('\n')) {
        execSync(`echo ${JSON.stringify(line)} > "${tty}"`, { stdio: 'pipe' })
      }
    }
  } catch {
    // Fallback: use send-keys
    try {
      const safe = text.replace(/\n/g, ' ').slice(0, 500)
      execSync(`tmux send-keys -t "${paneId}" "" Enter`, { stdio: 'pipe' })
    } catch {}
  }
}

export function clearPane(paneId: string): void {
  try {
    execSync(`tmux send-keys -t "${paneId}" "clear" Enter`, { stdio: 'pipe' })
  } catch {}
}

export function setPaneTitle(paneId: string, title: string): void {
  try {
    execSync(`tmux select-pane -t "${paneId}" -T "${title}"`, { stdio: 'pipe' })
  } catch {}
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

export function getPaneIds(sessionName: string): { claude: string; codex: string; control: string } | null {
  const panes = listPanes(sessionName)
  if (panes.length < 3) return null
  return { control: panes[0], claude: panes[1], codex: panes[2] }
}
