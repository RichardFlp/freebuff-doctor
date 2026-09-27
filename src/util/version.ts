import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

export const PACKAGE_NAME = 'freebuff-doctor'

interface Manifest {
  name?: string
  version?: string
}

let cached: string | null = null

/**
 * Reads this package's own version from the nearest `package.json`, resolved
 * relative to the installed module rather than the user's working directory.
 */
export function doctorVersion(): string {
  if (cached) return cached

  let dir = path.dirname(fileURLToPath(import.meta.url))
  for (let depth = 0; depth < 6; depth += 1) {
    const candidate = path.join(dir, 'package.json')
    try {
      const manifest = JSON.parse(
        fs.readFileSync(candidate, 'utf8'),
      ) as Manifest
      if (
        manifest.name === PACKAGE_NAME &&
        typeof manifest.version === 'string'
      ) {
        cached = manifest.version
        return cached
      }
    } catch {
      /* keep walking up */
    }
    const parent = path.dirname(dir)
    if (parent === dir) break
    dir = parent
  }

  cached = '0.0.0-unknown'
  return cached
}

/** Absolute path of the package root, used for `files`/asset lookups. */
export function packageRoot(): string {
  let dir = path.dirname(fileURLToPath(import.meta.url))
  for (let depth = 0; depth < 6; depth += 1) {
    if (fs.existsSync(path.join(dir, 'package.json'))) return dir
    const parent = path.dirname(dir)
    if (parent === dir) break
    dir = parent
  }
  return process.cwd()
}
