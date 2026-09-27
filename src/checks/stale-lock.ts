import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { listDir, safeStat } from '../util/fs-scan.js'
import { anonymizePath } from '../util/platform.js'
import {
  found,
  type CheckContext,
  type CheckStatus,
  type DiagnosticCheck,
  type ResultInit,
} from './types.js'

/** A lock untouched for this long with no live owner is treated as stale. */
export const STALE_LOCK_HOURS = 6

/** Lock-ish file names, including the Electron/Chromium singleton markers. */
const LOCK_NAME =
  /(\.lock|\.lck|\.lockfile|\.pid)$|^(\.?lock|SingletonLock|SingletonSocket|SingletonCookie)$/i

export interface LockOwner {
  pid: number | null
  /** Set for Chromium-style `<hostname>-<pid>` markers. */
  hostname: string | null
}

/**
 * Reads the owner out of a lock or pid file. Handles the three shapes seen in the
 * wild: a bare pid, an explicit `pid=1234`/`{"pid":1234}`, and Chromium's
 * `<hostname>-<pid>` singleton markers.
 */
export function parseLockOwner(content: string): LockOwner {
  const text = content.trim()
  if (!text) return { pid: null, hostname: null }

  const singleton = /^(.*)-(\d+)$/.exec(text)
  if (singleton?.[1] && singleton[2]) {
    return { pid: Number(singleton[2]), hostname: singleton[1] }
  }

  const json = /"pid"\s*:\s*"?(\d+)"?/.exec(text)
  if (json?.[1]) return { pid: Number(json[1]), hostname: null }

  const keyed = /\bpid\s*[=:]\s*"?(\d+)"?/i.exec(text)
  if (keyed?.[1]) return { pid: Number(keyed[1]), hostname: null }

  const firstLine = text.split(/\r?\n/)[0]?.trim() ?? ''
  if (/^\d{1,10}$/.test(firstLine))
    return { pid: Number(firstLine), hostname: null }

  return { pid: null, hostname: null }
}

/** True when a process with this pid exists (including one we may not signal). */
export function isProcessAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    // EPERM means the process exists but belongs to another user.
    return (error as NodeJS.ErrnoException).code === 'EPERM'
  }
}

export interface LockObservation {
  owner: LockOwner
  /** Result of probing the recorded pid; null when the file named no pid. */
  alive: boolean | null
  ageHours: number
  /** This machine's hostname. */
  hostname: string
}

export interface LockVerdict {
  status: CheckStatus
  stale: boolean
  message: string
}

/**
 * Pure verdict for a single lock file. A lock whose owner is gone, or which was
 * written on another machine, is stale and will block the next launch; a lock
 * held by a running process is a warning, because that process may be a genuine
 * second instance.
 */
export function classifyLock(observation: LockObservation): LockVerdict {
  const { owner, alive, ageHours, hostname } = observation
  const age =
    ageHours < 1
      ? `${Math.round(ageHours * 60)} minutes`
      : ageHours < 48
        ? `${Math.round(ageHours)} hours`
        : `${Math.round(ageHours / 24)} days`

  if (owner.hostname && hostname && owner.hostname !== hostname) {
    return {
      status: 'fail',
      stale: true,
      message: `A lock file was written on a different machine (${owner.hostname}) ${age} ago, so it can never be released on this one.`,
    }
  }

  if (alive === true) {
    return {
      status: 'warn',
      stale: false,
      message: `A lock is held by a running process (pid ${owner.pid}), so another Freebuff instance may already be using this project.`,
    }
  }

  if (alive === false) {
    return {
      status: 'fail',
      stale: true,
      message: `A stale lock file belongs to pid ${owner.pid}, which is no longer running — Freebuff will refuse to start until it is removed.`,
    }
  }

  if (ageHours >= STALE_LOCK_HOURS) {
    return {
      status: 'fail',
      stale: true,
      message: `A lock file has not been touched for ${age} and names no live process — Freebuff will refuse to start until it is removed.`,
    }
  }

  return {
    status: 'warn',
    stale: false,
    message: `A lock file was created ${age} ago and does not name a process; if Freebuff will not start, removing it is the first thing to try.`,
  }
}

export interface LockCandidate {
  path: string
  /** Lock directories (mkdir-based locks) are reported but not read. */
  directory: boolean
  /** Latest known mtime, 0 when unknown. */
  mtimeMs: number
}

