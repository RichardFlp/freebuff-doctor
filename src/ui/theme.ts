import { createColors } from 'picocolors'

export type Colors = ReturnType<typeof createColors>
export type StatusKind = 'pass' | 'warn' | 'fail' | 'skip'

/** Status markers, matching the semantics used across every command. */
export const STATUS_ICON: Record<StatusKind, string> = {
  pass: '✅',
  warn: '⚠️ ',
  fail: '❌',
  skip: '➖',
}

export const STATUS_LABEL: Record<StatusKind, string> = {
  pass: 'pass',
  warn: 'warn',
  fail: 'fail',
  skip: 'n/a',
}

export const GLYPH = {
  bullet: '•',
  arrow: '→',
  chevron: '›',
  rule: '─',
  pointer: '❯',
  success: '✔',
  failure: '✖',
  timer: '⏱',
} as const

let forcedEnabled: boolean | null = null
let cachedColors: Colors | null = null

function truthy(value: string | undefined): boolean {
  if (value === undefined) return false
  const normalized = value.trim().toLowerCase()
  return normalized !== '' && normalized !== '0' && normalized !== 'false'
}

/** `NO_COLOR` counts only when present and non-empty, per the informal spec. */
function noColorRequested(env: NodeJS.ProcessEnv): boolean {
  return 'NO_COLOR' in env && (env.NO_COLOR ?? '') !== ''
}

/**
 * Decides whether ANSI colour is safe. Piped output, CI and `NO_COLOR` all
 * quietly downgrade to plain text rather than emitting escape codes.
 */
export function resolveColorSupport(
  stream: { isTTY?: boolean } = process.stdout,
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  if (forcedEnabled !== null) return forcedEnabled
  if (noColorRequested(env)) return false
  if (truthy(env.FORCE_COLOR) || truthy(env.CLICOLOR_FORCE)) return true
  if (env.CLICOLOR === '0') return false
  if (truthy(env.CI) && !truthy(env.FORCE_COLOR)) return false
  if (env.TERM === 'dumb') return false
  return stream.isTTY === true
}

/** Overrides colour detection, e.g. from `--color` / `--no-color`. */
export function setColorEnabled(value: boolean | null): void {
  forcedEnabled = value
  cachedColors = null
}

export function colorEnabled(): boolean {
  return resolveColorSupport()
}

/** Lazily built colour palette. Always call this rather than importing picocolors. */
export function c(): Colors {
  cachedColors ??= createColors(colorEnabled())
  return cachedColors
}

/**
 * A palette that never emits escapes, for rendering a block as plain text even
 * on a terminal that supports colour — the streaming answer does this for
 * tables when the reader asked for no colour.
 */
export function plainColors(): Colors {
  return createColors(false)
}

/** True when the process can prompt: interactive terminal, not a pipe or CI. */
export function isInteractive(
  stream: { isTTY?: boolean } = process.stdout,
): boolean {
  if (stream.isTTY !== true) return false
  if (truthy(process.env.CI)) return false
  return true
}

/** Terminal width, clamped to a comfortable reading measure. */
export function terminalWidth(): number {
  const columns = process.stdout.columns ?? 80
  return Math.max(40, Math.min(columns, 100))
}

/** True when `--verbose` was requested. */
export function isVerbose(): boolean {
  return verboseEnabled
}

let verboseEnabled = false

export function setVerbose(value: boolean): void {
  verboseEnabled = value
}

/**
 * Wraps text in an OSC-8 hyperlink when the terminal supports it, otherwise
 * returns the plain label so piped output stays grep-able.
 */
export function hyperlink(label: string, url: string): string {
  if (!colorEnabled() || !isInteractive()) return label
  return `\u001b]8;;${url}\u0007${label}\u001b]8;;\u0007`
}

/** Formats a path with the home directory collapsed to `~`, dimmed and cyan. */
export function stylePath(value: string): string {
  return c().cyan(value)
}

export function styleMuted(value: string): string {
  return c().dim(value)
}

export function styleCommand(value: string): string {
  return c().cyan(value)
}
