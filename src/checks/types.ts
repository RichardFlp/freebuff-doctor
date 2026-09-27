import os from 'node:os'

import { resolvePlatformPaths, type PlatformPaths } from '../util/platform.js'

export type CheckStatus = 'pass' | 'warn' | 'fail' | 'skip'

export interface CheckResult {
  id: string
  title: string
  status: CheckStatus
  /** One-line, plain-English explanation of what was found. */
  message: string
  /** Extra context lines shown only when they add something. */
  details?: string[]
  /** A single command that usually resolves the problem. */
  fix?: string
  /** Slug of the FAQ section covering this issue. */
  faqSlug?: string
  /** Structured payload consumed by `--json` and the support report. */
  data?: Record<string, unknown>
  durationMs: number
}

export interface CheckContext {
  paths: PlatformPaths
  platform: NodeJS.Platform
  arch: string
  env: NodeJS.ProcessEnv
  cwd: string
  /** Version of the Node runtime executing the doctor. */
  nodeVersion: string
  home: string
  timeoutMs: number
  /** Set by `--offline`: checks that need the network report `skip`. */
  offline: boolean
}

export interface DiagnosticCheck {
  id: string
  title: string
  run(
    context: CheckContext,
  ): Promise<Omit<CheckResult, 'durationMs' | 'id' | 'title'>>
}

export function createContext(
  overrides: Partial<CheckContext> = {},
): CheckContext {
  const home = overrides.home ?? os.homedir()
  return {
    paths: resolvePlatformPaths(home, process.env, process.platform),
    platform: process.platform,
    arch: process.arch,
    env: process.env,
    cwd: process.cwd(),
    nodeVersion: process.version,
    home,
    timeoutMs: 8000,
    offline: false,
    ...overrides,
  }
}

export interface ResultInit {
  status: CheckStatus
  message: string
  details?: string[]
  fix?: string
  faqSlug?: string
  data?: Record<string, unknown>
}

/** Convenience constructor used by every check. */
export function found(
  init: ResultInit,
): Omit<CheckResult, 'durationMs' | 'id' | 'title'> {
  return {
    status: init.status,
    message: init.message,
    ...(init.details ? { details: init.details } : {}),
    ...(init.fix ? { fix: init.fix } : {}),
    ...(init.faqSlug ? { faqSlug: init.faqSlug } : {}),
    ...(init.data ? { data: init.data } : {}),
  }
}

/** What the check suite concluded overall. */
export interface CheckSummary {
  total: number
  pass: number
  warn: number
  fail: number
  skip: number
  /** True when nothing failed. */
  ok: boolean
  /** The single most useful thing to do next. */
  nextAction: { message: string; fix?: string; faqSlug?: string } | null
}

const SEVERITY: Record<CheckStatus, number> = {
  fail: 3,
  warn: 2,
  skip: 1,
  pass: 0,
}

/**
 * Summarises results and picks the one action worth highlighting: the first
 * failure, otherwise the first warning that comes with a fix.
 */
export function summarize(results: CheckResult[]): CheckSummary {
  const counts = { pass: 0, warn: 0, fail: 0, skip: 0 }
  for (const result of results) counts[result.status] += 1

  const actionable = [...results]
    .filter((result) => result.status === 'fail' || result.status === 'warn')
    .sort((a, b) => {
      if (SEVERITY[b.status] !== SEVERITY[a.status])
        return SEVERITY[b.status] - SEVERITY[a.status]
      const aFix = a.fix ? 1 : 0
      const bFix = b.fix ? 1 : 0
      return bFix - aFix
    })

  const top = actionable[0]
  return {
    total: results.length,
    ...counts,
    ok: counts.fail === 0,
    nextAction: top
      ? {
          message:
            top.status === 'fail'
              ? `${top.title}: ${top.message}`
              : `${top.title}: ${top.message}`,
          ...(top.fix ? { fix: top.fix } : {}),
          ...(top.faqSlug ? { faqSlug: top.faqSlug } : {}),
        }
      : null,
  }
}
