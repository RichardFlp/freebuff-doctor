import fs from 'node:fs'
import path from 'node:path'

import { anonymizePath } from '../util/platform.js'
import {
  found,
  type CheckContext,
  type DiagnosticCheck,
  type ResultInit,
} from './types.js'

/** Heaps below this are too small for the engine; above it, a reservation trap. */
export const MIN_HEAP_MB = 512
export const MAX_HEAP_MB = 32 * 1024

const MAXIZED = /--max-old-space-size[= ](\d+)/
const LEGACY_PROVIDER = /--openssl-legacy-provider/

export interface EnvIssue {
  variable: string
  message: string
  /** A command that clears it, when one makes sense. */
  fix?: string
}

function unsetFix(variable: string, platform: NodeJS.Platform): string {
  // Windows has no `unset`; the PowerShell form works in every shell's default
  // Windows setup and removes a user-level variable for good.
  return platform === 'win32'
    ? `[Environment]::SetEnvironmentVariable('${variable}', $null, 'User')`
    : `unset ${variable}`
}

function formatMegabytes(value: number): string {
  if (value >= 1024) return `${Math.round(value / 1024)} GB`
  return `${value} MB`
}

/**
 * Hostile or leftover environment variables that make Freebuff fail in ways the
 * app never reports: a legacy OpenSSL provider, a heap reservation that will
 * never fit, a shadowed module path, or a registry that isn't npm's.
 */
export function inspectEnvironment(
  env: NodeJS.ProcessEnv,
  platform: NodeJS.Platform = process.platform,
  fileExists: (target: string) => boolean = fs.existsSync,
  cwd: string = process.cwd(),
): EnvIssue[] {
  const issues: EnvIssue[] = []

  const nodeOptions = env.NODE_OPTIONS?.trim()
  if (nodeOptions) {
    if (LEGACY_PROVIDER.test(nodeOptions)) {
      issues.push({
        variable: 'NODE_OPTIONS',
        message: `sets --openssl-legacy-provider (${nodeOptions}), which switches Node back to an old OpenSSL provider and breaks some TLS connections.`,
        fix: unsetFix('NODE_OPTIONS', platform),
      })
    }

    const heap = MAXIZED.exec(nodeOptions)
    const heapMb = heap?.[1] ? Number(heap[1]) : null
    if (heapMb !== null && heapMb > MAX_HEAP_MB) {
      issues.push({
        variable: 'NODE_OPTIONS',
        message: `reserves a ${formatMegabytes(heapMb)} V8 heap, which is more than the engine can allocate and makes Node fail early.`,
        fix: unsetFix('NODE_OPTIONS', platform),
      })
    } else if (heapMb !== null && heapMb < MIN_HEAP_MB) {
      issues.push({
        variable: 'NODE_OPTIONS',
        message: `caps the V8 heap at ${formatMegabytes(heapMb)}, which the engine will exhaust quickly.`,
        fix: unsetFix('NODE_OPTIONS', platform),
      })
    }

    for (const match of nodeOptions.matchAll(
      /--(?:require|import|loader|experimental-loader)[= ](\S+)/g,
    )) {
      const target = match[1] ?? ''
      const resolved = path.isAbsolute(target)
        ? target
        : path.resolve(cwd, target)
      if (target && !fileExists(resolved)) {
        issues.push({
          variable: 'NODE_OPTIONS',
          message: `loads ${target}, which does not exist — Node refuses to start when a loader is missing.`,
          fix: unsetFix('NODE_OPTIONS', platform),
        })
      }
    }
  }

  const nodePath = env.NODE_PATH?.trim()
  if (nodePath) {
    issues.push({
      variable: 'NODE_PATH',
      message: `is set to ${nodePath}; legacy module resolution can shadow Freebuff's own dependencies with unrelated copies.`,
      fix: unsetFix('NODE_PATH', platform),
    })
  }

  for (const [key, value] of Object.entries(env)) {
    if (key.toLowerCase() !== 'npm_config_registry') continue
    const registry = value?.trim()
    if (!registry || isNpmjsRegistry(registry)) continue
    issues.push({
      variable: key,
      message: `points npm at ${registry} instead of registry.npmjs.org, so installing or updating the CLI may fail or fetch an unexpected package.`,
      fix: 'npm config delete registry',
    })
  }

  const prefix = env.NPM_CONFIG_PREFIX?.trim()
  if (prefix) {
    issues.push({
      variable: 'NPM_CONFIG_PREFIX',
      message: `sends global installs to ${prefix}, which is why a freshly installed \`freebuff\` command can be missing from PATH.`,
      fix: unsetFix('NPM_CONFIG_PREFIX', platform),
    })
  }

  const electronRunAsNode = env.ELECTRON_RUN_AS_NODE?.trim()
  if (electronRunAsNode) {
    issues.push({
      variable: 'ELECTRON_RUN_AS_NODE',
      message:
        'makes the Electron-based desktop app start as a plain Node process, so the window never appears.',
      fix: unsetFix('ELECTRON_RUN_AS_NODE', platform),
    })
  }

  return issues
}

