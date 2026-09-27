import os from 'node:os'
import path from 'node:path'

import { exec } from '../util/exec.js'
import { formatBytes, walkFiles } from '../util/fs-scan.js'
import { CRASH_LOG_NAME, classifyCrashLog, readTail } from './crash-log.js'
import {
  found,
  type CheckContext,
  type DiagnosticCheck,
  type ResultInit,
} from './types.js'

/** Below this the engine starts hitting `EMFILE: too many open files`. */
export const WARN_FD_LIMIT = 128
export const FAIL_FD_LIMIT = 64
/** Free RAM below this is worth mentioning. */
export const LOW_FREE_MEM_BYTES = 512 * 1024 ** 2
/** Free RAM below this, alongside a recorded crash, tells one clear story. */
export const OOM_FREE_MEM_BYTES = 1024 ** 3
export const MIN_TOTAL_MEM_BYTES = 4 * 1024 ** 3
export const STRAY_PROCESS_WARN = 40

const PROCESS_NAMES = /^(node|nodejs|bun|freebuff|codebuff)(\.exe)?$/i

/** Reads a `ulimit -n`-style number. `unlimited` reports as null. */
export function parseFdLimit(text: string): number | null {
  const match = /^\s*(\d+)\s*$/m.exec(text)
  if (!match?.[1]) return null
  const value = Number(match[1])
  return Number.isFinite(value) && value > 0 ? value : null
}

/**
 * Counts live Node-family processes from `ps` or `tasklist` output, so the check
 * can spot sessions that were never closed and are still holding files open.
 */
export function countNodeProcesses(
  output: string,
  platform: NodeJS.Platform,
): number | null {
  if (!output.trim()) return 0
  if (platform === 'win32') {
    if (/no tasks are running/i.test(output)) return 0
    return output.split(/\r?\n/).filter((line) => /node\.exe/i.test(line))
      .length
  }

  let count = 0
  for (const line of output.split(/\r?\n/)) {
    const name = line.trim()
    if (!name) continue
    if (PROCESS_NAMES.test(path.basename(name))) count += 1
  }
  return count
}

export interface ResourceObservation {
  platform: NodeJS.Platform
  fdLimit: number | null
  freeBytes: number
  totalBytes: number
  nodeProcesses: number | null
  /** A fatal out-of-memory entry in the crash log, within the recency window. */
  recentOom: boolean
  oomAgeHours: number | null
}

interface Limit {
  severity: 'fail' | 'warn'
  message: string
  fix?: string
}

function memoryAge(hours: number): string {
  if (hours < 1) return 'less than an hour'
  if (hours < 48) return `${Math.round(hours)} hours`
  return `${Math.round(hours / 24)} days`
}

/**
 * Pure verdict for system headroom. The memory rules deliberately lean on the
 * crash log: low free RAM on its own is normal on a busy machine, but low free
 * RAM plus a recorded out-of-memory crash is a diagnosis.
 */
export function classifyLimits(observation: ResourceObservation): ResultInit {
  const limits: Limit[] = []
  const { fdLimit, freeBytes, totalBytes, nodeProcesses, recentOom } =
    observation

  if (recentOom && freeBytes < OOM_FREE_MEM_BYTES) {
    limits.push({
      severity: 'fail',
      message: `The engine ran out of memory${observation.oomAgeHours !== null ? ` ${memoryAge(observation.oomAgeHours)} ago` : ''}, and only ${formatBytes(freeBytes)} of ${formatBytes(totalBytes)} RAM is free — this is almost certainly the same problem.`,
      fix: 'Close memory-hungry apps, then restart Freebuff',
    })
  } else if (freeBytes < LOW_FREE_MEM_BYTES) {
    limits.push({
      severity: 'warn',
      message: `Only ${formatBytes(freeBytes)} of ${formatBytes(totalBytes)} RAM is free, which is tight for the engine.`,
      fix: 'Close memory-hungry apps before a long session',
    })
  }

  if (totalBytes > 0 && totalBytes < MIN_TOTAL_MEM_BYTES) {
    limits.push({
      severity: 'warn',
      message: `This machine has ${formatBytes(totalBytes)} of RAM; the FAQ recommends more for larger projects.`,
    })
  }

  const fdFix =
    observation.platform === 'win32'
      ? undefined
      : 'ulimit -n 4096   # then retry in the same terminal'
  if (fdLimit !== null && fdLimit < FAIL_FD_LIMIT) {
    limits.push({
      severity: 'fail',
      message: `The file-descriptor limit is only ${fdLimit}, so the engine will fail with "EMFILE: too many open files" during a large run.`,
      ...(fdFix ? { fix: fdFix } : {}),
    })
  } else if (fdLimit !== null && fdLimit < WARN_FD_LIMIT) {
    limits.push({
      severity: 'warn',
      message: `The file-descriptor limit is ${fdLimit}, which a large project can exhaust.`,
      ...(fdFix ? { fix: fdFix } : {}),
    })
  }

  if (nodeProcesses !== null && nodeProcesses > STRAY_PROCESS_WARN) {
    limits.push({
      severity: 'warn',
      message: `${nodeProcesses} Node processes are running, so a Freebuff session that never exited may still be holding project files.`,
      fix: 'Close stray terminals and editors, or restart your machine',
    })
  }

  const context = [
    `Memory: ${formatBytes(freeBytes)} free of ${formatBytes(totalBytes)}.`,
    fdLimit !== null
      ? `File-descriptor limit: ${fdLimit}.`
      : 'File-descriptor limit: not applicable on this platform.',
    nodeProcesses !== null
      ? `Node-family processes running: ${nodeProcesses}.`
      : 'Node process count could not be read.',
    recentOom
      ? `The crash log records an out-of-memory error${observation.oomAgeHours !== null ? ` from ${memoryAge(observation.oomAgeHours)} ago` : ''}.`
      : 'No recent out-of-memory crash was recorded.',
  ]

  const failing = limits.filter((limit) => limit.severity === 'fail')
  const primary = failing[0] ?? limits[0]

  if (!primary) {
    return {
      status: 'pass',
      message: `Headroom looks healthy — ${formatBytes(freeBytes)} free of ${formatBytes(totalBytes)} RAM.`,
      details: context,
    }
  }

  return {
    status: failing.length > 0 ? 'fail' : 'warn',
    message: primary.message,
    details: [
      // The primary limit is the message already, so details carry the rest.
      ...limits
        .filter((limit) => limit !== primary)
        .map((limit) => limit.message),
      ...context,
    ],
    ...(primary.fix ? { fix: primary.fix } : {}),
    faqSlug: recentOom
      ? 'crash-on-start--updating'
      : 'session--context-recovery',
  }
}

