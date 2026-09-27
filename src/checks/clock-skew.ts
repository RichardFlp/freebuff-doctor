import fs from 'node:fs'

import { describeNetworkError } from '../util/registry.js'
import {
  found,
  type CheckContext,
  type CheckStatus,
  type DiagnosticCheck,
  type ResultInit,
} from './types.js'

/** Skew past this is worth a warning: tokens and TLS handshakes get fussy. */
export const WARN_SKEW_MS = 5 * 60_000
/** Skew past this breaks TLS outright on most servers. */
export const FAIL_SKEW_MS = 60 * 60_000

const TIME_SOURCE = 'https://freebuff.com/'

export interface SkewVerdict {
  status: CheckStatus
  /** Positive when this machine's clock is ahead of the server. */
  skewMs: number
  message: string
  details: string[]
}

function formatDuration(ms: number): string {
  if (ms < 60_000) return `${Math.round(ms / 1000)} seconds`
  if (ms < 3_600_000) return `${Math.round(ms / 60_000)} minutes`
  return `${(ms / 3_600_000).toFixed(1)} hours`
}

/** A single command that usually resyncs the system clock on this platform. */
export function clockSyncFix(platform: NodeJS.Platform): string {
  if (platform === 'win32') return 'w32tm /resync /force'
  if (platform === 'darwin') return 'sudo sntp -sS time.apple.com'
  return 'sudo timedatectl set-ntp true'
}

/**
 * Pure comparison of the local clock with a server's `Date` header. A skewed
 * clock is behind a surprising number of "cannot connect" and "invalid token"
 * reports, because certificate validity and signed requests are time-bound.
 */
export function classifySkew(localMs: number, serverMs: number): SkewVerdict {
  const skewMs = localMs - serverMs
  const magnitude = Math.abs(skewMs)
  const direction = skewMs >= 0 ? 'ahead of' : 'behind'
  const describe = formatDuration(magnitude)

  if (magnitude > FAIL_SKEW_MS) {
    return {
      status: 'fail',
      skewMs,
      message: `This machine's clock is ${describe} ${direction} real time, which breaks TLS certificate checks and signed requests before Freebuff ever sees them.`,
      details: [
        'Turn on automatic date and time, then resync before trying again.',
      ],
    }
  }

  if (magnitude > WARN_SKEW_MS) {
    return {
      status: 'warn',
      skewMs,
      message: `This machine's clock is ${describe} ${direction} real time, which can make tokens and certificates look invalid.`,
      details: ['Turn on automatic date and time to correct it.'],
    }
  }

  return {
    status: 'pass',
    skewMs,
    message: `System clock matches server time within ${formatDuration(magnitude)}.`,
    details: [`Compared against the ${new URL(TIME_SOURCE).host} Date header.`],
  }
}

export interface EnvFootgun {
  variable: string
  message: string
  fix: string
}

/**
 * TLS-related environment variables that turn into connectivity bugs. A stale
 * `NODE_EXTRA_CA_CERTS` or a leftover `SSL_CERT_FILE` makes every HTTPS request
 * fail with a certificate error, and `NODE_TLS_REJECT_UNAUTHORIZED=0` silently
 * disables the check that would tell you why.
 */
export function inspectTlsEnvironment(
  env: NodeJS.ProcessEnv,
  fileExists: (target: string) => boolean = fs.existsSync,
): EnvFootgun[] {
  const issues: EnvFootgun[] = []

  const insecure = env.NODE_TLS_REJECT_UNAUTHORIZED?.trim()
  if (insecure === '0') {
    issues.push({
      variable: 'NODE_TLS_REJECT_UNAUTHORIZED',
      message:
        'certificate validation is disabled system-wide, so a broken or intercepted connection looks healthy until it fails in other ways.',
      fix: 'unset NODE_TLS_REJECT_UNAUTHORIZED',
    })
  }

  const extraCa = env.NODE_EXTRA_CA_CERTS?.trim()
  if (extraCa) {
    if (!fileExists(extraCa)) {
      issues.push({
        variable: 'NODE_EXTRA_CA_CERTS',
        message: `points at ${extraCa}, which does not exist — every HTTPS request from Node can fail with a certificate error.`,
        fix: 'unset NODE_EXTRA_CA_CERTS',
      })
    } else {
      issues.push({
        variable: 'NODE_EXTRA_CA_CERTS',
        message: `adds a custom CA bundle (${extraCa}); if HTTPS fails only on this machine, that bundle is the reason.`,
        fix: 'unset NODE_EXTRA_CA_CERTS',
      })
    }
  }

  const sslCertFile = env.SSL_CERT_FILE?.trim()
  if (sslCertFile) {
    if (!fileExists(sslCertFile)) {
      issues.push({
        variable: 'SSL_CERT_FILE',
        message: `points at ${sslCertFile}, which does not exist — certificate verification will fail.`,
        fix: 'unset SSL_CERT_FILE',
      })
    } else {
      issues.push({
        variable: 'SSL_CERT_FILE',
        message: `replaces the trust store with ${sslCertFile}; corporate bundles quietly break Freebuff's HTTPS calls.`,
        fix: 'unset SSL_CERT_FILE',
      })
    }
  }

  return issues
}