/** True when a registry URL points at npm's own registry. */
export function isNpmjsRegistry(value: string): boolean {
  const trimmed = value.trim()
  if (!trimmed) return true
  try {
    const url = new URL(trimmed)
    return url.hostname.toLowerCase() === 'registry.npmjs.org'
  } catch {
    return /(^|\/\/)registry\.npmjs\.org(\/|$)/.test(trimmed)
  }
}

function parseNpmrc(
  text: string,
): Array<{ key: string; value: string; line: number }> {
  const entries: Array<{ key: string; value: string; line: number }> = []
  const lines = text.split(/\r?\n/)
  for (const [index, raw] of lines.entries()) {
    const line = raw.trim()
    if (!line || line.startsWith('#') || line.startsWith(';')) continue
    const separator = line.indexOf('=')
    if (separator === -1) continue
    entries.push({
      key: line.slice(0, separator).trim(),
      value: line.slice(separator + 1).trim(),
      line: index + 1,
    })
  }
  return entries
}

/**
 * Flags an `.npmrc` that redirects npm at another registry, and a token stored in
 * a *project* `.npmrc` (a file that is usually one `git add` away from being
 * published).
 */
export function inspectNpmrc(
  text: string,
  source: 'user' | 'project',
): EnvIssue[] {
  const issues: EnvIssue[] = []

  for (const entry of parseNpmrc(text)) {
    if (entry.key.toLowerCase() === 'registry') {
      if (isNpmjsRegistry(entry.value)) continue
      issues.push({
        variable: '.npmrc',
        message: `line ${entry.line} of the ${source === 'project' ? 'project' : 'user'} .npmrc points npm at ${entry.value} instead of registry.npmjs.org.`,
        fix: 'npm config delete registry',
      })
      continue
    }

    if (source === 'project' && /_authToken$/i.test(entry.key)) {
      issues.push({
        variable: '.npmrc',
        message: `line ${entry.line} stores an npm token in a project-level .npmrc, where it can be committed to the repository.`,
      })
    }
  }

  return issues
}

/** Shell start-up files that may be exporting an environment variable. */
export function shellProfilePaths(
  home: string,
  platform: NodeJS.Platform,
): string[] {
  if (platform === 'win32') {
    return [
      path.join(
        home,
        'Documents',
        'PowerShell',
        'Microsoft.PowerShell_profile.ps1',
      ),
      path.join(
        home,
        'Documents',
        'WindowsPowerShell',
        'Microsoft.PowerShell_profile.ps1',
      ),
      // Git Bash and MSYS shells on Windows read these too.
      path.join(home, '.bashrc'),
      path.join(home, '.bash_profile'),
      path.join(home, '.zshrc'),
      path.join(home, '.zshenv'),
      path.join(home, '.profile'),
    ]
  }
  return [
    path.join(home, '.zshrc'),
    path.join(home, '.zshenv'),
    path.join(home, '.bashrc'),
    path.join(home, '.bash_profile'),
    path.join(home, '.profile'),
    path.join(home, '.config', 'fish', 'config.fish'),
  ]
}

export interface ProfileFile {
  path: string
  text: string
}

/**
 * Finds which shell profile sets a variable, so the advice is "edit this line"
 * rather than "unset it and hope". Returns `file:line`, or null.
 */
