import path from 'node:path'

import { colorEnabled, isInteractive } from '../ui/theme.js'
import { anonymizePath, describePlatform } from './platform.js'
import { redact } from './redact.js'
import { doctorVersion } from './version.js'

/**
 * Variables that change how Freebuff, npm or Node behave. Anything not on this
 * list is left out of the snapshot, so a report stays small and private.
 */
export const INTERESTING_VARIABLES = [
  'NODE_OPTIONS',
  'NODE_PATH',
  'NODE_EXTRA_CA_CERTS',
  'SSL_CERT_FILE',
  'NODE_TLS_REJECT_UNAUTHORIZED',
  'NODE_USE_ENV_PROXY',
  'HTTP_PROXY',
  'HTTPS_PROXY',
  'ALL_PROXY',
  'NO_PROXY',
  'npm_config_registry',
  'npm_config_prefix',
  'NPM_CONFIG_PREFIX',
  'ELECTRON_RUN_AS_NODE',
  'GIT_SSH_COMMAND',
  'GIT_DIR',
  'TMPDIR',
  'TEMP',
  'TMP',
  'TERM',
  'LANG',
  'LC_ALL',
  'CI',
  'FBDOC_REGISTRY',
] as const

export interface EnvironmentSnapshot {
  doctor: string
  node: string
  npm: string | null
  platform: string
  arch: string
  cwd: string
  home: string
  shell: string | null
  interactive: boolean
  color: boolean
  pathEntries: Array<{ index: number; value: string; duplicate: boolean }>
  variables: Array<{ name: string; value: string }>
}

/** Builds the snapshot with every path anonymized and every value redacted. */
export function collectSnapshot(
  env: NodeJS.ProcessEnv = process.env,
  options: { home?: string; npmVersion?: string | null } = {},
): EnvironmentSnapshot {
  const home = options.home ?? ''
  const anonymize = (value: string): string =>
    home ? anonymizePath(value, home) : value

  const seen = new Set<string>()
  const pathEntries: EnvironmentSnapshot['pathEntries'] = []
  const pathValue = env.PATH ?? env.Path ?? ''
  for (const raw of pathValue.split(path.delimiter)) {
    const entry = raw.trim().replace(/^"(.*)"$/, '$1')
    if (!entry) continue
    const key = entry.replace(/[\\/]+$/, '').toLowerCase()
    const duplicate = seen.has(key)
    seen.add(key)
    pathEntries.push({
      index: pathEntries.length + 1,
      value: anonymize(entry),
      duplicate,
    })
  }

  const variables: EnvironmentSnapshot['variables'] = []
  for (const name of INTERESTING_VARIABLES) {
    const value = env[name]?.trim()
    if (!value) continue
    variables.push({ name, value: redact(value, home || undefined) })
  }

  return {
    doctor: doctorVersion(),
    node: process.version,
    npm: options.npmVersion ?? null,
    platform: describePlatform(),
    arch: process.arch,
    cwd: anonymize(process.cwd()),
    home: home ? anonymizePath(home, home) : '',
    shell: env.SHELL?.trim() || env.ComSpec?.trim() || null,
    interactive: isInteractive(),
    color: colorEnabled(),
    pathEntries,
    variables,
  }
}
