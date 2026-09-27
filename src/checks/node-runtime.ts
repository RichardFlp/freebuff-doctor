import { exec, whichOne } from '../util/exec.js'
import { isLtsMajor, majorOf } from '../util/semver.js'
import { found, type DiagnosticCheck } from './types.js'

const MIN_SUPPORTED_MAJOR = 22

/** Verifies a usable Node runtime and npm, which every Freebuff install path needs. */
export const nodeRuntimeCheck: DiagnosticCheck = {
  id: 'node-runtime',
  title: 'Node.js and npm',
  async run(context) {
    const major = majorOf(context.nodeVersion)
    const npmPath = whichOne('npm', { platform: context.platform })

    let npmVersion: string | null = null
    let npmFailure: string | null = null
    if (npmPath) {
      const result = await exec(npmPath, ['--version'], {
        timeoutMs: Math.min(Math.max(context.timeoutMs, 5000), 20_000),
      })
      const reported = result.stdout.trim().split(/\r?\n/)[0]?.trim()
      if (result.ok && reported) npmVersion = reported
      else if (result.timedOut) npmFailure = 'it did not respond in time'
      else
        npmFailure =
          result.error ??
          (result.stderr.trim() || `it exited with code ${result.code}`)
    }

    const data = {
      nodeVersion: context.nodeVersion,
      nodePath: process.execPath,
      npmVersion,
      npmPath,
    }

    if (!npmPath) {
      return found({
        status: 'fail',
        message:
          'npm was not found on PATH — Freebuff installs and updates run through npm.',
        details: [
          `Node.js ${context.nodeVersion} is running from ${process.execPath}`,
        ],
        fix: 'Install Node.js 22 LTS or newer from https://nodejs.org/en/download',
        faqSlug: 'troubleshooting-official',
        data,
      })
    }

    if (!npmVersion) {
      return found({
        status: 'warn',
        message: `npm is present at ${npmPath} but could not report its version (${npmFailure ?? 'unknown reason'}).`,
        fix: 'npm --version',
        faqSlug: 'troubleshooting-official',
        data,
      })
    }

    if (major !== null && major < MIN_SUPPORTED_MAJOR) {
      return found({
        status: 'warn',
        message: `Node.js ${context.nodeVersion} is older than the current LTS line — Freebuff expects Node ${MIN_SUPPORTED_MAJOR} or newer.`,
        details: [`npm ${npmVersion} · Node at ${process.execPath}`],
        fix: 'Install Node.js 22 LTS or newer from https://nodejs.org/en/download',
        faqSlug: 'troubleshooting-official',
        data,
      })
    }

    if (major !== null && !isLtsMajor(major)) {
      return found({
        status: 'warn',
        message: `Node.js ${context.nodeVersion} is an odd-numbered release, so it never gets long-term support.`,
        details: [`npm ${npmVersion} · Node at ${process.execPath}`],
        fix: 'Switch to an even-numbered LTS release (22 or 24)',
        faqSlug: 'troubleshooting-official',
        data,
      })
    }

    return found({
      status: 'pass',
      message: `Node.js ${context.nodeVersion} with npm ${npmVersion}.`,
      details: [`Node at ${process.execPath}`],
      data,
    })
  },
}
