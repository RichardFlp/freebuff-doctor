import fs from 'node:fs'
import path from 'node:path'

import { listDir, safeStat } from '../util/fs-scan.js'
import { anonymizePath } from '../util/platform.js'
import {
  found,
  type CheckContext,
  type DiagnosticCheck,
  type ResultInit,
} from './types.js'

/** Files Freebuff/Codebuff use to remember a signed-in account. */
export const CREDENTIAL_FILE =
  /^\.?(credentials|auth|token|session|login|account)s?(-token)?(\.json)?$/i

/** Permission bits that mean someone other than the owner can read the file. */
const GROUP_OR_OTHER = 0o077

/** Keys that hold an expiry, in the spellings these files use. */
const EXPIRY_KEYS = [
  'expiresAt',
  'expires_at',
  'expiry',
  'expires',
  'exp',
  'expiration',
  'validUntil',
  'valid_until',
  'tokenExpiresAt',
  'token_expires_at',
] /**
 * Keys that indicate a token is present. Matched as a substring so real-world
 * spellings like `authToken`, `access_token` and `credentialId` all count. The
 * value itself is never read out or printed.
 */
const TOKEN_KEYS =
  /token|secret|credential|password|passwd|passphrase|jwt|api[-_]?key/i

export interface CredentialFacts {
  platform: NodeJS.Platform
  /** Anonymized path, for messages. */
  display: string
  bytes: number
  ageMs: number
  readable: boolean
  /** File mode, or null on Windows where the bits carry no meaning. */
  mode: number | null
  /** Null when the file was not valid JSON. */
  parsed: boolean
  /** True when a token-shaped value was found. */
  hasToken: boolean
  /** Expiry in epoch milliseconds, when the payload declared one. */
  expiresAt: number | null
  /** Top-level key names, never values. */
  keys: string[]
}

/**
 * Turns the many spellings of "when does this expire" into epoch
 * milliseconds. Accepts ISO strings, epoch seconds and epoch milliseconds.
 */
export function readExpiry(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) {
    // Anything below this is seconds; the cutoff is well after 2001 and well
    // before the millisecond value for the same instant.
    return value < 100_000_000_000
      ? Math.round(value * 1000)
      : Math.round(value)
  }
  if (typeof value === 'string' && value.trim()) {
    const trimmed = value.trim()
    if (/^\d+$/.test(trimmed)) return readExpiry(Number(trimmed))
    const parsed = Date.parse(trimmed)
    return Number.isFinite(parsed) ? parsed : null
  }
  return null
}

function isTokenShaped(value: unknown): boolean {
  return typeof value === 'string' && value.trim().length >= 8
}

/**
 * Walks the top two levels of a credential payload for an expiry and any
 * token-shaped value. Returns key names only — never the secrets themselves.
 */
export function inspectCredentialPayload(payload: unknown): {
  hasToken: boolean
  expiresAt: number | null
  keys: string[]
} {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    return { hasToken: false, expiresAt: null, keys: [] }
  }

  const record = payload as Record<string, unknown>
  let hasToken = false
  let expiresAt: number | null = null

  for (const [key, value] of Object.entries(record)) {
    if (TOKEN_KEYS.test(key) && isTokenShaped(value)) hasToken = true
    if (EXPIRY_KEYS.includes(key)) {
      expiresAt ??= readExpiry(value)
    }
    if (value && typeof value === 'object' && !Array.isArray(value)) {
      for (const [nestedKey, nestedValue] of Object.entries(
        value as Record<string, unknown>,
      )) {
        if (TOKEN_KEYS.test(nestedKey) && isTokenShaped(nestedValue)) {
          hasToken = true
        }
        if (EXPIRY_KEYS.includes(nestedKey)) {
          expiresAt ??= readExpiry(nestedValue)
        }
      }
    }
  }

  return { hasToken, expiresAt, keys: Object.keys(record) }
}

function formatAge(ms: number): string {
  const hours = Math.floor(ms / 3_600_000)
  if (hours < 1) return 'less than an hour'
  if (hours < 48) return `${hours} hours`
  return `${Math.round(hours / 24)} days`
}

/**
 * Pure verdict for stored credentials. A file that cannot be parsed or that
 * expired quietly is the reason a user is suddenly asked to sign in again, and
 * a world-readable token file is worth flagging on its own.
 */
