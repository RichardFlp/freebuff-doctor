import type { CheckResult, CheckSummary, CheckStatus } from '../checks/types.js'
import { faqReference } from '../faq/reference.js'
import type { FaqSection } from '../faq/loader.js'
import { renderMarkdown, renderMarkdownPlain, wrap } from '../util/markdown.js'
import { padTo, stringWidth, truncate } from '../util/width.js'
import {
  c,
  colorEnabled,
  GLYPH,
  hyperlink,
  isInteractive,
  isVerbose,
  STATUS_ICON,
  STATUS_LABEL,
  terminalWidth,
} from './theme.js'

/** Writes a line to stdout, which is the machine-readable stream. */
export function write(line = ''): void {
  process.stdout.write(`${line}\n`)
}

/** Writes a line to stderr, used for progress and warnings that aren't results. */
export function writeErr(line = ''): void {
  process.stderr.write(`${line}\n`)
}

export function statusIcon(status: CheckStatus): string {
  return STATUS_ICON[status]
}

/** `✅ Node.js and npm` — the header line of a single check result. */
export function formatResultHeader(result: CheckResult): string {
  return `${STATUS_ICON[result.status]} ${c().bold(result.title)}`
}

function indentFor(label: string, body: string): string {
  return `   ${c().dim(label)}  ${body}`
}

/** Human-readable duration, e.g. `420ms` or `1.4s`. */
export function formatDuration(ms: number): string {
  if (ms < 1000) return `${Math.round(ms)}ms`
  return `${(ms / 1000).toFixed(1)}s`
}

/**
 * A timing note for a result header. Fast checks stay quiet unless `--verbose`
 * was asked for, so the report does not fill up with noise.
 */
export function durationNote(ms: number, always = false): string {
  if (!always && ms < 250) return ''
  return ` ${c().dim(`${GLYPH.timer} ${formatDuration(ms)}`)}`
}

/**
 * A progress bar for long runs, e.g. `▰▰▰▰▱▱▱▱▱▱ 12/30`. Uses block
 * characters rather than colour, so it survives a monochrome terminal.
 */
export function progressBar(
  completed: number,
  total: number,
  width = 14,
): string {
  if (total <= 0) return ''
  const safeTotal = Math.max(total, 1)
  const ratio = Math.min(Math.max(completed / safeTotal, 0), 1)
  const filled = Math.round(ratio * width)
  const bar = `${'\u25b0'.repeat(filled)}${'\u25b1'.repeat(Math.max(0, width - filled))}`
  return `${bar} ${String(completed).padStart(String(safeTotal).length)}/${safeTotal}`
}

/** A lighter-weight section heading used to group check results. */
export function groupHeading(text: string, note?: string): void {
  write(`${c().bold(text)}${note ? ` ${c().dim(note)}` : ''}`)
}

/**
 * One compact line per group of results that need no explanation, so a clean
 * run of thirty checks does not scroll the interesting parts off the screen.
 */
export function printCompactList(
  label: string,
  results: CheckResult[],
  note?: string,
): void {
  if (results.length === 0) return
  const ids = results.map((result) => result.id).join('  \u00b7  ')
  write(
    `${c().dim(GLYPH.bullet)} ${c().bold(label)}${note ? ` ${c().dim(note)}` : ''}`,
  )
  for (const line of wrap(ids, terminalWidth() - 4)) {
    write(`  ${c().dim(line)}`)
  }
}

/**
 * Prints one check result: a status line, the explanation, any extra context,
 * and the two things a user can act on — a fix command and the FAQ section.
 */
export function printResult(
  result: CheckResult,
  options: { width?: number; timings?: boolean } = {},
): void {
  const width = options.width ?? terminalWidth()
  write(
    `${formatResultHeader(result)}${durationNote(result.durationMs, options.timings ?? isVerbose())}`,
  )
  for (const line of wrap(result.message, width - 3)) {
    write(`   ${line}`)
  }
  for (const detail of result.details ?? []) {
    for (const [index, line] of wrap(detail, width - 6).entries()) {
      write(`   ${index === 0 ? c().dim(GLYPH.chevron) : ' '} ${c().dim(line)}`)
    }
  }
  if (result.fix) {
    write(indentFor('fix', c().cyan(result.fix)))
  }
  if (result.faqSlug) {
    const reference = faqReference(result.faqSlug)
    if (reference) {
      write(
        indentFor(
          'faq',
          `${hyperlink(reference.title, faqUrl(reference.slug))} ${c().dim(`(${reference.command})`)}`,
        ),
      )
    }
  }
  // Every problem can be explained on its own, which is what makes a support
  // thread self-serve rather than a screenshot.
  if (result.status === 'fail' || result.status === 'warn') {
    write(indentFor('why', c().dim(`fbdoc explain ${result.id}`)))
  }
}

/** Deep link into the FAQ section on GitHub, used for OSC-8 hyperlinks. */
export function faqUrl(slug: string): string {
  return `https://github.com/RichardFlp/freebuff-doctor/blob/main/faq.md#${slug}`
}

export interface SummaryOptions {
  /** Shown above the counts, e.g. `Freebuff Doctor`. */
  title?: string
  /** Extra closing hint lines. */
  footer?: string[]
}

/**
 * Draws the end-of-run summary box: counts, then the single most important
 * next action. Degrades to plain lines when piped or colourless.
 */
