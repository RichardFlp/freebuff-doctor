import { spawn } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'

import { isWindows } from './platform.js'

export interface ExecResult {
  ok: boolean
  code: number | null
  stdout: string
  stderr: string
  timedOut: boolean
  /** Set when the process could not be spawned at all (e.g. ENOENT). */
  error?: string
}

export interface ExecOptions {
  cwd?: string
  timeoutMs?: number
  env?: NodeJS.ProcessEnv
  /** Force or suppress shell execution. Auto-detected for `.cmd`/`.bat` on Windows. */
  shell?: boolean
  maxBuffer?: number
}

function quoteForShell(value: string): string {
  return /[\s"&|<>^]/.test(value) ? `"${value.replace(/"/g, '\\"')}"` : value
}

/**
 * Runs a command and always resolves — never rejects — so diagnostic checks can
 * treat a missing or failing binary as a result rather than an exception.
 */
export function exec(
  command: string,
  args: string[] = [],
  options: ExecOptions = {},
): Promise<ExecResult> {
  const { cwd, timeoutMs = 10_000, env, maxBuffer = 1024 * 1024 } = options
  const useShell = options.shell ?? (isWindows && /\.(cmd|bat)$/i.test(command))
  // On Windows the shell is only available as a single command line, and a
  // `.cmd` shim (npm) must be able to execute, so quoting is done up front.
  const [file, fileArgs] = useShell
    ? [
        [quoteForShell(command), ...args.map(quoteForShell)].join(' '),
        [] as string[],
      ]
    : [command, args]

  return new Promise<ExecResult>((resolve) => {
    let stdout = ''
    let stderr = ''
    let timedOut = false
    let settled = false

    const finish = (result: ExecResult): void => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      resolve(result)
    }

    let child: ReturnType<typeof spawn>
    try {
      child = spawn(file, fileArgs, {
        cwd,
        env: env ?? process.env,
        windowsHide: true,
        shell: useShell,
      })
    } catch (error) {
      resolve({
        ok: false,
        code: null,
        stdout: '',
        stderr: '',
        timedOut: false,
        error: error instanceof Error ? error.message : String(error),
      })
      return
    }

    const timer = setTimeout(() => {
      timedOut = true
      child.kill('SIGKILL')
    }, timeoutMs)

    child.stdout?.on('data', (chunk: Buffer) => {
      if (stdout.length < maxBuffer) stdout += chunk.toString('utf8')
    })
    child.stderr?.on('data', (chunk: Buffer) => {
      if (stderr.length < maxBuffer) stderr += chunk.toString('utf8')
    })

    child.on('error', (error) => {
      finish({
        ok: false,
        code: null,
        stdout,
        stderr,
        timedOut: false,
        error: error.message,
      })
    })

    child.on('close', (code) => {
      finish({
        ok: code === 0 && !timedOut,
        code,
        stdout,
        stderr,
        timedOut,
      })
    })
  })
}

/** True when a path exists and is a regular file. */
function isFile(candidate: string): boolean {
  try {
    return fs.statSync(candidate).isFile()
  } catch {
    return false
  }
}

/**
 * Resolves every match for a command on `PATH`, mirroring `which -a` /
 * `where`. Duplicate symlink targets are collapsed so nvm's shims don't look
 * like several separate installs.
 */
export function whichAll(
  command: string,
  options: { pathValue?: string; platform?: NodeJS.Platform } = {},
): string[] {
  const platform = options.platform ?? process.platform
  const pathValue = options.pathValue ?? process.env.PATH ?? ''
  const dirs = pathValue
    .split(path.delimiter)
    .map((entry) => entry.trim().replace(/^"(.*)"$/, '$1'))
    .filter(Boolean)

  const extensions =
    platform === 'win32'
      ? normalizeExtensions(process.env.PATHEXT ?? '.COM;.EXE;.BAT;.CMD')
      : ['']

  const found: string[] = []
  const seen = new Set<string>()

  for (const dir of dirs) {
    for (const extension of extensions) {
      const candidate = path.join(dir, command + extension)
      if (!isFile(candidate)) continue
      let resolved = candidate
      try {
        resolved = fs.realpathSync.native(candidate)
      } catch {
        /* keep the unresolved path */
      }
      const key = platform === 'win32' ? resolved.toLowerCase() : resolved
      if (seen.has(key)) continue
      seen.add(key)
      found.push(candidate)
    }
  }

  return found
}

function normalizeExtensions(raw: string): string[] {
  const parts = raw
    .split(';')
    .map((part) => part.trim())
    .filter(Boolean)
    .map((part) => (part.startsWith('.') ? part : `.${part}`))
  // A bare name is also valid on Windows, but only with an explicit extension.
  return parts.length > 0 ? parts : ['.EXE']
}

/** First match for a command on `PATH`, or `null`. */
export function whichOne(
  command: string,
  options: { pathValue?: string; platform?: NodeJS.Platform } = {},
): string | null {
  return whichAll(command, options)[0] ?? null
}

export interface GlobalPackages {
  /** npm's global root, when it could be determined. */
  npmRoot: string | null
  /** Lower-cased package name to installed version. */
  packages: Map<string, string>
  /** Populated when the global root could not be located. */
  error?: string
}

let globalPackagesPromise: Promise<GlobalPackages> | null = null

/** Clears the memoised npm-globals lookup. Used by tests. */
export function resetGlobalPackagesCache(): void {
  globalPackagesPromise = null
}

/**
 * Enumerates globally installed npm packages by scanning npm's global
 * `node_modules` directory. One `npm root -g` call, then pure filesystem reads
 * — much faster than `npm ls -g --json` on a cold cache.
 */
export function getGlobalPackages(
  options: { timeoutMs?: number } = {},
): Promise<GlobalPackages> {
  globalPackagesPromise ??= loadGlobalPackages(options.timeoutMs ?? 20_000)
  return globalPackagesPromise
}

async function loadGlobalPackages(timeoutMs: number): Promise<GlobalPackages> {
  const packages = new Map<string, string>()
  const npmRoot = await findNpmRoot(timeoutMs)
  if (!npmRoot) {
    return {
      npmRoot: null,
      packages,
      error: "Could not determine npm's global install directory.",
    }
  }
  collectPackages(npmRoot, packages)
  return { npmRoot, packages }
}

async function findNpmRoot(timeoutMs: number): Promise<string | null> {
  const npmBin = whichOne('npm')
  if (npmBin) {
    const result = await exec(npmBin, ['root', '-g'], { timeoutMs })
    const reported = result.stdout.trim().split(/\r?\n/).pop()?.trim()
    if (result.ok && reported) return reported
  }

  // Fall back to the conventional layout relative to the npm executable.
  if (npmBin) {
    const binDir = path.dirname(npmBin)
    const candidates =
      process.platform === 'win32'
        ? [
            path.join(binDir, 'node_modules'),
            path.join(binDir, '..', 'node_modules'),
          ]
        : [
            path.join(binDir, '..', 'lib', 'node_modules'),
            path.join(binDir, '..', 'node_modules'),
          ]
    for (const candidate of candidates) {
      if (fs.existsSync(candidate)) return path.resolve(candidate)
    }
  }
  return null
}

function collectPackages(root: string, into: Map<string, string>): void {
  let entries: fs.Dirent[]
  try {
    entries = fs.readdirSync(root, { withFileTypes: true })
  } catch {
    return
  }

  for (const entry of entries) {
    if (!entry.isDirectory() && !entry.isSymbolicLink()) continue
    if (entry.name.startsWith('.')) continue
    const full = path.join(root, entry.name)
    if (entry.name.startsWith('@')) {
      // Scoped packages: one more level down.
      let scoped: fs.Dirent[]
      try {
        scoped = fs.readdirSync(full, { withFileTypes: true })
      } catch {
        continue
      }
      for (const child of scoped) {
        if (!child.isDirectory() && !child.isSymbolicLink()) continue
        readPackageJson(
          path.join(full, child.name),
          `${entry.name}/${child.name}`,
          into,
        )
      }
      continue
    }
    readPackageJson(full, entry.name, into)
  }
}

function readPackageJson(
  packageDir: string,
  fallbackName: string,
  into: Map<string, string>,
): void {
  try {
    const manifestPath = path.join(packageDir, 'package.json')
    const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8')) as {
      name?: string
      version?: string
    }
    const name = (manifest.name ?? fallbackName).toLowerCase()
    into.set(name, manifest.version ?? 'unknown')
  } catch {
    /* not a readable package */
  }
}
