import fs from 'node:fs'
import path from 'node:path'

import { walkFiles } from '../util/fs-scan.js'
import { anonymizePath } from '../util/platform.js'
import { redactLine } from '../util/redact.js'
import { found, type DiagnosticCheck } from './types.js'

export const CRASH_LOG_NAME = 'orchestrator-stderr.log'

/** Patterns that indicate the engine actually died rather than logging chatter. */
const FATAL_PATTERNS: Array<{ label: string; pattern: RegExp }> = [
  {
    label: 'out of memory',
    pattern: /javascript heap out of memory|heap out of memory|ENOMEM/i,
  },
  {
    label: 'uncaught exception',
    pattern: /uncaught exception|uncaughtException/i,
  },
  {
    label: 'unhandled rejection',
    pattern: /unhandled rejection|unhandledRejection/i,
  },
  { label: 'stack overflow', pattern: /maximum call stack size exceeded/i },
  { label: 'disk full', pattern: /ENOSPC|no space left on device/i },
  {
    label: 'permission error',
    pattern: /EACCES|EPERM: operation not permitted/i,
  },
  { label: 'fatal error', pattern: /\bfatal\b/i },
  { label: 'panic', pattern: /\bpanic\b/i },
]

export interface CrashLogVerdict {
  fatal: boolean
  recent: boolean
  ageHours: number
  labels: string[]
  excerpts: string[]
}

/**
 * Reads the tail of a log without loading the whole file — crash logs can reach
 * hundreds of megabytes.
 */
export function readTail(file: string, maxBytes = 64 * 1024): string {
  try {
    const stat = fs.statSync(file)
    const length = Math.min(stat.size, maxBytes)
    if (length === 0) return ''
    const start = Math.max(0, stat.size - length)
    const handle = fs.openSync(file, 'r')
    try {
      const buffer = Buffer.alloc(length)
      fs.readSync(handle, buffer, 0, length, start)
      return buffer.toString('utf8')
    } finally {
      fs.closeSync(handle)
    }
  } catch {
    return ''
  }
}

/**
 * Pure classifier for a crash log: only a *recent* fatal entry is worth
 * surfacing, so an old crash from months ago does not raise a false alarm.
 */
export function classifyCrashLog(
  content: string,
  mtimeMs: number,
  now: number,
  recencyHours = 72,
): CrashLogVerdict {
  const lines = content.split(/\r?\n/).filter((line) => line.trim() !== '')
  const ageHours = Math.max(0, (now - mtimeMs) / 3_600_000)

  const labels = new Set<string>()
  const excerpts: string[] = []
  for (const line of lines) {
    // Every pattern is checked so a line like "FATAL ERROR: heap out of memory"
    // reports both what happened and how it was classified.
    const hits = FATAL_PATTERNS.filter((entry) => entry.pattern.test(line))
    if (hits.length === 0) continue
    for (const hit of hits) labels.add(hit.label)
    if (excerpts.length < 6 && !excerpts.includes(line)) excerpts.push(line)
  }

  return {
    fatal: labels.size > 0,
    recent: ageHours <= recencyHours,
    ageHours,
    labels: [...labels],
    excerpts,
  }
}

function formatAge(hours: number): string {
  if (hours < 1) return 'less than an hour'
  if (hours < 48) return `${Math.round(hours)} hours`
  return `${Math.round(hours / 24)} days`
}

/** Surfaces a recent fatal error from the engine's stderr log. */
export const crashLogCheck: DiagnosticCheck = {
  id: 'crash-log',
  title: 'Crash logs',
  async run(context) {
    const searchRoots = [
      context.paths.cliState,
      context.paths.desktopState,
      context.paths.legacyState,
    ]
    const candidates = searchRoots.flatMap((root) =>
      walkFiles(root, {
        maxDepth: 4,
        fileFilter: (name) => name === CRASH_LOG_NAME,
      }),
    )

    if (candidates.length === 0) {
      return found({
        status: 'pass',
        message: `No ${CRASH_LOG_NAME} found — there are no recorded engine crashes.`,
        data: { crashes: 0 },
      })
    }

    const newest = candidates.reduce((latest, file) =>
      file.mtimeMs > latest.mtimeMs ? file : latest,
    )
    const content = readTail(newest.path)
    const verdict = classifyCrashLog(content, newest.mtimeMs, Date.now())
    const show = anonymizePath(newest.path, context.home, context.platform)

    const data = {
      file: show,
      sizeBytes: newest.size,
      ageHours: Math.round(verdict.ageHours),
      fatal: verdict.fatal,
      labels: verdict.labels,
    }

    if (verdict.fatal && verdict.recent) {
      return found({
        status: 'fail',
        message: `${CRASH_LOG_NAME} recorded a fatal error (${verdict.labels.join(', ')}) ${formatAge(verdict.ageHours)} ago.`,
        details: verdict.excerpts.map((line) =>
          redactLine(line, 300, context.home),
        ),
        fix: 'Update Freebuff (or reinstall over the top), then retry — the FAQ lists this exact path',
        faqSlug: 'session--context-recovery',
        data,
      })
    }

    if (verdict.fatal) {
      return found({
        status: 'pass',
        message: `The last fatal error in ${CRASH_LOG_NAME} was ${formatAge(verdict.ageHours)} ago, so it is not current.`,
        details: [`Log: ${show}`],
        data,
      })
    }

    return found({
      status: 'pass',
      message: `No fatal errors in the recent ${CRASH_LOG_NAME} output.`,
      details: [`Log last written ${formatAge(verdict.ageHours)} ago: ${show}`],
      data,
    })
  },
}