/** Whether a recent fatal out-of-memory entry exists in the crash log. */
function readRecentOom(context: CheckContext): {
  recentOom: boolean
  ageHours: number | null
} {
  const roots = [
    context.paths.cliState,
    context.paths.desktopState,
    context.paths.legacyState,
  ]
  const candidates = roots.flatMap((root) =>
    walkFiles(root, {
      maxDepth: 4,
      fileFilter: (name) => name === CRASH_LOG_NAME,
    }),
  )
  if (candidates.length === 0) return { recentOom: false, ageHours: null }

  const newest = candidates.reduce((latest, file) =>
    file.mtimeMs > latest.mtimeMs ? file : latest,
  )
  const verdict = classifyCrashLog(
    readTail(newest.path),
    newest.mtimeMs,
    Date.now(),
  )
  const outOfMemory = verdict.labels.includes('out of memory')
  return {
    recentOom: outOfMemory && verdict.recent,
    ageHours: outOfMemory ? Math.round(verdict.ageHours) : null,
  }
}

/**
 * Checks process, file-descriptor and memory headroom, and ties a recorded
 * out-of-memory crash back to the memory that is actually available now.
 */
export const resourceLimitsCheck: DiagnosticCheck = {
  id: 'resource-limits',
  title: 'Memory, file descriptors and processes',
  async run(context: CheckContext) {
    const timeoutMs = Math.min(Math.max(context.timeoutMs, 3000), 15_000)

    let fdLimit: number | null = null
    if (context.platform !== 'win32') {
      const result = await exec('sh', ['-c', 'ulimit -n'], { timeoutMs })
      if (result.ok) fdLimit = parseFdLimit(result.stdout)
    }

    const processList =
      context.platform === 'win32'
        ? await exec(
            'tasklist',
            ['/FI', 'IMAGENAME eq node.exe', '/FO', 'CSV', '/NH'],
            { timeoutMs },
          )
        : await exec('ps', ['-eo', 'comm='], { timeoutMs })
    const nodeProcesses = processList.ok
      ? countNodeProcesses(processList.stdout, context.platform)
      : null

    const freeBytes = os.freemem()
    const totalBytes = os.totalmem()
    // The crash log is only worth reading when memory actually looks tight.
    const oom =
      freeBytes < OOM_FREE_MEM_BYTES
        ? readRecentOom(context)
        : { recentOom: false, ageHours: null }

    const observation: ResourceObservation = {
      platform: context.platform,
      fdLimit,
      freeBytes,
      totalBytes,
      nodeProcesses,
      recentOom: oom.recentOom,
      oomAgeHours: oom.ageHours,
    }

    const verdict = classifyLimits(observation)
    return found({
      ...verdict,
      data: {
        fdLimit,
        freeBytes,
        totalBytes,
        free: formatBytes(freeBytes),
        nodeProcesses,
        recentOom: oom.recentOom,
        oomAgeHours: oom.ageHours,
      },
    })
  },
}
