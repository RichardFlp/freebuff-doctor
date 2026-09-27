import { runChecks, selectChecks } from '../checks/index.js'
import { createContext, summarize, type CheckResult } from '../checks/types.js'
import { c } from '../ui/theme.js'
import { heading, printResult, printSummary, write } from '../ui/output.js'
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

  const results = await withSpinner(
    `Running ${selected.length} diagnostic${selected.length === 1 ? '' : 's'}…`,
    (reporter) =>
      runChecks({
        context,
        only: options.only,
        onProgress: ({ completed, total, result }) =>
          reporter.text(
            `Running diagnostics ${completed}/${total} — ${result.title}`,
          ),
      }),
  )

  write('')
  for (const result of results) {
    printResult(result)
    write('')
  }

  const summary = summarize(results)
  const footer: string[] = []
  if (summary.fail > 0) {
    footer.push(
      c().dim(
        `Exit code 1 because ${summary.fail} check${summary.fail === 1 ? '' : 's'} failed. Warnings alone exit 0 unless you pass --strict.`,
      ),
    )
  }
  if (results.some((result) => result.status !== 'pass')) {
    footer.push(
      c().dim(
        'Paste `fbdoc report` into a Discord help thread if you need a second opinion.',
      ),
    )
  }

  await printSummary(summary, { footer })
  return exitCodeFor(results, options.strict)
}
