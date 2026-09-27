import fs from 'node:fs'
import path from 'node:path'

import { exec, getGlobalPackages, whichAll } from '../util/exec.js'
import { canAccess, exists, safeStat } from '../util/fs-scan.js'
import { anonymizePath } from '../util/platform.js'
import {
  found,
  type CheckContext,
  type DiagnosticCheck,
  type ResultInit,
} from './types.js'

export const QUARANTINE_ATTRIBUTE = 'com.apple.quarantine'

/** Package names that provide the Freebuff/Codebuff command-line agent. */
const CLI_PACKAGES = ['freebuff', 'codebuff'] as const

/** Windows and PowerShell launchers npm writes next to the real script. */
const SHIM_EXTENSIONS = /\.(cmd|bat|ps1|sh)$/i

/** A node binary referenced from a shim is expected to be optional. */
const NODE_REFERENCE = /^node(\.exe)?$/i

/**
 * Extracts the scripts a Windows/PowerShell npm shim actually launches, so a
 * half-installed package can be spotted without executing anything. `%dp0%` is
 * the shim's own directory; `$basedir` is its PowerShell equivalent.
 */
export function extractShimTargets(content: string, binDir: string): string[] {
  const targets: string[] = []

  const add = (raw: string): void => {
    const relative = raw.trim().replace(/^["']|["']$/g, '')
    if (!relative) return
    const firstSegment = relative.split(/[\\/]/)[0] ?? ''
    // `node`/`node.exe`/`node$exe` references are optional: the shim falls back
    // to whatever node is on PATH, so a missing copy is not a broken install.
    const withoutExeVariable = relative.replace(/(\$exe|%exe%)$/i, '')
    if (
      NODE_REFERENCE.test(firstSegment.replace(/(\$exe|%exe%)$/i, '')) ||
      NODE_REFERENCE.test(withoutExeVariable)
    ) {
      return
    }
    const resolved = path.resolve(binDir, relative)
    if (!targets.includes(resolved)) targets.push(resolved)
  }

  for (const match of content.matchAll(
    /(?:%~?dp0%|\$basedir)\s*[\\/]\s*([^"'\r\n]+)/gi,
  )) {
    if (match[1]) add(match[1])
  }

  return targets
}

export interface BinaryObservation {
  /** Anonymized path, for messages. */
  path: string
  size: number | null
  /** POSIX executable bit. Always true on Windows, which has no such bit. */
  executable: boolean
  /** A symlink whose target does not resolve. */
  dangling: boolean
  /** macOS Gatekeeper quarantine attribute present. */
  quarantined: boolean
  /** Scripts a launcher points at that are missing from disk. */
  missingTargets: string[]
  platform: NodeJS.Platform
}

/**
 * Pure verdict for a single installed binary. "Present but not runnable" is an
 * outright failure: every other check sees a healthy install, yet the shell
 * reports the command as missing or the OS refuses to launch it.
 */
export function classifyBinary(observation: BinaryObservation): ResultInit {
  const {
    path: binary,
    size,
    executable,
    dangling,
    quarantined,
    missingTargets,
    platform,
  } = observation

  if (dangling) {
    return {
      status: 'fail',
      message: `${binary} is a symlink whose target no longer exists — the command is on your PATH but cannot run.`,
      fix: 'Reinstall the CLI: `npm i -g freebuff@latest`',
      faqSlug: 'troubleshooting-official',
    }
  }

  if (size === 0) {
    return {
      status: 'fail',
      message: `${binary} exists but is empty — the install was interrupted or blocked mid-write.`,
      fix: 'Reinstall the CLI: `npm i -g freebuff@latest`',
      faqSlug: 'troubleshooting-official',
    }
  }

  if (!executable) {
    return {
      status: 'fail',
      message: `${binary} is present but not executable, so running \`fbdoc\` or \`freebuff\` fails with "permission denied".`,
      fix: `chmod +x "${binary}"`,
      faqSlug: 'troubleshooting-official',
    }
  }

  if (missingTargets.length > 0) {
    const missing = missingTargets[0] as string
    return {
      status: 'fail',
      message: `${binary} launches a script that is no longer installed (${missing}) — the package folder is incomplete.`,
      fix: 'Reinstall the CLI: `npm i -g freebuff@latest`',
      faqSlug: 'troubleshooting-official',
    }
  }

  if (quarantined) {
    return {
      status: 'warn',
      message: `${binary} carries the macOS quarantine flag; macOS may refuse to launch it after an update.`,
      fix: `xattr -d ${QUARANTINE_ATTRIBUTE} "${binary}"`,
      faqSlug: 'troubleshooting-official',
    }
  }

  return {
    status: 'pass',
    message: `${binary} is complete and runnable${
      platform === 'win32' ? '' : ' (executable bit set)'
    }.`,
  }
}

async function isQuarantined(
  binary: string,
  platform: NodeJS.Platform,
): Promise<boolean> {
  if (platform !== 'darwin') return false
  const result = await exec('xattr', ['-p', QUARANTINE_ATTRIBUTE, binary], {
    timeoutMs: 4000,
  })
  return result.ok && result.stdout.trim().length > 0
}

function readHead(file: string, maxBytes = 8192): string {
  try {
    const stat = fs.statSync(file)
    const length = Math.min(stat.size, maxBytes)
    if (length === 0) return ''
    const handle = fs.openSync(file, 'r')
    try {
      const buffer = Buffer.alloc(length)
      const read = fs.readSync(handle, buffer, 0, length, 0)
      return buffer.subarray(0, read).toString('utf8')
    } finally {
      fs.closeSync(handle)
    }
  } catch {
    return ''
  }
}

function findShimTargets(
  binary: string,
  platform: NodeJS.Platform,
  home: string,
): string[] {
  if (!SHIM_EXTENSIONS.test(binary)) return []
  const content = readHead(binary)
  return extractShimTargets(content, path.dirname(binary))
    .filter((target) => !exists(target))
    .map((target) => anonymizePath(target, home, platform))
}

function observeBinary(
  binary: string,
  platform: NodeJS.Platform,
  home: string,
): BinaryObservation {
  const link = safeStat(binary)
  let dangling = false
  try {
    fs.realpathSync.native(binary)
  } catch {
    dangling = true
  }

  return {
    path: anonymizePath(binary, home, platform),
    size: link?.size ?? null,
    // Windows has no executable bit, so this only means something on POSIX.
    executable: platform === 'win32' || canAccess(binary, fs.constants.X_OK),
    dangling,
    quarantined: false,
    missingTargets: findShimTargets(binary, platform, home),
    platform,
  }
}

/** Global-bin locations npm might have left a shim in when it is not on PATH. */
function candidateShims(
  npmRoot: string | null,
  platform: NodeJS.Platform,
): string[] {
  if (!npmRoot) return []
  const names = [...CLI_PACKAGES]
  const dirs =
    platform === 'win32'
      ? [npmRoot]
      : [path.join(path.dirname(npmRoot), 'bin'), path.join(npmRoot, '.bin')]
  const extensions = platform === 'win32' ? ['.cmd', '.ps1', ''] : ['']
  const candidates: string[] = []
  for (const dir of dirs) {
    for (const name of names) {
      for (const extension of extensions) {
        candidates.push(path.join(dir, `${name}${extension}`))
      }
    }
  }
  return candidates
}

/**
 * Confirms the installed command is really runnable: the file is complete, the
 * executable bit is set, macOS has not quarantined it, and the script its
 * launcher points at still exists. Nothing is executed, so the check cannot
 * trigger an engine download or an update as a side effect.
 */
export const binaryIntegrityCheck: DiagnosticCheck = {
  id: 'binary-integrity',
  title: 'Installed binary is runnable',
  async run(context: CheckContext) {
    const binaries: string[] = []
    for (const name of CLI_PACKAGES) {
      for (const match of whichAll(name, { platform: context.platform })) {
        if (!binaries.includes(match)) binaries.push(match)
      }
    }

    const cachedEngine = path.join(context.paths.cliState, 'codebuff')
    const engineStat = safeStat(cachedEngine)
    const engineExists = engineStat?.isFile() ?? false

    const data = {
      binaries: binaries.map((binary) =>
        anonymizePath(binary, context.home, context.platform),
      ),
      cachedEngine: engineExists
        ? anonymizePath(cachedEngine, context.home, context.platform)
        : null,
    }

    if (binaries.length === 0) {
      // Nothing on PATH: look for a shim left behind by an uninstalled or
      // broken global package, which is the "command not found" case. The shim
      // must exist as a directory entry, so `lstat` rather than `access`.
      const globals = await getGlobalPackages({
        timeoutMs: Math.min(Math.max(context.timeoutMs, 5000), 25_000),
      })
      const danglingShim = candidateShims(
        globals.npmRoot,
        context.platform,
      ).find((candidate) => {
        try {
          fs.lstatSync(candidate)
        } catch {
          return false
        }
        try {
          fs.realpathSync.native(candidate)
          return false
        } catch {
          return true
        }
      })

      if (danglingShim) {
        return found({
          status: 'fail',
          message: `${anonymizePath(danglingShim, context.home, context.platform)} points at a package that is no longer installed, so every \`freebuff\` command fails while the shim is still on PATH.`,
          fix:
            context.platform === 'win32'
              ? `del "${danglingShim}"`
              : `rm "${danglingShim}"`,
          faqSlug: 'troubleshooting-official',
          data,
        })
      }
    }

    const observations: BinaryObservation[] = []
    for (const binary of binaries) {
      const observation = observeBinary(binary, context.platform, context.home)
      observations.push({
        ...observation,
        quarantined: await isQuarantined(binary, context.platform),
      })
    }

    const verdicts = observations.map((observation) => ({
      observation,
      verdict: classifyBinary(observation),
    }))
    const failure = verdicts.find((entry) => entry.verdict.status !== 'pass')

    if (failure) {
      return found({
        ...failure.verdict,
        details: verdicts
          .filter((entry) => entry !== failure)
          .map(
            (entry) =>
              `Also checked ${entry.observation.path} — ${entry.verdict.message}`,
          ),
        data: {
          ...data,
          binaries: observations.map((observation) => ({
            path: observation.path,
            size: observation.size,
            executable: observation.executable,
            dangling: observation.dangling,
            quarantined: observation.quarantined,
            missingTargets: observation.missingTargets,
          })),
        },
      })
    }

    // The cached engine binary is re-downloaded on demand, so a broken copy is a
    // warning with a delete-and-retry fix rather than a failure.
    if (engineExists) {
      const engineExecutable =
        context.platform === 'win32' ||
        canAccess(cachedEngine, fs.constants.X_OK)
      if ((engineStat?.size ?? 0) === 0 || !engineExecutable) {
        return found({
          status: 'warn',
          message: `The cached engine binary at ${anonymizePath(cachedEngine, context.home, context.platform)} is unusable (${
            (engineStat?.size ?? 0) === 0 ? 'empty file' : 'not executable'
          }) — Freebuff will fail to launch until it is replaced.`,
          fix:
            context.platform === 'win32'
              ? `del "${cachedEngine}"`
              : `rm "${cachedEngine}"`,
          faqSlug: 'troubleshooting-official',
          data,
        })
      }
    }

    if (observations.length === 0) {
      return found({
        status: 'pass',
        message:
          'No installed Freebuff binary to inspect — nothing to verify on this machine.',
        data,
      })
    }

    const first = observations[0] as BinaryObservation
    return found({
      status: 'pass',
      message: `${first.path} is complete and runnable.`,
      details: [
        `Checked ${observations.length} command${observations.length === 1 ? '' : 's'} without executing them.`,
        ...(engineExists
          ? ['The cached engine binary is present and executable.']
          : []),
      ],
      data,
    })
  },
}
