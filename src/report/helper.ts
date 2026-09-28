import { CATEGORY_LABEL, checkDoc } from '../checks/catalog.js'
import {
  summarize,
  type CheckContext,
  type CheckResult,
  type CheckSummary,
  type CheckStatus,
} from '../checks/types.js'
import { faqReference } from '../faq/reference.js'
import { faqUrl, formatDuration } from '../ui/output.js'
import { STATUS_ICON } from '../ui/theme.js'
import type { EnvironmentSnapshot } from '../util/environment.js'
import { canAccess, isDirectory } from '../util/fs-scan.js'
import { describePlatform } from '../util/platform.js'
import { redactWithStats } from '../util/redact.js'
import { doctorVersion } from '../util/version.js'
import { redactionNote, type LogExcerpt } from './support.js'

/**
 * Everything the detailed export needs. All of it is collected by the caller, so
 * this module stays a pure document builder that is cheap to test.
 */
export interface HelperReportInput {
  results: CheckResult[]
  context: CheckContext
  summary?: CheckSummary
  logs?: LogExcerpt[]
  generatedAt?: Date
  /** The `fbdoc env` snapshot, when one could be collected. */
  environment?: EnvironmentSnapshot | null
  /** Extra `label: value` rows for the At a glance table. */
  extra?: Array<[string, string]>
}

const STATUS_ORDER: Record<CheckStatus, number> = {
  fail: 0,
  warn: 1,
  skip: 2,
  pass: 3,
}

