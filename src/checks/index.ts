import { archMatchCheck } from './arch-match.js'
import { authSessionCheck } from './auth-session.js'
import { binaryIntegrityCheck } from './binary-integrity.js'
import { cacheIntegrityCheck } from './cache-integrity.js'
import { CATEGORY_ORDER, type CheckCategory } from './catalog.js'
import { clockSkewCheck } from './clock-skew.js'
import { commandShadowingCheck } from './command-shadowing.js'
import { configHealthCheck } from './config-health.js'
import { crashLogCheck } from './crash-log.js'
import { dnsCheck } from './dns.js'
import { envHygieneCheck } from './env-hygiene.js'
import { errorTriageCheck } from './error-triage.js'
import { gitPrereqsCheck } from './git-prereqs.js'
import { globalInstallCheck } from './global-install.js'
import { hostsPinCheck } from './hosts-pin.js'
import { installPathsCheck } from './install-paths.js'
import { networkCheck } from './network.js'
import { nodeConflictsCheck } from './node-conflicts.js'
import { nodeRuntimeCheck } from './node-runtime.js'
import { pathLengthCheck } from './path-length.js'
import { portAvailabilityCheck } from './port-availability.js'
import { proxyTrustCheck } from './proxy-trust.js'
import { resourceLimitsCheck } from './resource-limits.js'
import { sessionLogsCheck } from './session-logs.js'
import { splitStateCheck } from './split-state.js'
import { staleLockCheck } from './stale-lock.js'
import { stateGrowthCheck } from './state-growth.js'
import { storageCheck } from './storage.js'
import { tempHealthCheck } from './temp-health.js'
import { tlsChainCheck } from './tls-chain.js'
import { watcherLimitsCheck } from './watcher-limits.js'
import { checkDoc, type CheckDoc } from './catalog.js'
import {
  found,
  type CheckContext,
  type CheckResult,
  type DiagnosticCheck,
} from './types.js'

/**
 * Every diagnostic, in the order results are reported: the runtime and its
 * install first, then the local state it reads, then the sessions and logs,
 * then anything that needs the network, then the heavier environment, disk and
 * process checks.
 */
export const CHECKS: DiagnosticCheck[] = [
  nodeRuntimeCheck,
  archMatchCheck,
  globalInstallCheck,
  commandShadowingCheck,
  binaryIntegrityCheck,
  installPathsCheck,
  cacheIntegrityCheck,
  configHealthCheck,
  authSessionCheck,
  staleLockCheck,
  splitStateCheck,
  sessionLogsCheck,
  crashLogCheck,
  errorTriageCheck,
  stateGrowthCheck,
  dnsCheck,
  networkCheck,
  proxyTrustCheck,
  tlsChainCheck,
  hostsPinCheck,
  clockSkewCheck,
  envHygieneCheck,
  nodeConflictsCheck,
  gitPrereqsCheck,
  watcherLimitsCheck,
  pathLengthCheck,
  tempHealthCheck,
  portAvailabilityCheck,
  storageCheck,
  resourceLimitsCheck,
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

/** One registered check by id, or `null`. */
export function findCheck(id: string): DiagnosticCheck | null {
  const wanted = id.trim().toLowerCase()
  return (
    CHECKS.find((check) => check.id === wanted) ??
    // Accept a title or a `--only`-style list entry that is close enough.
    CHECKS.find((check) => check.title.toLowerCase() === wanted) ??
    null
  )
}

export interface CategorisedChecks {
  category: CheckCategory
  checks: Array<{ check: DiagnosticCheck; doc: CheckDoc | null }>
}

/** Checks grouped by category, in the catalogue's own order. */
export function checksByCategory(): CategorisedChecks[] {
  const groups = CATEGORY_ORDER.map((category) => ({
    category,
    checks: CHECKS.filter(
      (check) => (checkDoc(check.id)?.category ?? 'environment') === category,
    ).map((check) => ({ check, doc: checkDoc(check.id) })),
  }))
  return groups.filter((group) => group.checks.length > 0)
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
