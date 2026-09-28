export interface GlobalOptions {
  /** Print stack traces and extra diagnostics. */
  verbose: boolean
  /** Skip every check that needs the network. */
  offline: boolean
  /** Per-network-operation timeout in milliseconds. */
  timeoutMs: number
  /** Emit machine-readable JSON on stdout. */
  json: boolean
  /** Treat warnings as failures for the exit code. */
  strict: boolean
  /** Print every check result in full, including the ones that passed. */
  all: boolean
  /** Print only the checks that need attention. */
  quiet: boolean
  /** Restrict the run to these check ids. */
  only?: string[]
}

export const DEFAULT_TIMEOUT_MS = 8000

/** Parses and clamps `--timeout`, falling back to the default on nonsense. */
export function parseTimeout(raw: unknown): number {
  const value =
    typeof raw === 'string'
      ? Number.parseInt(raw, 10)
      : typeof raw === 'number'
        ? raw
        : Number.NaN
  if (!Number.isFinite(value) || value <= 0) return DEFAULT_TIMEOUT_MS
  return Math.min(Math.max(Math.trunc(value), 1000), 60_000)
}

/** Parses `--only a,b,c` into a list of check ids. */
export function parseOnly(raw: unknown): string[] | undefined {
  if (typeof raw !== 'string') return undefined
  const ids = raw
    .split(',')
    .map((id) => id.trim())
    .filter(Boolean)
  return ids.length > 0 ? ids : undefined
}

export function defaultOptions(
  overrides: Partial<GlobalOptions> = {},
): GlobalOptions {
  return {
    verbose: false,
    offline: false,
    timeoutMs: DEFAULT_TIMEOUT_MS,
    json: false,
    strict: false,
    all: false,
    quiet: false,
    ...overrides,
  }
}