/** Longest run of backticks that may appear inside a fenced block. */
function fenceSafe(text: string): string {
  return text.replace(/`{3,}/g, (run) => '`'.repeat(run.length - 1))
}

/** A Markdown table cell: no pipes, no newlines, no trailing space. */
function cell(value: string): string {
  return value.replace(/\r?\n/g, ' ').replace(/\|/g, '\\|').trim()
}

function statusLine(result: CheckResult): string {
  return `${STATUS_ICON[result.status]} ${result.title}`
}

function linkFor(slug: string): string | null {
  const reference = faqReference(slug)
  if (!reference) return null
  return `[${reference.title}](${faqUrl(reference.slug)}) — \`${reference.command}\``
}

/** How a state directory looks right now, in one or two words. */
function describeDirectory(dir: string): string {
  if (!isDirectory(dir)) return 'not present'
  return canAccess(dir) ? 'present' : 'present, not readable'
}

function describeOutcome(summary: CheckSummary): string {
  const parts = [`${summary.pass} passed`]
  if (summary.warn > 0) parts.push(`${summary.warn} warning(s)`)
  if (summary.fail > 0) parts.push(`${summary.fail} failed`)
  if (summary.skip > 0) parts.push(`${summary.skip} skipped`)
  return `${summary.total} run · ${parts.join(' · ')}`
}

function verdict(summary: CheckSummary): string {
  if (summary.fail > 0) {
    return `❌ **${summary.fail} check${summary.fail === 1 ? '' : 's'} failed — start there.**`
  }
  if (summary.warn > 0) {
    return `⚠️ **No failures, but ${summary.warn} warning${summary.warn === 1 ? '' : 's'} worth a look.**`
  }
  return '✅ **No problems found. Every check passed.**'
}

/**
 * Builds the long-form report handed to a Freebuff helper, mod or support
 * member. Unlike the Discord-ready report this one is allowed to be long: it
 * carries every check, the environment, the raw payloads and the log tail, so
 * whoever reads it does not have to ask a second round of questions.
 *
 * Every free-text value is redacted on the way in and the finished document is
 * redacted once more as a safety net.
 */
export function buildHelperReport(input: HelperReportInput): string {
  const { results, context } = input
  const summary = input.summary ?? summarize(results)
  const generatedAt = input.generatedAt ?? new Date()
  const environment = input.environment ?? null
  const npmVersion = (results.find((result) => result.id === 'node-runtime')
    ?.data?.npmVersion ??
    environment?.npm ??
    'unknown') as string

  const ordered = [...results].sort(
    (a, b) => STATUS_ORDER[a.status] - STATUS_ORDER[b.status],
  )
  const problems = ordered.filter(
    (result) => result.status === 'fail' || result.status === 'warn',
  )
  const skipped = ordered.filter((result) => result.status === 'skip')
  const healthy = ordered.filter((result) => result.status === 'pass')

  const out: string[] = []
  const push = (...lines: string[]): void => {
    out.push(...lines)
  }

  push('# Freebuff Doctor — detailed report')
  push('')
  push(
    '> **Hand this file to a Freebuff helper, mod or support member.** It holds',
  )
  push(
    '> the diagnostic results, your environment and the recent engine log lines',
  )
  push('> they need to help you. Tokens, emails, credentials and your home')
  push('> directory were removed automatically.')
  push('')

  // --- At a glance ---------------------------------------------------------
  push('## At a glance')
  push('')
  push('| Field | Value |')
  push('| --- | --- |')
  push(`| Generated | ${generatedAt.toISOString()} |`)
  push(`| Doctor | freebuff-doctor ${doctorVersion()} |`)
  push(`| Operating system | ${describePlatform()} |`)
  push(`| Architecture | ${context.arch} |`)
  push(`| Node | ${context.nodeVersion} (npm ${npmVersion}) |`)
  push(`| Working directory | ${cell(environment?.cwd ?? context.cwd)} |`)
  push(`| Shell | ${cell(environment?.shell ?? 'unknown')} |`)
  push(`| Checks | ${describeOutcome(summary)} |`)
  push(`| Verdict | ${verdict(summary)} |`)
  push(
    `| Network checks | ${context.offline ? 'skipped (`--offline`)' : 'included'} |`,
  )
  for (const [label, value] of input.extra ?? []) {
    push(`| ${cell(label)} | ${cell(value)} |`)
  }
  push('')

  // --- Start here ----------------------------------------------------------
  push('## Start here')
  push('')
  if (problems.length === 0) {
    push('Nothing needs fixing — every check passed.')
  } else {
    push('These are the checks that reported a problem, worst first. The full')
    push('detail for each one is in the next section.')
    push('')
    problems.forEach((result, index) => {
      push(
        `${index + 1}. ${STATUS_ICON[result.status]} **${result.title}** (\`${result.id}\`)`,
      )
      push(`   ${result.message}`)
      if (result.fix) push(`   - fix: \`${result.fix}\``)
      if (result.faqSlug) {
        const link = linkFor(result.faqSlug)
        if (link) push(`   - FAQ: ${link}`)
      }
    })
  }
  push('')

  if (summary.nextAction) {
    push('**Suggested next step**')
    push('')
    push(summary.nextAction.message)
    if (summary.nextAction.fix) {
      push('')
      push('```')
      push(summary.nextAction.fix)
      push('```')
    }
    push('')
  }

  // --- Findings in detail --------------------------------------------------
  push('## Findings in detail')
  push('')
  if (problems.length === 0) {
    push('No failing or warning checks, so there is nothing to expand here.')
    push('')
  }
  for (const result of problems) {
    const doc = checkDoc(result.id)
    const category = doc ? CATEGORY_LABEL[doc.category] : 'Uncategorised'
    push(`### ${STATUS_ICON[result.status]} ${result.title}`)
    push('')
    push(`- **Check:** \`${result.id}\` · ${category}`)
    push(`- **What the doctor saw:** ${result.message}`)
    push(`- **Time:** ${formatDuration(result.durationMs)}`)
    if (result.fix) push(`- **Suggested fix:** \`${result.fix}\``)
    if (result.faqSlug) {
      const link = linkFor(result.faqSlug)
      if (link) push(`- **Read more:** ${link}`)
    }
    push('')
    if ((result.details ?? []).length > 0) {
      push('**Details**')
      push('')
      for (const detail of result.details ?? []) push(`- ${detail}`)
      push('')
    }
    if (doc) {
      push('**What this check looks at**')
      push('')
      for (const look of doc.looks) push(`- ${look}`)
      push('')
      push('**Why it matters**')
      push('')
      push(doc.why)
      push('')
    }
    if (result.data && Object.keys(result.data).length > 0) {
      push('**Raw data**')
      push('')
      push('```json')
      push(fenceSafe(JSON.stringify(result.data, null, 2)))
      push('```')
      push('')
    }
  }

  // --- Every check ---------------------------------------------------------
  push('## Every check')
  push('')
  push('| # | Status | Check | Id | What the doctor saw | Time |')
  push('| --- | --- | --- | --- | --- | --- |')
  ordered.forEach((result, index) => {
    push(
      `| ${index + 1} | ${STATUS_ICON[result.status]} ${result.status} | ${cell(result.title)} | \`${result.id}\` | ${cell(result.message)} | ${formatDuration(result.durationMs)} |`,
    )
  })
  push('')

  if (skipped.length > 0) {
    push('### Not checked')
    push('')
    for (const result of skipped) {
      push(`- ${result.title} (\`${result.id}\`) — ${result.message}`)
    }
    push('')
  }

  if (healthy.length > 0) {
    push('### Checks that passed')
    push('')
    for (const result of healthy) push(`- ${statusLine(result)}`)
    push('')
  }

  // --- Environment ---------------------------------------------------------
  push('## Environment')
  push('')
  push('### State directories')
  push('')
  push('| Directory | Path | State |')
  push('| --- | --- | --- |')
  const directories: Array<[string, string]> = [
    ['Config root', context.paths.configRoot],
    ['CLI state', context.paths.cliState],
    ['Desktop state', context.paths.desktopState],
    ['Legacy (Codebuff) state', context.paths.legacyState],
  ]
  for (const [label, dir] of directories) {
    push(`| ${label} | \`${cell(dir)}\` | ${describeDirectory(dir)} |`)
  }
  push('')

  const installs = context.paths.desktopInstalls.filter(isDirectory)
  push('**Desktop application bundles found:** ')
  push('')
  if (installs.length === 0) {
    push('_None._')
  } else {
    for (const install of installs) push(`- \`${install}\``)
  }
  push('')

  if (environment) {
    push('### Variables that affect Freebuff')
    push('')
    if (environment.variables.length === 0) {
      push(
        '_None of the variables that usually cause trouble are set on this machine._',
      )
    } else {
      push('| Variable | Value |')
      push('| --- | --- |')
      for (const variable of environment.variables) {
        push(`| \`${variable.name}\` | \`${cell(variable.value)}\` |`)
      }
    }
    push('')

    push(
      `### PATH, in search order (${environment.pathEntries.length} entries)`,
    )
    push('')
    push('```txt')
    for (const entry of environment.pathEntries) {
      const marker = entry.duplicate ? '   <- duplicate' : ''
      push(
        fenceSafe(
          `${String(entry.index).padStart(2)}. ${entry.value}${marker}`,
        ),
      )
    }
    push('```')
    push('')
  }

  // --- Logs ---------------------------------------------------------------
  const logs = input.logs ?? []
  push('## Recent engine log lines')
  push('')
  if (logs.length === 0) {
    push('_No engine log file was found, so there is nothing to show here._')
  } else {
    push('The last lines written by the engine, newest last.')
    push('')
    for (const excerpt of logs) {
      push(`_${excerpt.label}_`)
      push('')
      push('```txt')
      for (const line of excerpt.lines) push(fenceSafe(line))
      push('```')
      push('')
    }
  }
  push('')

  push('## What I have already tried')
  push('')
  push(
    '- _Add anything you have already attempted here: reinstalled, restarted, cleared the cache, re-logged in, switched network, …_',
  )
  push('')

  push('## Questions a helper will ask')
  push('')
  push('- When did this start, and did anything change around then?')
  push('- Does it happen on every launch, or only sometimes?')
  push(
    '- Which app is affected: Freebuff Desktop or the `freebuff` CLI, and which version?',
  )
  push('- What is the exact error message or screenshot?')
  push('- What did you expect to happen instead?')
  push('')

  push('## How to share this')
  push('')
  push(
    '- Attach this file to your Discord help thread, or open a GitHub issue and paste it in.',
  )
  push(
    '- You do not need to edit it. If you would rather not share the log lines, delete',
  )
  push('  that section first — the rest of the report still stands on its own.')
  push(
    '- Please keep the machine-readable section at the end: it lets a helper re-run',
  )
  push('  the same checks and compare.')
  push('')

  push('## Machine-readable results')
  push('')
  push('```json')
  push(
    fenceSafe(
      JSON.stringify(
        {
          meta: {
            doctor: doctorVersion(),
            node: context.nodeVersion,
            arch: context.arch,
            platform: context.platform,
            offline: context.offline,
            generatedAt: generatedAt.toISOString(),
          },
          summary,
          checks: results,
        },
        null,
        2,
      ),
    ),
  )
  push('```')
  push('')

  // Final pass over the assembled document as a belt-and-braces safety net.
  const { text, redactions, anonymized } = redactWithStats(
    out.join('\n'),
    context.home,
  )
  return [
    text,
    '',
    '## Redaction summary',
    '',
    redactions > 0
      ? `- **Values replaced:** ${redactions} (anything that looked like a token, email or credential).`
      : '- **Values replaced:** none — nothing looked like a token, email or credential.',
    anonymized
      ? '- **Home directory:** replaced with `~` throughout.'
      : '- **Home directory:** did not appear in the report.',
    '',
    '---',
    '',
    redactionNote(redactions, anonymized),
    '',
  ].join('\n')
}
