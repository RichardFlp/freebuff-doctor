import fs from 'node:fs'
import path from 'node:path'

import { runChecks } from '../checks/index.js'
import { createContext, summarize } from '../checks/types.js'
import { buildHelperReport } from '../report/helper.js'
import { collectLogExcerpts } from '../report/support.js'
import { writeErr } from '../ui/output.js'
import { withSpinner } from '../ui/spinner.js'
import { c, GLYPH } from '../ui/theme.js'
import { reportFileName, resolveDownloadsDir } from '../util/downloads.js'
import { collectSnapshot } from '../util/environment.js'
import { exists, formatBytes } from '../util/fs-scan.js'
import type { GlobalOptions } from './options.js'

export interface ExportCommandOptions extends GlobalOptions {
  /** Write into this folder instead of the platform's Downloads folder. */
  dir?: string
  /** Print the report instead of writing a file. */
  stdout?: boolean
}

/** Never overwrite a report that is already there. */
function uniquePath(target: string): string {
  if (!exists(target)) return target
  const extension = path.extname(target)
  const stem = target.slice(0, target.length - extension.length)
  for (let index = 2; index < 100; index += 1) {
    const candidate = `${stem}-${index}${extension}`
    if (!exists(candidate)) return candidate
  }
  return target
}

function resolveTarget(dir: string | undefined): string | null {
  if (!dir) return resolveDownloadsDir().dir
  const resolved = path.resolve(process.cwd(), dir)
  try {
    fs.mkdirSync(resolved, { recursive: true })
    return resolved
  } catch {
    return null
  }
}

/**
 * `fbdoc export` — the long-form report you hand to a Freebuff helper. It runs
 * the same checks as `check`, but keeps every detail a helper would otherwise
 * have to ask for, and saves it as a `.md` file in the Downloads folder.
 */
export async function runExportCommand(
  options: ExportCommandOptions,
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
  const npmVersion =
    (results.find((result) => result.id === 'node-runtime')?.data
      ?.npmVersion as string | undefined) ?? null
  const environment = collectSnapshot(process.env, {
    home: context.home,
    npmVersion,
  })
  const report = buildHelperReport({
    results,
    context,
    summary,
    logs: collectLogExcerpts(context, 60),
    environment,
  })

  if (options.stdout) {
    process.stdout.write(report.endsWith('\n') ? report : `${report}\n`)
    return 0
  }

  const directory = resolveTarget(options.dir)
  if (!directory) {
    writeErr(
      `${c().red(`${GLYPH.failure} Could not create ${options.dir ?? ''}`)}`,
    )
    writeErr(
      `  ${c().dim(GLYPH.arrow)} Try an existing folder, e.g. \`fbdoc export --dir .\`.`,
    )
    return 1
  }

  const target = uniquePath(path.join(directory, reportFileName()))
  try {
    fs.writeFileSync(target, report, 'utf8')
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    writeErr(`${c().red(`${GLYPH.failure} Could not write the report`)}`)
    writeErr(`  ${c().dim(message)}`)
    writeErr(
      `  ${c().dim(GLYPH.arrow)} Pick a folder you can write to with \`fbdoc export --dir <folder>\`.`,
    )
    return 1
  }

  const lines = report.split('\n').length
  writeErr(`${c().green(GLYPH.success)} Exported a detailed report`)
  writeErr(`  ${c().cyan(target)}`)
  writeErr(
    c().dim(
      `  ${formatBytes(Buffer.byteLength(report, 'utf8'))} · ${lines} lines · ${summary.fail} failed, ${summary.warn} warnings`,
    ),
  )
  writeErr(
    `  ${c().dim(GLYPH.arrow)} Share this file with a Freebuff helper, mod or support member — attach it to a Discord thread or paste it into an issue.`,
  )
  return 0
}
