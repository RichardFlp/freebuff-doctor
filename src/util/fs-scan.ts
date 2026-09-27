import fs from 'node:fs'
import path from 'node:path'

export interface ScannedFile {
  path: string
  name: string
  size: number
  mtimeMs: number
}

/** `statSync` that returns `null` instead of throwing. */
export function safeStat(target: string): fs.Stats | null {
  try {
    return fs.statSync(target)
  } catch {
    return null
  }
}

export function exists(target: string): boolean {
  try {
    fs.accessSync(target)
    return true
  } catch {
    return false
  }
}

export function isDirectory(target: string): boolean {
  return safeStat(target)?.isDirectory() ?? false
}

/** `readdir` that returns `[]` instead of throwing. */
export function listDir(dir: string): fs.Dirent[] {
  try {
    return fs.readdirSync(dir, { withFileTypes: true })
  } catch {
    return []
  }
}

export function canAccess(
  target: string,
  mode: number = fs.constants.R_OK,
): boolean {
  try {
    fs.accessSync(target, mode)
    return true
  } catch {
    return false
  }
}

const SKIP_DIRECTORIES = new Set([
  'node_modules',
  '.git',
  '.cache',
  'Cache',
  'logs',
])

export interface WalkOptions {
  maxDepth?: number
  maxEntries?: number
  /** Only descend into directories whose name satisfies this predicate. */
  directoryFilter?: (name: string) => boolean
  /** Only collect files whose name satisfies this predicate. */
  fileFilter?: (name: string) => boolean
}

/**
 * Breadth-first search for files under `dir`. Never throws — unreadable
 * directories are skipped, which is what we want for a diagnostic tool.
 */
export function walkFiles(
  dir: string,
  options: WalkOptions = {},
): ScannedFile[] {
  const maxDepth = options.maxDepth ?? 3
  const maxEntries = options.maxEntries ?? 5000
  const results: ScannedFile[] = []
  const queue: Array<{ dir: string; depth: number }> = [{ dir, depth: 0 }]
  let visited = 0

  while (queue.length > 0 && visited < maxEntries) {
    const current = queue.shift()
    if (!current) break
    visited += 1

    for (const entry of listDir(current.dir)) {
      const full = path.join(current.dir, entry.name)
      let isDir = entry.isDirectory()
      let isFile = entry.isFile()
      if (entry.isSymbolicLink()) {
        const stat = safeStat(full)
        isDir = stat?.isDirectory() ?? false
        isFile = stat?.isFile() ?? false
      }
      if (isDir) {
        if (current.depth >= maxDepth) continue
        if (SKIP_DIRECTORIES.has(entry.name)) continue
        if (options.directoryFilter && !options.directoryFilter(entry.name))
          continue
        queue.push({ dir: full, depth: current.depth + 1 })
        continue
      }
      if (!isFile) continue
      if (options.fileFilter && !options.fileFilter(entry.name)) continue
      const stat = safeStat(full)
      results.push({
        path: full,
        name: entry.name,
        size: stat?.size ?? 0,
        mtimeMs: stat?.mtimeMs ?? 0,
      })
    }
  }

  return results
}

/** Total size in bytes of a directory tree, capped so huge trees stay cheap. */
export function directorySize(dir: string, maxEntries = 2000): number {
  let total = 0
  let seen = 0
  const queue: string[] = [dir]
  while (queue.length > 0 && seen < maxEntries) {
    const current = queue.shift()
    if (!current) break
    for (const entry of listDir(current)) {
      seen += 1
      const full = path.join(current, entry.name)
      if (entry.isDirectory()) {
        queue.push(full)
      } else if (entry.isFile()) {
        total += safeStat(full)?.size ?? 0
      }
    }
  }
  return total
}

/** Formats a byte count for humans. */
export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) return 'unknown'
  const units = ['B', 'KB', 'MB', 'GB', 'TB']
  let value = bytes
  let unit = 0
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024
    unit += 1
  }
  const rounded =
    value >= 10 || unit === 0 ? Math.round(value) : Number(value.toFixed(1))
  return `${rounded} ${units[unit]}`
}
