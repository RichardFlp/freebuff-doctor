import { exec, getGlobalPackages, whichAll } from '../util/exec.js'
import { anonymizePath } from '../util/platform.js'
import { fetchLatestVersion } from '../util/registry.js'
import { isOutdated } from '../util/semver.js'
import { found, type DiagnosticCheck } from './types.js'

/** Package names that provide the Freebuff/Codebuff command-line agent. */
const CLI_PACKAGES = ['freebuff', 'codebuff'] as const

interface InstallState {
  name: string
  npmVersion: string | null
  binPath: string | null
  reportedVersion: string | null
  latest: string | null
}

/** Checks whether the CLI is installed globally, and whether it is current. */
export const globalInstallCheck: DiagnosticCheck = {
  id: 'global-install',
  title: 'Freebuff CLI installation',
  async run(context) {
    const globals = await getGlobalPackages({
      timeoutMs: Math.min(Math.max(context.timeoutMs, 5000), 25_000),
    })

    const states: InstallState[] = []
    for (const name of CLI_PACKAGES) {
      const npmVersion = globals.packages.get(name) ?? null
      const binPath = whichAll(name, { platform: context.platform })[0] ?? null
      states.push({
        name,
        npmVersion,
        binPath,
        reportedVersion: null,
        latest: null,
      })
    }

    // When npm's global root has no record, ask the binary itself before
    // assuming the CLI is absent (bun and pnpm keep their own global roots).
    for (const state of states) {
      if (state.npmVersion || !state.binPath) continue
      const result = await exec(state.binPath, ['--version'], {
        timeoutMs: Math.min(Math.max(context.timeoutMs, 3000), 8000),
      })
      const reported = /(\d+\.\d+\.\d+[^\s]*)/.exec(result.stdout)?.[1]
      if (result.ok && reported) state.reportedVersion = reported
    }

    for (const state of states) {
      if (!state.npmVersion && !state.reportedVersion) continue
      // `--offline` must stay offline, so the registry lookup is skipped.
      if (context.offline) continue
      state.latest = await fetchLatestVersion(state.name, {
        timeoutMs: context.timeoutMs,
      })
    }

    const data = {
      npmRoot: globals.npmRoot
        ? anonymizePath(globals.npmRoot, context.home, context.platform)
        : null,
      installs: states.map((state) => ({
        name: state.name,
        version: state.npmVersion ?? state.reportedVersion,
        managedByNpm: Boolean(state.npmVersion),
        binPath: state.binPath
          ? anonymizePath(state.binPath, context.home, context.platform)
          : null,
        latest: state.latest,
      })),
    }

    const present = states.filter(
      (state) => state.npmVersion || state.reportedVersion,
    )
    if (present.length === 0) {
      const strayBins = states.filter((state) => state.binPath)
      return found({
        status: 'warn',
        message:
          'No global Freebuff or Codebuff CLI found — this is fine if you only use the desktop app.',
        details: strayBins.map(
          (state) =>
            `Found an executable named ${state.name} at ${anonymizePath(state.binPath ?? '', context.home, context.platform)} but no matching installed package.`,
        ),
        fix: 'npm install -g freebuff',
        faqSlug: 'quick-start',
        data,
      })
    }

    const primary =
      present.find((state) => state.name === 'freebuff') ?? present[0]
    if (!primary)
      return found({
        status: 'warn',
        message: 'Could not read the CLI install.',
        data,
      })

    const version = primary.npmVersion ?? primary.reportedVersion ?? 'unknown'
    const details: string[] = []

    if (!primary.npmVersion && primary.reportedVersion) {
      details.push(
        `${primary.name} is installed outside npm's global directory (bun/pnpm), so updates go through that tool.`,
      )
    }
    if (primary.binPath) {
      details.push(
        `Command: ${anonymizePath(primary.binPath, context.home, context.platform)}`,
      )
    }
    for (const other of present) {
      if (other.name !== primary.name)
        details.push(
          `Also installed: ${other.name} ${other.npmVersion ?? other.reportedVersion}`,
        )
    }

    // Installed but unrunnable is the FAQ's "command not found" case.
    if (!primary.binPath) {
      return found({
        status: 'fail',
        message: `${primary.name} ${version} is installed, but no \`${primary.name}\` command is on your PATH.`,
        details: [
          ...details,
          globals.npmRoot
            ? `npm's global bin directory (${anonymizePath(globals.npmRoot, context.home, context.platform)}) does not appear to be on PATH.`
            : "npm's global directory could not be located.",
        ],
        fix:
          context.platform === 'win32'
            ? 'Add %APPDATA%\\npm to your PATH, then restart the terminal'
            : "Add npm's global bin directory to PATH, then restart the terminal",
        faqSlug: 'troubleshooting-official',
        data,
      })
    }

    if (primary.latest && isOutdated(version, primary.latest)) {
      return found({
        status: 'warn',
        message: `${primary.name} ${version} is behind the latest release (${primary.latest}).`,
        details,
        fix: `npm i -g ${primary.name}@latest`,
        faqSlug: 'crash-on-start--updating',
        data,
      })
    }

    if (!primary.latest) {
      return found({
        status: 'pass',
        message: `${primary.name} ${version} is installed (the latest version could not be checked).`,
        details: [
          ...details,
          context.offline
            ? 'Version check skipped because --offline was requested.'
            : 'The npm registry did not answer, so an update may still be available.',
        ],
        data,
      })
    }

    return found({
      status: 'pass',
      message: `${primary.name} ${version} is installed and up to date.`,
      details,
      data,
    })
  },
}
