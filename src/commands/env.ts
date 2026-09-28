import path from 'node:path'

import { exec, whichOne } from '../util/exec.js'
import { anonymizePath, describePlatform } from '../util/platform.js'
import { redact } from '../util/redact.js'
import { doctorVersion } from '../util/version.js'
import { heading, hint, write } from '../ui/output.js'
import { c, colorEnabled, GLYPH, isInteractive } from '../ui/theme.js'

/**
 * Variables that change how Freebuff, npm or Node behave. Anything not on this
 * list is left out of the snapshot, so a report stays small and private.
 */
const INTERESTING_VARIABLES = [
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

/** `fbdoc env` — the setup facts, with paths anonymized and secrets redacted. */
export async function runEnvCommand(options: {
  json: boolean
}): Promise<number> {
  // On Windows `npm` is a `.cmd` shim, so resolve it first rather than assuming
  // the bare name is spawnable — the same approach the install check uses.
  const npmBin = whichOne('npm')
  const npmResult = npmBin
    ? await exec(npmBin, ['--version'], { timeoutMs: 8000 })
    : null
  const snapshot = collectSnapshot(process.env, {
    home: process.env.USERPROFILE || process.env.HOME || '',
    npmVersion: npmResult?.ok ? npmResult.stdout.trim() : null,
  })

  if (options.json) {
    write(JSON.stringify(snapshot, null, 2))
    return 0
  }

  heading('Environment')
  write('')
  const facts: Array<[string, string]> = [
    ['Doctor', snapshot.doctor],
    ['Node', snapshot.node],
    ['npm', snapshot.npm ?? 'not found'],
    ['Platform', snapshot.platform],
    ['Working in', snapshot.cwd],
    ['Shell', snapshot.shell ?? 'unknown'],
  ]
  for (const [label, value] of facts) {
    write(`  ${c().dim(label.padEnd(11))}${value}`)
  }

  write('')
  write(
    `  ${c().bold('PATH')} ${c().dim(`${snapshot.pathEntries.length} entries, in search order`)}`,
  )
  for (const entry of snapshot.pathEntries) {
    const marker = entry.duplicate
      ? c().yellow(` ${GLYPH.bullet} duplicate`)
      : ''
    write(
      `    ${c().dim(String(entry.index).padStart(2))}. ${entry.value}${marker}`,
    )
  }

  write('')
  write(`  ${c().bold('Variables that affect Freebuff')}`)
  if (snapshot.variables.length === 0) {
    write(
      c().dim('    None of the variables that usually cause trouble are set.'),
    )
  } else {
    for (const variable of snapshot.variables) {
      write(`    ${c().cyan(variable.name)}=${variable.value}`)
    }
  }

  write('')
  hint('Secrets are redacted and your home directory is replaced with ~.')
  hint('For pass/fail findings instead of raw facts, run `fbdoc check`.')
  return 0
}
