import { readdirSync, statSync, readFileSync, writeFileSync, unlinkSync, existsSync } from 'node:fs'
import { join, relative } from 'node:path'
import { createHash } from 'node:crypto'
import chalk from 'chalk'

export interface FileSnapshot {
  [relativePath: string]: string | null // hash or null if didn't exist
}

export function snapshotDirectory(dir: string, allowedFiles: string[]): FileSnapshot {
  const snapshot: FileSnapshot = {}
  try {
    collectFiles(dir, dir, snapshot)
  } catch {}
  return snapshot
}

export function validateScope(
  dir: string,
  preSnapshot: FileSnapshot,
  allowedFiles: string[],
): { violations: string[]; reverted: boolean } {
  const violations: string[] = []
  const currentSnapshot: FileSnapshot = {}

  try {
    collectFiles(dir, dir, currentSnapshot)
  } catch {}

  const allowedSet = new Set(allowedFiles.map(f => relative(dir, f)))

  // Check for modified files outside allowed set
  for (const [path, hash] of Object.entries(currentSnapshot)) {
    if (allowedSet.has(path)) continue
    const prevHash = preSnapshot[path]
    if (prevHash !== hash) {
      violations.push(path)
    }
  }

  // Check for new files outside allowed set
  for (const path of Object.keys(currentSnapshot)) {
    if (allowedSet.has(path)) continue
    if (!(path in preSnapshot)) {
      violations.push(path)
    }
  }

  if (violations.length > 0) {
    console.log(chalk.yellow(`  [scope] ${violations.length} unauthorized file change(s) detected:`))
    for (const v of violations) {
      console.log(chalk.yellow(`    - ${v}`))
    }
    // Revert: restore from pre-snapshot or delete new files
    for (const v of violations) {
      const fullPath = join(dir, v)
      if (v in preSnapshot && preSnapshot[v] !== null) {
        // File existed before — we can't restore content from hash alone
        // This is a warning; full revert requires artifact snapshots
        console.log(chalk.dim(`    (revert requires artifact snapshot)`))
      } else if (!(v in preSnapshot)) {
        // New file — delete it
        try {
          unlinkSync(fullPath)
          console.log(chalk.dim(`    deleted ${v}`))
        } catch {}
      }
    }
  }

  return { violations, reverted: violations.length > 0 }
}

function collectFiles(baseDir: string, dir: string, snapshot: FileSnapshot): void {
  const entries = readdirSync(dir, { withFileTypes: true })
  for (const entry of entries) {
    if (entry.name === 'node_modules' || entry.name === '.git' || entry.name === 'dist') continue
    const fullPath = join(dir, entry.name)
    if (entry.isDirectory()) {
      collectFiles(baseDir, fullPath, snapshot)
    } else if (entry.isFile()) {
      const relPath = relative(baseDir, fullPath)
      try {
        const content = readFileSync(fullPath)
        snapshot[relPath] = createHash('sha256').update(content).digest('hex')
      } catch {
        snapshot[relPath] = null
      }
    }
  }
}