export function findVariableOrigin(
  variable: string,
  files: ProfileFile[],
): string | null {
  const pattern = new RegExp(
    `(^|[\\s;])(export\\s+|\\$env:|set\\s+|setx\\s+)?${variable}\\s*=`,
    'm',
  )
  for (const file of files) {
    const lines = file.text.split(/\r?\n/)
    for (const [index, line] of lines.entries()) {
      if (pattern.test(line)) return `${file.path}:${index + 1}`
    }
  }
  return null
}

/** Reads the shell profiles once, capped so a huge rc file stays cheap. */
function readProfiles(paths: string[]): ProfileFile[] {
  const files: ProfileFile[] = []
  for (const file of paths) {
    try {
      const stat = fs.statSync(file)
      if (!stat.isFile() || stat.size > 256 * 1024) continue
      files.push({ path: file, text: fs.readFileSync(file, 'utf8') })
    } catch {
      /* profile does not exist */
    }
  }
  return files
}

function readTextFile(file: string, maxBytes = 64 * 1024): string | null {
  try {
    const stat = fs.statSync(file)
    if (!stat.isFile()) return null
    const handle = fs.openSync(file, 'r')
    try {
      const buffer = Buffer.alloc(Math.min(stat.size, maxBytes))
      const read = fs.readSync(handle, buffer, 0, buffer.length, 0)
      return buffer.subarray(0, read).toString('utf8')
    } finally {
      fs.closeSync(handle)
    }
  } catch {
    return null
  }
}

/**
 * Inspects the environment Freebuff inherits plus the two `.npmrc` files that
 * redirect npm. These are the invisible causes: the app behaves differently in
 * one terminal than another, and nothing in its own logs explains why.
 */
export const envHygieneCheck: DiagnosticCheck = {
  id: 'env-hygiene',
  title: 'Environment variables',
  async run(context: CheckContext) {
    const issues: EnvIssue[] = inspectEnvironment(
      context.env,
      context.platform,
      fs.existsSync,
      context.cwd,
    )

    const npmrcFiles: Array<{ file: string; source: 'user' | 'project' }> = [
      { file: path.join(context.home, '.npmrc'), source: 'user' },
      { file: path.join(context.cwd, '.npmrc'), source: 'project' },
    ]
    for (const { file, source } of npmrcFiles) {
      const text = readTextFile(file)
      if (text === null) continue
      issues.push(...inspectNpmrc(text, source))
    }

    const profiles = readProfiles(
      shellProfilePaths(context.home, context.platform),
    )
    const origins = new Map<string, string>()
    for (const issue of issues) {
      const variable = issue.variable.split(' ')[0] ?? issue.variable
      const origin = findVariableOrigin(variable, profiles)
      if (origin) {
        origins.set(
          issue.variable,
          anonymizePath(origin, context.home, context.platform),
        )
      }
    }

    const data = {
      issues: issues.map((issue) => ({
        variable: issue.variable,
        ...(origins.has(issue.variable)
          ? { origin: origins.get(issue.variable) }
          : {}),
      })),
      profiles: profiles.map((file) =>
        anonymizePath(file.path, context.home, context.platform),
      ),
    }

    if (issues.length === 0) {
      return found({
        status: 'pass',
        message: 'No hostile environment variables found.',
        details: [
          profiles.length > 0
            ? `Checked ${profiles.length} shell profile${profiles.length === 1 ? '' : 's'} and both .npmrc files for registry overrides.`
            : 'No shell profiles were readable, so only the current process environment was inspected.',
        ],
        data,
      })
    }

    const first = issues[0] as EnvIssue
    // Every issue is listed in full, origin included: the primary one is not
    // repeated in the message, so nothing is lost by describing it here.
    const details = issues.map((issue) => {
      const origin = origins.get(issue.variable)
      return `${issue.variable} ${issue.message}${origin ? ` (set in ${origin})` : ''}`
    })

    const verdict: ResultInit = {
      status: 'warn',
      message: `${issues.length} environment variable${issues.length === 1 ? '' : 's'} could change how Freebuff behaves.`,
      details: [
        ...details,
        'Environment variables set outside a shell profile (system settings, an IDE, or a launcher) do not show up here.',
      ],
      ...(first.fix ? { fix: first.fix } : {}),
      faqSlug: 'troubleshooting-official',
    }

    return found({ ...verdict, data })
  },
}
