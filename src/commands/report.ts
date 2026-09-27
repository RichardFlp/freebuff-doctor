import fs from 'node:fs'
import path from 'node:path'

import { runChecks } from '../checks/index.js'
import { createContext, summarize } from '../checks/types.js'
import { buildSupportReport } from '../report/support.js'
import { writeErr } from '../ui/output.js'
import { withSpinner } from '../ui/spinner.js'
import { c, GLYPH } from '../ui/theme.js'
import type { GlobalOptions } from './options.js'

/** Discord rejects messages longer than this. */
const DISCORD_LIMIT = 2000

export interface ReportCommandOptions extends GlobalOptions {
  /** Write the report to a file instead of stdout. */
  output?: string
}

/**
 * Generates the redacted support report. The command itself succeeds even when
 * the diagnostics found problems — the report is the product, not the verdict.
 */
export async function runReportCommand(
  options: ReportCommandOptions,
): Promise<number> {
  const context = createContext({
    offline: options.offline,
    timeoutMs: options.timeoutMs,
  })
  const results = await withSpinner(
    'Collecting diagnostics for the report…',
    () =>
      runChecks({ context, ...(options.only ? { only: options.only } : {}) }),
  )
  const summary = summarize(results)
  const report = buildSupportReport({ results, context, summary })

  if (options.output) {
    const target = path.resolve(process.cwd(), options.output)
    fs.writeFileSync(target, report, 'utf8')
    writeErr(`${c().green(GLYPH.success)} Wrote support report to ${target}`)
    writeErr(
      c().dim(
        `  ${report.length} characters · ${summary.fail} failed, ${summary.warn} warnings`,
      ),
    )
    return 0
  }

  process.stdout.write(report.endsWith('\n') ? report : `${report}\n`)

  if (report.length > DISCORD_LIMIT - 10) {
    writeErr(
      c().dim(
        `  Note: this report is ${report.length} characters. Discord messages cap at ${DISCORD_LIMIT}, so attach it as a .md file or trim the log section.`,
      ),
    )
  }
  return 0
}
