import { crashLogCheck } from './crash-log.js'
import { dnsCheck } from './dns.js'
import { globalInstallCheck } from './global-install.js'
import { installPathsCheck } from './install-paths.js'
import { networkCheck } from './network.js'
import { nodeConflictsCheck } from './node-conflicts.js'
import { nodeRuntimeCheck } from './node-runtime.js'
import { sessionLogsCheck } from './session-logs.js'
import { storageCheck } from './storage.js'
import {
  found,
  type CheckContext,
  type CheckResult,
  type DiagnosticCheck,
} from './types.js'

/** Every diagnostic, in the order results are reported. */
export const CHECKS: DiagnosticCheck[] = [
  nodeRuntimeCheck,
  globalInstallCheck,
  installPathsCheck,
  dnsCheck,
  networkCheck,
  nodeConflictsCheck,
  sessionLogsCheck,
  crashLogCheck,
  storageCheck,
]

export interface ProgressEvent {
  completed: number
  total: number
  result: CheckResult
}

export interface RunChecksOptions {
  context: CheckContext
  /** How many checks may be in flight at once. */
  concurrency?: number
  onProgress?: (event: ProgressEvent) => void
  /** Restrict the run to these check ids. */
  only?: string[]
}

/** Resolves the checks to run, honouring a `--only` filter. */
export function selectChecks(only?: string[]): DiagnosticCheck[] {
  if (!only || only.length === 0) return CHECKS
  const wanted = new Set(only.map((id) => id.trim()).filter(Boolean))
  const selected = CHECKS.filter((check) => wanted.has(check.id))
  return selected.length > 0 ? selected : CHECKS
}

/** Runs a single check, converting a thrown error into a failed result. */
async function runOne(
  check: DiagnosticCheck,
  context: CheckContext,
): Promise<CheckResult> {
  const started = Date.now()
  try {
    const outcome = await check.run(context)
    return {
      id: check.id,
      title: check.title,
      durationMs: Date.now() - started,
      ...outcome,
    }
  } catch (error) {
    return {
      id: check.id,
      title: check.title,
      durationMs: Date.now() - started,
      ...found({
        status: 'fail',
        message: `This check could not complete: ${error instanceof Error ? error.message : String(error)}`,
        details: ['Re-run with --verbose to see the full error.'],
      }),
    }
  }
}

/**
 * Runs the diagnostics concurrently (they are all I/O bound) while preserving
 * the declared report order, reporting progress as each one settles.
 */
export async function runChecks(
  options: RunChecksOptions,
): Promise<CheckResult[]> {
  const selected = selectChecks(options.only)

  const results = new Array<CheckResult | undefined>(selected.length)
  const concurrency = Math.max(
    1,
    Math.min(options.concurrency ?? 4, selected.length || 1),
  )
  let cursor = 0
  let completed = 0

  const workers = Array.from(
    { length: Math.min(concurrency, selected.length) },
    async () => {
      for (;;) {
        const index = cursor
        cursor += 1
        const check = selected[index]
        if (!check) return
        const result = await runOne(check, options.context)
        results[index] = result
        completed += 1
        options.onProgress?.({ completed, total: selected.length, result })
      }
    },
  )

  await Promise.all(workers)
  return results.filter((result): result is CheckResult => result !== undefined)
}

/** Check ids and titles, used by help text and the wizard. */
export function listChecks(): Array<{ id: string; title: string }> {
  return CHECKS.map((check) => ({ id: check.id, title: check.title }))
}
