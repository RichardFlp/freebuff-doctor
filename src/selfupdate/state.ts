import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { resolvePlatformPaths } from '../util/platform.js'

/**
 * What the last automatic update did. Kept so the same version is never
 * installed twice — running from a git checkout is always behind the published
 * package, and without this the menu would reinstall the global copy on every
 * launch.
 */
export interface UpdateState {
  /** The version npm last installed for us. */
  installedVersion?: string
  /** When that happened, ISO 8601. */
  installedAt?: string
}

/** `<config root>/freebuff-doctor/state.json`, next to any saved API key. */
export function stateFile(
  home: string = os.homedir(),
  env: NodeJS.ProcessEnv = process.env,
): string {
  const { configRoot } = resolvePlatformPaths(home, env)
  return path.join(configRoot, 'freebuff-doctor', 'state.json')
}

/** The stored state, or an empty object when there is none or it is unreadable. */
export function readUpdateState(
  options: { home?: string; env?: NodeJS.ProcessEnv } = {},
): UpdateState {
  try {
    const parsed = JSON.parse(
      fs.readFileSync(stateFile(options.home, options.env), 'utf8'),
    ) as unknown
    return parsed && typeof parsed === 'object' ? (parsed as UpdateState) : {}
  } catch {
    return {}
  }
}

/** Persists the state. Returns false when the filesystem refused. */
export function writeUpdateState(
  state: UpdateState,
  options: { home?: string; env?: NodeJS.ProcessEnv } = {},
): boolean {
  const file = stateFile(options.home, options.env)
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 })
    fs.writeFileSync(file, `${JSON.stringify(state, null, 2)}\n`, 'utf8')
    return true
  } catch {
    return false
  }
}
