import path from 'node:path'

import { walkFiles } from '../util/fs-scan.js'
import { anonymizePath } from '../util/platform.js'
import { redactLine } from '../util/redact.js'
import { CRASH_LOG_NAME, readTail } from './crash-log.js'
import {
  found,
  type CheckContext,
  type DiagnosticCheck,
  type CheckStatus,
  type ResultInit,
} from './types.js'

/** How long ago a logged failure stops being treated as current. */
export const RECENT_HOURS = 24
/** Tails are capped so a multi-gigabyte log stays cheap to read. */
const TAIL_BYTES = 32 * 1024
const MAX_FILES = 8

export interface ErrorSignature {
  label: string
  pattern: RegExp
  /** `hard` failures cannot be recovered from without user action. */
  severity: 'hard' | 'soft'
  advice: string
  fix?: string
  faqSlug?: string
}

/**
 * Signatures worth reporting. Kept to failures a user can act on, and matched
 * against log tails only — never against chat transcripts, which contain
 * whatever code the user happened to paste.
 */
export const ERROR_SIGNATURES: ErrorSignature[] = [
  {
    label: 'out of memory',
    pattern: /javascript heap out of memory|ENOMEM|Cannot allocate memory/i,
    severity: 'hard',
    advice:
      'The engine ran out of memory. Close other apps, or raise the heap limit with NODE_OPTIONS=--max-old-space-size=4096.',
    fix: 'set NODE_OPTIONS=--max-old-space-size=4096',
    faqSlug: 'working-with-large-codebases',
  },
  {
    label: 'disk full',
    pattern: /ENOSPC|no space left on device|disk is full/i,
    severity: 'hard',
    advice: 'A write failed because the volume is full.',
    fix: 'Free up disk space, then re-run `fbdoc check`',
    faqSlug: 'session--context-recovery',
  },
  {
    label: 'database corrupt',
    pattern:
      /SQLITE_CORRUPT|database disk image is malformed|file is not a database/i,
    severity: 'hard',
    advice:
      'A local session database is damaged. Move it aside and let Freebuff rebuild it, keeping the original for recovery.',
    faqSlug: 'session--context-recovery',
  },
  {
    label: 'port already in use',
    pattern: /EADDRINUSE|address already in use/i,
    severity: 'hard',
    advice:
      'Something else already holds the local port, usually a Freebuff process from a previous run.',
    faqSlug: 'crash-on-start--updating',
  },
  {
    label: 'permission denied',
    pattern: /EACCES|EPERM|operation not permitted|access is denied/i,
    severity: 'hard',
    advice:
      'A file Freebuff needed could not be read or written by your user account.',
    faqSlug: 'troubleshooting-official',
  },
  {
    label: 'cannot find module',
    pattern: /Cannot find module|MODULE_NOT_FOUND/i,
    severity: 'hard',
    advice: 'Part of the install is missing, which a clean reinstall repairs.',
    fix: 'npm i -g freebuff@latest',
    faqSlug: 'troubleshooting-official',
  },
  {
    label: 'TLS certificate error',
    pattern:
      /UNABLE_TO_VERIFY_LEAF_SIGNATURE|SELF_SIGNED_CERT_IN_CHAIN|CERT_HAS_EXPIRED|unable to verify the first certificate/i,
    severity: 'hard',
    advice:
      'Certificate verification failed, which points at a proxy inspecting HTTPS traffic.',
    faqSlug: 'network-issues',
  },
  {
    label: 'connection reset',
    pattern: /ECONNRESET|socket hang up/i,
    severity: 'soft',
    advice:
      'A connection was cut mid-request — VPNs, proxies and antivirus are the usual culprits.',
    faqSlug: 'network-issues',
  },
  {
    label: 'request timed out',
    pattern: /ETIMEDOUT|UND_ERR_CONNECT_TIMEOUT|request timed out/i,
    severity: 'soft',
    advice: 'A request timed out before it completed.',
    faqSlug: 'network-issues',
  },
  {
    label: 'rate limited',
    pattern: /\b429\b|too many requests|rate limit/i,
    severity: 'soft',
    advice: 'The service asked the client to slow down.',
    faqSlug: 'freebucks-currency--daily-limits',
  },
]

export interface LogHit {
  label: string
  severity: 'hard' | 'soft'
  count: number
  excerpt: string
  advice: string
  fix?: string
  faqSlug?: string
}

export interface LogScan {
  hits: LogHit[]
  /** True when at least one hit came from a file written inside RECENT_HOURS. */
  recent: boolean
}

/** Finds every actionable signature in one log tail. */
export function scanLogTail(
  content: string,
  home?: string,
): { hits: LogHit[]; excerpts: string[] } {
  const lines = content.split(/\r?\n/).filter((line) => line.trim() !== '')
  const counts = new Map<string, number>()
  const excerpts: string[] = []

  for (const line of lines) {
    for (const signature of ERROR_SIGNATURES) {
      if (!signature.pattern.test(line)) continue
      counts.set(signature.label, (counts.get(signature.label) ?? 0) + 1)
      if (excerpts.length < 5) excerpts.push(redactLine(line, 240, home))
    }
  }

  const hits: LogHit[] = []
  for (const signature of ERROR_SIGNATURES) {
    const count = counts.get(signature.label)
    if (!count) continue
    const excerpt =
      excerpts.find((line) => signature.pattern.test(line)) ?? excerpts[0] ?? ''
    hits.push({
      label: signature.label,
      severity: signature.severity,
      count,
      excerpt,
      advice: signature.advice,
      ...(signature.fix ? { fix: signature.fix } : {}),
      ...(signature.faqSlug ? { faqSlug: signature.faqSlug } : {}),
    })
  }

  // Hard failures first, then the most frequent.
  hits.sort((a, b) => {
    if (a.severity !== b.severity) return a.severity === 'hard' ? -1 : 1
    return b.count - a.count
  })
  return { hits, excerpts }
}