export async function printSummary(
  summary: CheckSummary,
  options: SummaryOptions = {},
): Promise<void> {
  const title = options.title ?? 'Freebuff Doctor'
  const lines: string[] = []

  const counts: string[] = []
  if (summary.pass > 0) counts.push(c().green(`${summary.pass} passed`))
  if (summary.warn > 0)
    counts.push(
      c().yellow(`${summary.warn} warning${summary.warn === 1 ? '' : 's'}`),
    )
  if (summary.fail > 0) counts.push(c().red(`${summary.fail} failed`))
  if (summary.skip > 0) counts.push(c().dim(`${summary.skip} skipped`))
  if (counts.length === 0) counts.push(c().dim('no checks ran'))

  lines.push(
    `${c().bold(String(summary.total))} checks · ${counts.join(c().dim(' · '))}`,
  )
  lines.push('')

  if (summary.nextAction) {
    const label = summary.fail > 0 ? c().red('Next') : c().yellow('Next')
    for (const [index, line] of wrap(
      summary.nextAction.message,
      terminalWidth() - 14,
    ).entries()) {
      lines.push(`${index === 0 ? `${label}  ` : '      '}${line}`)
    }
    if (summary.nextAction.fix) {
      lines.push(`${c().dim('Run')}   ${c().cyan(summary.nextAction.fix)}`)
    }
    if (summary.nextAction.faqSlug) {
      const reference = faqReference(summary.nextAction.faqSlug)
      if (reference) {
        lines.push(
          `${c().dim('FAQ')}   ${hyperlink(reference.title, faqUrl(reference.slug))}`,
        )
        lines.push(`      ${c().dim(reference.command)}`)
      }
    }
  } else {
    lines.push(`${c().green('All clear')} — nothing needs your attention.`)
  }

  for (const footer of options.footer ?? []) {
    lines.push('')
    for (const line of wrap(footer, terminalWidth() - 14)) lines.push(line)
  }

  const borderColor: 'green' | 'yellow' | 'red' =
    summary.fail > 0 ? 'red' : summary.warn > 0 ? 'yellow' : 'green'
  if (isInteractive() && colorEnabled()) {
    const { default: boxen } = await import('boxen')
    write(
      boxen(lines.join('\n'), {
        title,
        titleAlignment: 'left',
        borderStyle: 'round',
        borderColor,
        padding: { top: 0, bottom: 0, left: 1, right: 2 },
        margin: { top: 1, bottom: 1, left: 0, right: 0 },
      }),
    )
    return
  }

  // Plain fallback: no box drawing characters, so `| grep` and CI logs stay clean.
  write('')
  write(c().bold(title))
  write(lines.filter((line, index) => line !== '' || index > 0).join('\n'))
  write('')
}

/** Prints a FAQ section with its heading, rendered markdown body and source. */
export function printFaqSection(
  section: FaqSection,
  options: { width?: number; includeBody?: boolean } = {},
): void {
  const width = options.width ?? Math.min(terminalWidth(), 92)
  write('')
  write(`${c().bold(section.title)}`)
  write(c().dim('─'.repeat(Math.min(stringWidth(section.title) + 2, width))))
  write(c().dim(section.group))
  write('')
  if (options.includeBody !== false) {
    const rendered = colorEnabled()
      ? renderMarkdown(section.body, { width })
      : renderMarkdownPlain(section.body, width)
    for (const line of rendered) {
      write(`  ${line}`)
    }
  }
  write('')
}

/** Numbered list of candidate sections, for the "pick one" flow. */
export function printFaqMatches(
  matches: Array<{ section: FaqSection; confidence: number }>,
): void {
  matches.forEach((match, index) => {
    const label = `${index + 1}.`
    write(
      `  ${c().cyan(padTo(label, 3))}${c().bold(truncate(match.section.title, terminalWidth() - 8))}`,
    )
    write(`     ${c().dim(match.section.group)}`)
  })
}

/** One-line hint, used for "try `fbdoc faq ...`" style guidance. */
export function hint(text: string): void {
  write(`  ${c().dim(GLYPH.arrow)} ${c().dim(text)}`)
}

/** A section heading for a command's own output. */
export function heading(text: string): void {
  write(`${c().bold(text)}`)
  write(c().dim('─'.repeat(Math.min(stringWidth(text) + 2, terminalWidth()))))
}

export interface ErrorPresentation {
  message: string
  /** Suggested next step. */
  hint?: string
  verbose: boolean
  exitCode: number
}

/**
 * Renders a failure the way a user can act on it: a plain message, a next step,
 * and only the stack trace when `--verbose` is set.
 */
export function printFailure(
  error: unknown,
  options: { verbose: boolean; hint?: string; exitCode?: number } = {
    verbose: false,
  },
): void {
  const message =
    error instanceof Error
      ? error.message
      : typeof error === 'string'
        ? error
        : String(error)
  writeErr('')
  writeErr(`${c().red(`${GLYPH.failure} ${message}`)}`)
  if (options.hint) {
    writeErr(`  ${c().dim(GLYPH.arrow)} ${options.hint}`)
  }
  writeErr(`  ${c().dim(GLYPH.arrow)} Run with --verbose for the full error.`)
  if (options.verbose && error instanceof Error && error.stack) {
    writeErr('')
    writeErr(c().dim(error.stack))
  }
}

export { STATUS_LABEL }
