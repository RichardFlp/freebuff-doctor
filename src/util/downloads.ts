import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { canAccess, isDirectory } from './fs-scan.js'

/**
 * Reads the `XDG_DOWNLOAD_DIR` entry from an XDG `user-dirs.dirs` file, so a
 * Linux user who relocated their Downloads folder still gets the file there.
 * Returns `null` when the file does not name one.
 */
export function parseUserDirs(content: string, home: string): string | null {
  for (const raw of content.split(/\r?\n/)) {
    const line = raw.trim()
    if (line === '' || line.startsWith('#')) continue
    const match = /^XDG_DOWNLOAD_DIR\s*=\s*"?([^"]*)"?\s*$/.exec(line)
    const value = match?.[1]?.trim()
    if (!value) continue
    // The file records `$HOME/...`; that is the only variable it may expand.
    if (value === '$HOME') return home
    if (value.startsWith('$HOME/')) {
      return path.join(home, value.slice('$HOME/'.length))
    }
    return value
  }
  return null
}

/** The `user-dirs.dirs` download entry, or `null` when there is nothing to read. */
function xdgDownloadDir(home: string, env: NodeJS.ProcessEnv): string | null {
  const configRoot = env.XDG_CONFIG_HOME?.trim() || path.join(home, '.config')
  try {
    return parseUserDirs(
      fs.readFileSync(path.join(configRoot, 'user-dirs.dirs'), 'utf8'),
      home,
    )
  } catch {
    return null
  }
}

/**
 * Directories worth trying, most likely first: the platform's Downloads folder,
 * then the home directory, then the working directory. Pure — no filesystem
 * access — so it can be asserted per platform.
 */
export function downloadsCandidates(
  home: string = os.homedir(),
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
): string[] {
  const candidates: string[] = []
  if (platform === 'linux') {
    const configured = xdgDownloadDir(home, env)
    if (configured) candidates.push(configured)
  }
  // Windows and macOS also allow a relocated Downloads folder, but only through
  // the registry or Finder, so the profile default is the sane guess there.
  if (home) candidates.push(path.join(home, 'Downloads'))
  for (const fallback of [home, process.cwd()]) {
    if (fallback) candidates.push(fallback)
  }
  return [...new Set(candidates)]
}

export interface DownloadsResolution {
  /** Where the report should be written. */
  dir: string
  /** True when an existing, writable directory was found. */
  writable: boolean
  /** Every directory considered, in order, for `--verbose` output. */
  considered: string[]
}

/**
 * Picks the directory to save exports in. Falls back eventually to the working
 * directory, so a write is always attempted somewhere rather than failing on a
 * machine with no Downloads folder at all.
 */
export function resolveDownloadsDir(
  home: string = os.homedir(),
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
): DownloadsResolution {
  const candidates = downloadsCandidates(home, env, platform)
  const usable = candidates.find(
    (dir) => isDirectory(dir) && canAccess(dir, fs.constants.W_OK),
  )
  return {
    dir: usable ?? candidates[0] ?? process.cwd(),
    writable: usable !== undefined,
    considered: candidates,
  }
}

/** `freebuff-doctor-report-2026-09-28-153012.md`, in local time. */
export function reportFileName(at: Date = new Date()): string {
  const pad = (value: number): string => String(value).padStart(2, '0')
  const date = [
    at.getFullYear(),
    pad(at.getMonth() + 1),
    pad(at.getDate()),
  ].join('-')
  const clock = [
    pad(at.getHours()),
    pad(at.getMinutes()),
    pad(at.getSeconds()),
  ].join('')
  return `freebuff-doctor-report-${date}-${clock}.md`
}