export interface LogFileScan extends LogScan {
  files: Array<{ display: string; ageHours: number; hits: LogHit[] }>
}

export interface TriageObservation {
  files: LogFileScan['files']
  /** True when no log file was found at all. */
  nothingToScan: boolean
}

/** Pure verdict for what the most recent log tails contain. */
export function classifyTriage(observation: TriageObservation): ResultInit {
  const { files, nothingToScan } = observation

  if (nothingToScan || files.length === 0) {
    return {
      status: 'pass',
      message:
        'No readable log files were found, so there is nothing to triage.',
      details: [
        'The crash-log and session-log checks look for the same directories.',
      ],
    }
  }

  const allHits = files.flatMap((file) =>
    file.hits.map((hit) => ({
      ...hit,
      file: file.display,
      ageHours: file.ageHours,
    })),
  )

  if (allHits.length === 0) {
    return {
      status: 'pass',
      message: `No actionable errors in the last ${files.length} log${files.length === 1 ? '' : 's'}.`,
      details: files
        .slice(0, 3)
        .map(
          (file) =>
            `${file.display} — last written ${Math.round(file.ageHours)} hour${Math.round(file.ageHours) === 1 ? '' : 's'} ago`,
        ),
    }
  }

  const recent = allHits.some((hit) => hit.ageHours <= RECENT_HOURS)
  const hardRecent = allHits.find(
    (hit) => hit.severity === 'hard' && hit.ageHours <= RECENT_HOURS,
  )
  const top = hardRecent ?? allHits[0]
  if (!top) {
    return {
      status: 'pass',
      message: 'No actionable errors were found in the log tails.',
    }
  }

  const status: CheckStatus = hardRecent ? 'fail' : 'warn'
  const when = recent
    ? 'within the last day'
    : `about ${Math.round(top.ageHours / 24)} day${Math.round(top.ageHours / 24) === 1 ? '' : 's'} ago`

  const details = allHits
    .slice(0, 5)
    .map(
      (hit) =>
        `${hit.label} (${hit.count}× in ${hit.file}, ${Math.round(hit.ageHours)}h ago)`,
    )
  if (top.excerpt) details.push(`Example: ${top.excerpt}`)

  return {
    status,
    message: `Your logs recorded ${top.label} ${when} (${top.count} occurrence${top.count === 1 ? '' : 's'}), which is the most likely reason something failed.`,
    details: [...details, top.advice],
    ...(top.fix ? { fix: top.fix } : {}),
    ...(top.faqSlug ? { faqSlug: top.faqSlug } : {}),
    data: {
      findings: allHits.slice(0, 10).map((hit) => ({
        label: hit.label,
        severity: hit.severity,
        count: hit.count,
        file: hit.file,
        ageHours: Math.round(hit.ageHours),
      })),
    },
  }
}

/** Log files worth scanning — never chat transcripts, which hold pasted code. */
const LOG_FILE = /(\.log(\.\d+)?$|(^|[.-])(stderr|stdout)(\.[a-z0-9]+)?$)/i

/** Reads the newest log tails and reports the failure signatures they contain. */
export const errorTriageCheck: DiagnosticCheck = {
  id: 'error-triage',
  title: 'Recent errors in your logs',
  async run(context: CheckContext) {
    const roots = [
      context.paths.cliState,
      context.paths.desktopState,
      context.paths.legacyState,
    ]

    const candidates = roots.flatMap((root) =>
      walkFiles(root, {
        maxDepth: 4,
        maxEntries: 4000,
        // Chat transcripts contain whatever the user pasted, so they are
        // deliberately excluded; the crash log has its own check.
        directoryFilter: (name) => name !== 'chats',
        fileFilter: (name) => LOG_FILE.test(name) && name !== CRASH_LOG_NAME,
      }),
    )

    if (candidates.length === 0) {
      return found(classifyTriage({ files: [], nothingToScan: true }))
    }

    const newest = candidates
      .sort((a, b) => b.mtimeMs - a.mtimeMs)
      .slice(0, MAX_FILES)

    const now = Date.now()
    const files: LogFileScan['files'] = []
    for (const file of newest) {
      const content = readTail(file.path, TAIL_BYTES)
      if (!content.trim()) continue
      const scan = scanLogTail(content, context.home)
      files.push({
        display: anonymizePath(file.path, context.home, context.platform),
        ageHours: Math.max(0, (now - file.mtimeMs) / 3_600_000),
        hits: scan.hits,
      })
    }

    const withHits = files.filter((file) => file.hits.length > 0)
    const verdict = classifyTriage({
      files: withHits.length > 0 ? withHits : files,
      nothingToScan: files.length === 0,
    })

    return found({
      ...verdict,
      ...(verdict.details && files.length > withHits.length
        ? {
            details: [
              ...verdict.details,
              `Scanned ${files.length} log file${files.length === 1 ? '' : 's'} in total.`,
            ],
          }
        : {}),
      data: {
        ...(verdict.data ?? {}),
        scanned: files.map((file) => ({
          file: path.basename(file.display),
          ageHours: Math.round(file.ageHours),
          hits: file.hits.length,
        })),
      },
    })
  },
}