/** Lock files directly inside a state directory and inside each project folder. */
export function collectLockCandidates(stateDir: string): LockCandidate[] {
  const candidates: LockCandidate[] = []

  const inspect = (dir: string, entry: fs.Dirent): void => {
    if (!LOCK_NAME.test(entry.name)) return
    if (!entry.isFile() && !entry.isDirectory() && !entry.isSymbolicLink())
      return
    const full = path.join(dir, entry.name)
    const stat = safeStat(full)
    candidates.push({
      path: full,
      directory: stat?.isDirectory() ?? false,
      mtimeMs: stat?.mtimeMs ?? 0,
    })
  }

  for (const entry of listDir(stateDir)) inspect(stateDir, entry)

  const projectsDir = path.join(stateDir, 'projects')
  for (const project of listDir(projectsDir)) {
    if (!project.isDirectory()) continue
    const projectDir = path.join(projectsDir, project.name)
    for (const entry of listDir(projectDir)) inspect(projectDir, entry)
  }

  return candidates
}

function readHead(file: string, maxBytes = 4096): string {
  try {
    const handle = fs.openSync(file, 'r')
    try {
      const buffer = Buffer.alloc(maxBytes)
      const read = fs.readSync(handle, buffer, 0, maxBytes, 0)
      return buffer.subarray(0, read).toString('utf8')
    } finally {
      fs.closeSync(handle)
    }
  } catch {
    return ''
  }
}

export interface StaleLockFinding {
  display: string
  path: string
  verdict: LockVerdict
  ageHours: number
  pid: number | null
  alive: boolean | null
}

/** Builds the aggregate result from per-file findings. */
export function summarizeLocks(
  findings: StaleLockFinding[],
  platform: NodeJS.Platform,
): ResultInit {
  const stale = findings.filter((finding) => finding.verdict.stale)
  const held = findings.filter((finding) => finding.verdict.status === 'warn')

  if (stale.length > 0) {
    const first = stale[0] as StaleLockFinding
    return {
      status: 'fail',
      message: `${first.verdict.message} (${first.display})`,
      details: [
        ...others(findings, first),
        'Removing a stale lock file is safe; Freebuff recreates it on the next run.',
      ],
      fix: platform === 'win32' ? `del "${first.path}"` : `rm "${first.path}"`,
      faqSlug: 'crash-on-start--updating',
    }
  }

  if (held.length > 0) {
    const first = held[0] as StaleLockFinding
    return {
      status: 'warn',
      message: `${first.verdict.message} (${first.display})`,
      details: [
        ...others(findings, first),
        'Close every Freebuff window and try again before deleting anything.',
      ],
      faqSlug: 'crash-on-start--updating',
    }
  }

  return {
    status: 'pass',
    message: `Found ${findings.length} lock file${findings.length === 1 ? '' : 's'} and every one belongs to a live owner.`,
    details: findings.map(
      (finding) => `${finding.display} — ${finding.verdict.message}`,
    ),
  }
}

/** Detail lines for every finding except the one already in the message. */
function others(
  findings: StaleLockFinding[],
  primary: StaleLockFinding,
): string[] {
  return findings
    .filter((finding) => finding !== primary)
    .map((finding) => `${finding.display} — ${finding.verdict.message}`)
}

/**
 * Looks for lock and pid files left behind by a crashed session. A stale lock
 * blocks every later launch with a "cannot acquire project lock" error, so it is
 * worth finding before the user hits it.
 */
export const staleLockCheck: DiagnosticCheck = {
  id: 'stale-lock',
  title: 'Orphaned locks and processes',
  async run(context: CheckContext) {
    const stateDirs = [
      context.paths.cliState,
      context.paths.desktopState,
      context.paths.legacyState,
    ]
    const hostname = os.hostname()
    const now = Date.now()

    const candidates: LockCandidate[] = []
    for (const dir of stateDirs) {
      for (const candidate of collectLockCandidates(dir)) {
        if (!candidates.some((entry) => entry.path === candidate.path)) {
          candidates.push(candidate)
        }
      }
    }

    const findings: StaleLockFinding[] = candidates.map((candidate) => {
      const ageHours =
        candidate.mtimeMs > 0
          ? Math.max(0, (now - candidate.mtimeMs) / 3_600_000)
          : 0
      const owner = candidate.directory
        ? { pid: null, hostname: null }
        : parseLockOwner(readHead(candidate.path))
      const alive = owner.pid !== null ? isProcessAlive(owner.pid) : null
      const verdict = classifyLock({
        owner,
        alive,
        ageHours,
        hostname,
      })
      return {
        display: anonymizePath(candidate.path, context.home, context.platform),
        path: candidate.path,
        verdict,
        ageHours: Math.round(ageHours * 10) / 10,
        pid: owner.pid,
        alive,
      }
    })

    const data = {
      locks: findings.map((finding) => ({
        path: finding.display,
        pid: finding.pid,
        alive: finding.alive,
        ageHours: finding.ageHours,
        stale: finding.verdict.stale,
      })),
      hostname: anonymizePath(hostname, context.home, context.platform),
    }

    if (findings.length === 0) {
      return found({
        status: 'pass',
        message: 'No lock or pid files found — nothing is blocking a launch.',
        data,
      })
    }

    return found({ ...summarizeLocks(findings, context.platform), data })
  },
}