export function classifyCredentials(facts: CredentialFacts | null): ResultInit {
  if (!facts) {
    return {
      status: 'pass',
      message:
        'No saved login was found on this machine, so Freebuff will simply ask you to sign in.',
      details: [
        'This is normal on a fresh install or when you use the browser instead.',
      ],
    }
  }

  const data = {
    file: facts.display,
    bytes: facts.bytes,
    ageDays: Math.round(facts.ageMs / 86_400_000),
    hasToken: facts.hasToken,
    expiresAt:
      facts.expiresAt !== null ? new Date(facts.expiresAt).toISOString() : null,
    keys: facts.keys,
  }

  if (!facts.readable) {
    return {
      status: 'warn',
      message: `${facts.display} exists but cannot be read, so Freebuff may treat you as signed out.`,
      details: ['Check the file permissions on your user account.'],
      faqSlug: 'troubleshooting-official',
      data,
    }
  }

  if (!facts.parsed) {
    return {
      status: 'fail',
      message: `${facts.display} is not valid JSON, so your saved login is unusable and every session starts unauthenticated.`,
      details: [
        'This normally means the file was truncated by a crash or a full disk.',
        'Deleting it is safe — you are asked to sign in again on the next run.',
      ],
      fix:
        facts.platform === 'win32'
          ? `del "${facts.display}"`
          : `rm "${facts.display}"`,
      faqSlug: 'troubleshooting-official',
      data,
    }
  }

  if (facts.expiresAt !== null && facts.expiresAt <= Date.now()) {
    const expired = Date.now() - facts.expiresAt
    return {
      status: 'warn',
      message: `Your saved login expired ${formatAge(expired)} ago (${new Date(facts.expiresAt).toISOString()}), which is why Freebuff asks you to sign in again.`,
      details: [
        'Sign in once more to store a fresh token; nothing else is wrong.',
        ...(facts.keys.length > 0
          ? [`Fields present: ${facts.keys.join(', ')}`]
          : []),
      ],
      faqSlug: 'troubleshooting-official',
      data,
    }
  }

  if (!facts.hasToken) {
    return {
      status: 'warn',
      message: `${facts.display} exists but holds no recognisable token, so it cannot sign you in.`,
      details: [
        'Sign in again to rewrite it; delete the file if the app still misbehaves.',
      ],
      faqSlug: 'troubleshooting-official',
      data,
    }
  }

  if (facts.mode !== null && (facts.mode & GROUP_OR_OTHER) !== 0) {
    return {
      status: 'warn',
      message: `${facts.display} is readable by other accounts on this machine (mode ${(facts.mode & 0o777).toString(8)}), which exposes your session token.`,
      details: ['Only your own account needs access to a credential file.'],
      fix: `chmod 600 "${facts.display}"`,
      faqSlug: 'privacy',
      data,
    }
  }

  return {
    status: 'pass',
    message: facts.expiresAt
      ? `Saved login is present and valid until ${new Date(facts.expiresAt).toISOString()}.`
      : 'Saved login is present and readable.',
    details: [
      `Stored in ${facts.display} (${facts.bytes} bytes, written ${formatAge(facts.ageMs)} ago).`,
      'The token itself is never read out or included in any report.',
    ],
    data,
  }
}

/** Checks that the stored login exists, parses, is current, and is private. */
export const authSessionCheck: DiagnosticCheck = {
  id: 'auth-session',
  title: 'Saved login and credentials',
  async run(context: CheckContext) {
    const dirs = [
      context.paths.cliState,
      context.paths.desktopState,
      context.paths.legacyState,
    ]

    let best: CredentialFacts | null = null
    let bestMtime = -1

    for (const dir of dirs) {
      if (!safeStat(dir)?.isDirectory()) continue
      for (const entry of listDir(dir)) {
        if (!entry.isFile()) continue
        if (!CREDENTIAL_FILE.test(entry.name)) continue
        const full = path.join(dir, entry.name)
        const stat = safeStat(full)
        if (!stat?.isFile()) continue
        if (stat.mtimeMs <= bestMtime) continue

        let readable = true
        let parsed = false
        let content = ''
        try {
          content = fs.readFileSync(full, 'utf8')
        } catch {
          readable = false
        }

        let inspected = {
          hasToken: false,
          expiresAt: null as number | null,
          keys: [] as string[],
        }
        if (readable) {
          try {
            inspected = inspectCredentialPayload(JSON.parse(content))
            parsed = true
          } catch {
            parsed = false
          }
        }

        bestMtime = stat.mtimeMs
        best = {
          platform: context.platform,
          display: anonymizePath(full, context.home, context.platform),
          bytes: stat.size,
          ageMs: Math.max(0, Date.now() - stat.mtimeMs),
          readable,
          // Windows reports 0o666 for everything, so the bits mean nothing.
          mode: context.platform === 'win32' ? null : stat.mode,
          parsed,
          hasToken: inspected.hasToken,
          expiresAt: inspected.expiresAt,
          keys: inspected.keys,
        }
      }
    }

    return found(classifyCredentials(best))
  },
}