interface ServerTime {
  epochMs: number | null
  error: string | null
  /** Local time at the midpoint between request start and header arrival. */
  localMs: number
}

/**
 * Reads the `Date` header from a plain HTTPS GET. The header has one-second
 * precision, which is far finer than the minutes-wide thresholds we compare
 * against, so it is accurate enough to judge a clock.
 */
async function readServerTime(
  url: string,
  timeoutMs: number,
): Promise<ServerTime> {
  const startedAt = Date.now()
  try {
    const response = await fetch(url, {
      method: 'GET',
      redirect: 'follow',
      headers: { 'user-agent': 'freebuff-doctor', accept: '*/*' },
      signal: AbortSignal.timeout(timeoutMs),
    })
    const header = response.headers.get('date')
    const receivedAt = Date.now()
    await response.body?.cancel().catch(() => undefined)

    if (!header) {
      return {
        epochMs: null,
        error: 'the server did not report its time',
        localMs: receivedAt,
      }
    }
    const epochMs = Date.parse(header)
    if (!Number.isFinite(epochMs)) {
      return {
        epochMs: null,
        error: 'the server sent an unreadable Date header',
        localMs: receivedAt,
      }
    }
    return {
      epochMs,
      error: null,
      localMs: Math.round((startedAt + receivedAt) / 2),
    }
  } catch (error) {
    return {
      epochMs: null,
      error: describeNetworkError(error),
      localMs: Date.now(),
    }
  }
}

/** Compares this machine's clock with a server clock, and audits TLS variables. */
export const clockSkewCheck: DiagnosticCheck = {
  id: 'clock-skew',
  title: 'System clock and TLS trust',
  async run(context: CheckContext) {
    const footguns = inspectTlsEnvironment(context.env)
    const timeoutMs = Math.min(Math.max(context.timeoutMs, 2000), 15_000)

    const withFootguns = (verdict: ResultInit): ResultInit => {
      if (footguns.length === 0) return verdict
      const first = footguns[0] as EnvFootgun
      const lines = footguns.map(
        (footgun) => `${footgun.variable} ${footgun.message}`,
      )
      if (verdict.status === 'fail') {
        return { ...verdict, details: [...(verdict.details ?? []), ...lines] }
      }
      return {
        status: 'warn',
        message: `${first.variable} ${first.message}`,
        details: [...lines, ...(verdict.details ?? []), verdict.message],
        fix: first.fix,
        faqSlug: 'network-issues',
      }
    }

    if (context.offline) {
      // The clock comparison needs the network, but the environment audit does
      // not — and a leftover CA variable is exactly what breaks HTTPS.
      if (footguns.length === 0) {
        return found({
          status: 'skip',
          message: 'Skipped because --offline was requested.',
        })
      }
      return found({
        ...withFootguns({
          status: 'pass',
          message: 'Clock comparison skipped because --offline was requested.',
          details: ['The TLS environment variables were still inspected.'],
        }),
        data: { offline: true, tls: footguns.map((entry) => entry.variable) },
      })
    }

    const server = await readServerTime(TIME_SOURCE, timeoutMs)

    if (server.epochMs === null) {
      const certificateProblem =
        /certificate|TLS|not yet valid|self-signed/i.test(server.error ?? '')
      const verdict: ResultInit = certificateProblem
        ? {
            status: 'warn',
            message: `HTTPS to ${new URL(TIME_SOURCE).host} failed (${server.error}) before the clocks could be compared — a skewed clock and an invalid certificate produce the same error.`,
            details: [
              'Resync the system clock first, then re-run `fbdoc check`.',
            ],
            fix: clockSyncFix(context.platform),
            faqSlug: 'network-issues',
          }
        : {
            status: 'pass',
            message: `Server time could not be read (${server.error}), so the clock was not compared — the reachability check covers this.`,
          }
      return found({
        ...withFootguns(verdict),
        data: {
          serverTime: null,
          error: server.error,
          tls: footguns.map((entry) => entry.variable),
        },
      })
    }

    const verdict = classifySkew(server.localMs, server.epochMs)
    return found({
      ...withFootguns({
        status: verdict.status,
        message: verdict.message,
        details: verdict.details,
        ...(verdict.status === 'pass'
          ? {}
          : {
              fix: clockSyncFix(context.platform),
              faqSlug: 'network-issues',
            }),
      }),
      data: {
        serverTime: new Date(server.epochMs).toISOString(),
        localTime: new Date(server.localMs).toISOString(),
        skewMs: verdict.skewMs,
        tls: footguns.map((entry) => entry.variable),
      },
    })
  },
}
