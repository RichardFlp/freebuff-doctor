import { CRASH_LOG_NAME, readTail } from '../checks/crash-log.js'
import {
  summarize,
  type CheckContext,
  type CheckResult,
  type CheckSummary,
  type CheckStatus,
} from '../checks/types.js'
import { STATUS_ICON } from '../ui/theme.js'
import { walkFiles } from '../util/fs-scan.js'
import { anonymizePath, describePlatform } from '../util/platform.js'
import { redact, redactLine, redactWithStats } from '../util/redact.js'
import { doctorVersion } from '../util/version.js'

export interface LogExcerpt {
  label: string
  lines: string[]
}

export interface SupportReportInput {
  results: CheckResult[]
  context: CheckContext
  summary?: CheckSummary
  logs?: LogExcerpt[]
  generatedAt?: Date
  /** Rows of `label: value` context to include. */
  extra?: Array<[string, string]>
}

const STATUS_ORDER: Record<CheckStatus, number> = {
  fail: 0,
  warn: 1,
  skip: 2,
  pass: 3,
}

function sectionIcon(status: CheckStatus): string {
  return STATUS_ICON[status]
}

/** Reads the most recent engine crash log tail, already redacted. */
export function collectLogExcerpts(
  context: CheckContext,
  maxLines = 25,
): LogExcerpt[] {
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
  if (candidates.length === 0) return []

  const newest = candidates.reduce((latest, file) =>
    file.mtimeMs > latest.mtimeMs ? file : latest,
  )
  const content = readTail(newest.path, 48 * 1024)
  const lines = content
    .split(/\r?\n/)
    .map((line) => line.trimEnd())
    .filter((line) => line !== '')
    .slice(-maxLines)
    .map((line) => redactLine(line, 300, context.home))

  if (lines.length === 0) return []
  return [
    {
      label: `${anonymizePath(newest.path, context.home, context.platform)} (last ${lines.length} lines)`,
      lines,
    },
  ]
}

/**
 * Builds a Discord-ready Markdown report. Every free-text value goes through the
 * redactor, and the assembled document is redacted once more as a safety net.
 */
export function buildSupportReport(input: SupportReportInput): string {
  const { results, context } = input
  const summary = input.summary ?? summarize(results)
  const generatedAt = input.generatedAt ?? new Date()
  const logs = input.logs ?? collectLogExcerpts(context)
  const npmVersion = (results.find((result) => result.id === 'node-runtime')
    ?.data?.npmVersion ?? 'unknown') as string

  const out: string[] = []
  out.push('**Freebuff Doctor report**')
  out.push('')
  out.push(`- **Generated:** ${generatedAt.toISOString()}`)
  out.push(`- **Doctor:** freebuff-doctor ${doctorVersion()}`)
  out.push(`- **OS:** ${describePlatform()}`)
  out.push(`- **Node:** ${context.nodeVersion} (npm ${npmVersion})`)
  out.push(`- **Outcome:** ${describeOutcome(summary)}`)
  const diskFree = results.find((result) => result.id === 'storage')?.data?.free
  if (typeof diskFree === 'string') out.push(`- **Disk free:** ${diskFree}`)
  for (const [label, value] of input.extra ?? []) {
    out.push(`- **${label}:** ${redact(value, context.home)}`)
  }
  out.push('')

  const ordered = [...results].sort(
    (a, b) => STATUS_ORDER[a.status] - STATUS_ORDER[b.status],
  )
  const problems = ordered.filter(
    (result) => result.status === 'fail' || result.status === 'warn',
  )
  const passing = ordered.filter(
    (result) => result.status === 'pass' || result.status === 'skip',
  )

  out.push('**Findings**')
  out.push('')
  if (problems.length === 0) {
    out.push('No problems found — every check passed.')
  } else {
    // Problems get the full detail; passing checks are compressed below to keep
    // the whole report short enough to paste into a single Discord message.
    for (const result of problems) {
      out.push(
        `${sectionIcon(result.status)} **${redact(result.title, context.home)}** — ${redact(result.message, context.home)}`,
      )
      for (const detail of result.details ?? []) {
        out.push(`  - ${redact(detail, context.home)}`)
      }
      if (result.fix)
        out.push(`  - _fix:_ \`${redact(result.fix, context.home)}\``)
      if (result.faqSlug) out.push(`  - _faq:_ \`${result.faqSlug}\``)
    }
  }
  out.push('')

  if (passing.length > 0) {
    out.push('**Passing checks**')
    out.push('')
    for (const result of passing) {
      out.push(
        `${sectionIcon(result.status)} ${redact(result.title, context.home)} — ${redact(result.message, context.home)}`,
      )
    }
    out.push('')
  }

  if (summary.nextAction) {
    out.push('**Suggested next step**')
    out.push('')
    out.push(redact(summary.nextAction.message, context.home))
    if (summary.nextAction.fix) out.push('')
    if (summary.nextAction.fix)
      out.push(
        '```' +
          '\n' +
          redact(summary.nextAction.fix, context.home) +
          '\n' +
          '```',
      )
    out.push('')
  }

  if (logs.length > 0) {
    out.push('**Recent engine log lines**')
    out.push('')
    for (const excerpt of logs) {
      out.push(`_${excerpt.label}_`)
      out.push('```txt')
      out.push(...excerpt.lines)
      out.push('```')
    }
    out.push('')
  }

  out.push('**What I have already tried**')
  out.push('')
  out.push('- _Add anything you have already attempted here._')
  out.push('')

  // Third pass over the assembled document as a belt-and-braces safety net.
  const { text, redactions, anonymized } = redactWithStats(
    out.join('\n'),
    context.home,
  )

  let note: string
  if (redactions > 0) {
    note = `_Redacted automatically by freebuff-doctor: ${redactions} value(s) that looked like a token, email or credential were replaced${anonymized ? ', and your home directory was replaced with ~' : ''}._`
  } else if (anonymized) {
    note =
      '_Checked by freebuff-doctor: nothing looked like a token, email or credential; your home directory was replaced with ~._'
  } else {
    note =
      '_Checked by freebuff-doctor: no tokens, emails, credentials or personal paths were found._'
  }

  return `${text}\n---\n${note}\n`
}

function describeOutcome(summary: CheckSummary): string {
  const parts = [`${summary.pass} passed`]
  if (summary.warn > 0)
    parts.push(`${summary.warn} warning${summary.warn === 1 ? '' : 's'}`)
  if (summary.fail > 0) parts.push(`${summary.fail} failed`)
  if (summary.skip > 0) parts.push(`${summary.skip} skipped`)
  return parts.join(', ')
}

/** Renders the check results as an aligned table (used by the CLI, not Discord). */
export function formatResultsTable(
  results: CheckResult[],
  width = 88,
): string[] {
  const rows = results.map((result) => ({
    status: result.status,
    label: result.title,
    message: result.message,
  }))
  const labelWidth = Math.min(
    Math.max(...rows.map((row) => row.label.length), 20),
    Math.floor(width / 2.2),
  )
  return rows.map((row) => {
    const label =
      row.label.length > labelWidth
        ? `${row.label.slice(0, labelWidth - 1)}…`
        : row.label
    return `${sectionIcon(row.status)} ${label.padEnd(labelWidth)}  ${row.message}`
  })
}
