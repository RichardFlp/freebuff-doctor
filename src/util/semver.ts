export interface ParsedVersion {
  major: number
  minor: number
  patch: number
  prerelease: string | null
}

/** Parses `1.2.3-beta.1` (with optional leading `v`) into comparable parts. */
export function parseVersion(value: string): ParsedVersion | null {
  const match = /^\s*v?(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?/.exec(
    value ?? '',
  )
  if (!match) return null
  return {
    major: Number(match[1]),
    minor: Number(match[2]),
    patch: Number(match[3]),
    prerelease: match[4] ?? null,
  }
}

/**
 * Compares two semver strings. Returns `-1`, `0` or `1`.
 * Unparseable versions sort before parseable ones.
 */
export function compareVersions(a: string, b: string): number {
  const left = parseVersion(a)
  const right = parseVersion(b)
  if (!left && !right) return 0
  if (!left) return -1
  if (!right) return 1

  for (const key of ['major', 'minor', 'patch'] as const) {
    if (left[key] !== right[key]) return left[key] < right[key] ? -1 : 1
  }

  if (left.prerelease && !right.prerelease) return -1
  if (!left.prerelease && right.prerelease) return 1
  if (left.prerelease && right.prerelease) {
    return left.prerelease === right.prerelease
      ? 0
      : left.prerelease < right.prerelease
        ? -1
        : 1
  }
  return 0
}

/** True when `installed` is a parseable version strictly behind `latest`. */
export function isOutdated(installed: string, latest: string): boolean {
  const parsedInstalled = parseVersion(installed)
  const parsedLatest = parseVersion(latest)
  if (!parsedInstalled || !parsedLatest) return false
  return compareVersions(installed, latest) < 0
}

/** Node release lines that receive long-term support. */
export function isLtsMajor(major: number): boolean {
  return major % 2 === 0
}

/** Extracts the major version from a runtime version string. */
export function majorOf(value: string): number | null {
  return parseVersion(value)?.major ?? null
}
