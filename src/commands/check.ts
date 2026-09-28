import { runChecks, selectChecks } from '../checks/index.js'
import { createContext, summarize, type CheckResult } from '../checks/types.js'
import { c, GLYPH } from '../ui/theme.js'
import {
  formatDuration,
  groupHeading,
  heading,
  printCompactList,
  printResult,
  printSummary,
  progressBar,
  write,
} from '../ui/output.js'
import { withSpinner } from '../ui/spinner.js'
import { describePlatform } from '../util/platform.js'
import { doctorVersion } from '../util/version.js'
import type { GlobalOptions } from './options.js'

/** 1 when anything failed (or warned under `--strict`), otherwise 0. */
export function exitCodeFor(results: CheckResult[], strict: boolean): number {
  if (results.some((result) => result.status === 'fail')) return 1
  if (strict && results.some((result) => result.status === 'warn')) return 1
  return 0
}

export interface JsonReport {
  ok: boolean
  summary: {
    total: number
    pass: number
    warn: number
    fail: number
    skip: number
  }
  nextAction: { message: string; fix?: string; faqSlug?: string } | null
  meta: {
    doctor: string
    node: string
    platform: string
    arch: string
    offline: boolean
    generatedAt: string
  }
  checks: CheckResult[]
}

/**
 * Orders results for a human reading top-down: failures, then warnings, then
 * everything else. Failures come first because that is the only part of a
 * thirty-check report most people actually need.
 */
export function orderForDisplay(results: CheckResult[]): {
  attention: CheckResult[]
  rest: CheckResult[]
} {
  const failures = results.filter((result) => result.status === 'fail')
  const warnings = results.filter((result) => result.status === 'warn')
  const rest = results.filter(
    (result) => result.status !== 'fail' && result.status !== 'warn',
  )
  return { attention: [...failures, ...warnings], rest }
}

/** Runs the diagnostic suite, printing a report or JSON depending on options. */
export async function runCheckCommand(options: GlobalOptions): Promise<number> {
  const context = createContext({
    offline: options.offline,
    timeoutMs: options.timeoutMs,
  })
  const selected = selectChecks(options.only)

  if (options.json) {
    // Nothing is written to stdout except the JSON document.
    const results = await runChecks({ context, only: options.only })
    const summary = summarize(results)
    const payload: JsonReport = {
      ok: summary.ok,
      summary: {
        total: summary.total,
        pass: summary.pass,
        warn: summary.warn,
        fail: summary.fail,
        skip: summary.skip,
      },
      nextAction: summary.nextAction,
      meta: {
        doctor: doctorVersion(),
        node: context.nodeVersion,
        platform: context.platform,
        arch: context.arch,
        offline: options.offline,
        generatedAt: new Date().toISOString(),
      },
      checks: results,
    }
    write(JSON.stringify(payload, null, 2))
    return exitCodeFor(results, options.strict)
  }

  heading(`Freebuff Doctor ${doctorVersion()}`)
  write(c().dim(`${describePlatform()} · Node ${context.nodeVersion}`))
  write('')

  const startedAt = Date.now()
  const results = await withSpinner(
    `Running ${selected.length} diagnostic${selected.length === 1 ? '' : 's'}…`,
    (reporter) =>
      runChecks({
        context,
        only: options.only,
        onProgress: ({ completed, total, result }) =>
          reporter.text(`${progressBar(completed, total)}  ${result.title}`),
      }),
  )
  const elapsedMs = Date.now() - startedAt

  const { attention, rest } = orderForDisplay(results)
  const passes = rest.filter((result) => result.status === 'pass')
  const skipped = rest.filter((result) => result.status === 'skip')

  write('')

  // Everything that needs a human, in full.
  if (attention.length > 0) {
    groupHeading(
      'Needs attention',
      `· ${attention.length} of ${results.length} checks`,
    )
    write('')
    for (const result of attention) {
      printResult(result)
      write('')
    }
  }

  // `--all` prints the healthy checks in full too; otherwise they collapse to
  // one line each so the interesting part stays on screen.
  if (options.all && rest.length > 0) {
    groupHeading('Everything else', `· ${rest.length} checks`)
    write('')
    for (const result of rest) {
      printResult(result, { timings: true })
      write('')
    }
  } else if (!options.quiet) {
    if (attention.length > 0) groupHeading('Everything else')
    printCompactList(
      `${passes.length} check${passes.length === 1 ? '' : 's'} passed`,
      passes,
    )
    if (skipped.length > 0) {
      printCompactList(
        `${skipped.length} skipped`,
        skipped,
        options.offline ? '· because --offline was requested' : undefined,
      )
    }
    if (attention.length > 0) write('')
  }

  const summary = summarize(results)
  const footer: string[] = []
  footer.push(
    `${results.length} checks in ${formatDuration(elapsedMs)} on ${describePlatform()}.`,
  )
  if (summary.fail > 0) {
    footer.push(
      `Exit code 1 because ${summary.fail} check${summary.fail === 1 ? '' : 's'} failed. Warnings alone exit 0 unless you pass --strict.`,
    )
  }
  if (summary.skip > 0 && options.offline) {
    footer.push(
      `${summary.skip} network check${summary.skip === 1 ? '' : 's'} skipped offline; re-run without --offline for the full picture.`,
    )
  }
  if (attention.length > 0) {
    footer.push(
      `${c().dim(GLYPH.arrow)} Need detail on any check? Run \`fbdoc explain <id>\`.`,
    )
    footer.push(
      `${c().dim(GLYPH.arrow)} Paste \`fbdoc report\` into a Discord help thread if you need a second opinion.`,
    )
  }

  await printSummary(summary, { footer })
  return exitCodeFor(results, options.strict)
}
