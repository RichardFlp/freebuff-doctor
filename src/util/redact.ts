import { anonymizePath } from './platform.js'

/**
 * Redaction rules for anything that might be pasted into a public help channel.
 * Ordered most-specific first so that a token is never partially masked.
 */
const PATTERNS: Array<{ name: string; pattern: RegExp; replacement: string }> =
  [
    {
      name: 'private-key',
      pattern:
        /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g,
      replacement: '[redacted private key]',
    },
    {
      name: 'email',
      pattern: /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g,
      replacement: '[redacted email]',
    },
    {
      name: 'jwt',
      pattern:
        /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{4,}\b/g,
      replacement: '[redacted jwt]',
    },
    {
      name: 'vendor-token',
      pattern:
        /\b(?:sk-[A-Za-z0-9_-]{16,}|sk-ant-[A-Za-z0-9_-]{16,}|ghp_[A-Za-z0-9]{16,}|gho_[A-Za-z0-9]{16,}|ghs_[A-Za-z0-9]{16,}|ghr_[A-Za-z0-9]{16,}|github_pat_[A-Za-z0-9_]{16,}|gsk_[A-Za-z0-9]{16,}|npm_[A-Za-z0-9]{16,}|pypi-[A-Za-z0-9_-]{16,}|xox[baprs]-[A-Za-z0-9-]{10,}|AKIA[0-9A-Z]{16}|AIza[0-9A-Za-z_-]{30,}|glpat-[A-Za-z0-9_-]{16,}|dop_v1_[a-f0-9]{32,})\b/g,
      replacement: '[redacted token]',
    },
    {
      name: 'authorization-header',
      pattern: /\b(Bearer|Basic)\s+[A-Za-z0-9._~+/=-]{12,}/gi,
      replacement: '$1 [redacted]',
    },
    {
      name: 'npmrc-token',
      pattern: /(_authToken|_auth|_password)\s*[:=]\s*\S+/gi,
      replacement: '$1=[redacted]',
    },
    {
      name: 'url-credential',
      pattern: /\b([a-z][a-z0-9+.-]*:\/\/)[^\s/@:]+:[^\s/@]+@/gi,
      replacement: '$1[redacted]@',
    },
    {
      name: 'assigned-secret',
      pattern:
        /\b([A-Za-z0-9_-]*(?:api[_-]?key|apikey|access[_-]?token|auth[_-]?token|secret|client[_-]?secret|password|passwd|passphrase|private[_-]?key)[A-Za-z0-9_-]*)\s*[:=]\s*["']?([A-Za-z0-9_\-./+=]{6,})["']?/gi,
      replacement: '$1=[redacted]',
    },
    {
      name: 'opaque-blob',
      // Long mixed alphanumeric runs with no separators: almost always a key,
      // hash or session id rather than something useful in a bug report.
      pattern:
        /\b(?=[A-Za-z0-9_-]{32,}\b)(?=[^\s]*[A-Za-z])(?=[^\s]*\d)[A-Za-z0-9_-]{32,}\b/g,
      replacement: '[redacted]',
    },
  ]

export interface RedactionResult {
  text: string
  /** How many values looked like a token, email or credential. */
  redactions: number
  /** True when the home directory (or username) was replaced with a placeholder. */
  anonymized: boolean
}

/**
 * Scrubs tokens, emails, credentials and the user's own paths from free text,
 * and reports what it changed so the caller can be honest about it.
 */
export function redactWithStats(input: string, home?: string): RedactionResult {
  if (!input) return { text: '', redactions: 0, anonymized: false }
  let output = input
  for (const { pattern, replacement } of PATTERNS) {
    output = output.replace(pattern, replacement)
  }
  const anonymized = anonymizePath(output, home)
  return {
    text: anonymized,
    redactions: (anonymized.match(/\[redacted/g) ?? []).length,
    anonymized: anonymized !== output,
  }
}

/**
 * Scrubs tokens, emails, credentials and the user's own paths from free text.
 * Returns the text unchanged when nothing matches.
 */
export function redact(input: string, home?: string): string {
  return redactWithStats(input, home).text
}

/** Redacts a single line and caps its length so reports stay readable. */
export function redactLine(
  line: string,
  maxLength = 400,
  home?: string,
): string {
  const redacted = redact(line, home).replace(/\s+$/, '')
  return redacted.length > maxLength
    ? `${redacted.slice(0, maxLength)}…`
    : redacted
}
