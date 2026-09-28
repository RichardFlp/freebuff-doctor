import { c, GLYPH } from '../ui/theme.js'
import { writeErr } from '../ui/output.js'
import {
  exec,
  whichOne,
  type ExecOptions,
  type ExecResult,
} from '../util/exec.js'
import { anonymizePath } from '../util/platform.js'
import { fetchLatestVersion } from '../util/registry.js'
import { isOutdated } from '../util/semver.js'
import { PACKAGE_NAME, doctorVersion, packageRoot } from '../util/version.js'
import { readUpdateState, writeUpdateState, type UpdateState } from './state.js'

/** How long the version lookup may take before the menu stops waiting for it. */
export const UPDATE_TIMEOUT_MS = 5000

/** A global npm install can take a while on a cold cache. */
const INSTALL_TIMEOUT_MS = 180_000

export type UpdateStatus =
  /** Running the newest published version. */
  | 'current'
  /** A newer version is published. */
  | 'outdated'
  /** The registry could not be reached, so nothing is known. */
  | 'unknown'
  /** `--offline` was requested, so nothing was even tried. */
  | 'offline'
  /** An update was installed. */
  | 'updated'
  /** An update was attempted and failed. */
  | 'failed'

export type UpdateAction = 'none' | 'installed' | 'failed'

/** What the local git checkout looks like, when there is one. */
export interface CheckoutStatus {
  root: string
  /** Commits on origin/main that this checkout does not have. */
  behind: number
  /** True when the working tree has uncommitted changes. */
  dirty: boolean
}

export interface SelfUpdateDeps {
  fetchLatest: (
    name: string,
    options?: { timeoutMs?: number },
  ) => Promise<string | null>
  run: (
    command: string,
    args: string[],
    options?: ExecOptions,
  ) => Promise<ExecResult>
  which: (command: string) => string | null
  readState: () => UpdateState
  writeState: (state: UpdateState) => boolean
  now: () => Date
}

export const defaultDeps: SelfUpdateDeps = {
  fetchLatest: fetchLatestVersion,
  run: exec,
  which: (command) => whichOne(command),
  readState: () => readUpdateState(),
  writeState: (state) => writeUpdateState(state),
  now: () => new Date(),
}

export interface SelfUpdateOptions {
  /** Running version. Defaults to this package's own version. */
  current?: string
  /** Directory to inspect for a git checkout. Defaults to the package root. */
  root?: string
  /** `--offline`: never touch the network. */
  offline?: boolean
  /** `--verbose`: also report the case where nothing needs doing. */
  verbose?: boolean
  /** `--no-self-update`. */
  enabled?: boolean
  /** Overridden by tests. */
  deps?: Partial<SelfUpdateDeps>
}

export interface SelfUpdateReport {
  status: UpdateStatus
  action: UpdateAction
  current: string
  latest: string | null
  /** Lines to show the reader, in order. Empty means stay quiet. */
  lines: string[]
  /** The install command that was run, when one was. */
  command?: string
  /** Present only when the running copy sits inside a git checkout. */
  checkout: CheckoutStatus | null
}

const gitOptions = (cwd: string): ExecOptions => ({
  cwd,
  timeoutMs: UPDATE_TIMEOUT_MS,
})

/**
 * Compares the checkout this copy runs from with `origin/main`.
 *
 * Informational only — fbdoc updates itself through npm, so this never pulls,
 * fetches into the working tree or touches a single file. `git ls-remote` is
 * tried first because it is cheap; the fetch that can count commits only runs
 * when the two disagree.
 */
export async function inspectCheckout(
  root: string,
  deps: { run?: SelfUpdateDeps['run'] } = {},
): Promise<CheckoutStatus | null> {
  const run = deps.run ?? defaultDeps.run
  const inside = await run(
    'git',
    ['rev-parse', '--is-inside-work-tree'],
    gitOptions(root),
  )
  if (!inside.ok || inside.stdout.trim() !== 'true') return null

  const head = await run('git', ['rev-parse', 'HEAD'], gitOptions(root))
  if (!head.ok) return null

  // Purely local, and the reason this never disturbs anything: knowing whether
  // the tree is dirty is what decides whether we keep our hands off it.
  const dirt = await run('git', ['status', '--porcelain'], gitOptions(root))
  const dirty = dirt.ok && dirt.stdout.trim().length > 0

  const remote = await run(
    'git',
    ['ls-remote', 'origin', 'main'],
    gitOptions(root),
  )
  // No remote, no network, or a differently named branch: nothing to compare.
  if (!remote.ok) return null

  const remoteHead = remote.stdout.trim().split(/\s+/)[0] ?? ''
  if (remoteHead && remoteHead === head.stdout.trim()) {
    return { root, behind: 0, dirty }
  }

  // They differ, so pay for a fetch to find out in which direction.
  const fetched = await run(
    'git',
    ['fetch', '--quiet', 'origin', 'main'],
    gitOptions(root),
  )
  if (!fetched.ok) return null

  const behind = await run(
    'git',
    ['rev-list', '--count', 'HEAD..origin/main'],
    gitOptions(root),
  )

  return {
    root,
    behind: Number.parseInt(behind.stdout.trim(), 10) || 0,
    dirty,
  }
}

function checkoutLines(checkout: CheckoutStatus, home?: string): string[] {
  if (checkout.behind <= 0) return []
  const where = anonymizePath(checkout.root, home)
  const commits = `${checkout.behind} commit${checkout.behind === 1 ? '' : 's'}`
  if (checkout.dirty) {
    return [
      `This checkout (${where}) is ${commits} behind origin/main, and has uncommitted changes — leaving it alone.`,
    ]
  }
  return [
    `This checkout (${where}) is ${commits} behind origin/main.`,
    'fbdoc updates itself through npm, so run `git pull` when you want those changes.',
  ]
}

/**
 * Keeps the npm-installed fbdoc current: looks up the published version, and
 * installs it when this copy is behind. The git checkout is only ever reported
 * on, never modified.
 */
export async function runSelfUpdate(
  options: SelfUpdateOptions = {},
): Promise<SelfUpdateReport> {
  const deps: SelfUpdateDeps = { ...defaultDeps, ...options.deps }
  const current = options.current ?? doctorVersion()
  const report: SelfUpdateReport = {
    status: 'unknown',
    action: 'none',
    current,
    latest: null,
    lines: [],
    checkout: null,
  }

  if (options.enabled === false || options.offline) {
    report.status = 'offline'
    return report
  }

  const latest = await deps.fetchLatest(PACKAGE_NAME, {
    timeoutMs: UPDATE_TIMEOUT_MS,
  })
  report.latest = latest

  if (!latest) {
    if (options.verbose) {
      report.lines.push(
        'Could not check for updates: the npm registry did not answer.',
      )
    }
  } else if (!isOutdated(current, latest)) {
    report.status = 'current'
    if (options.verbose) {
      report.lines.push(`${PACKAGE_NAME} ${current} is up to date.`)
    }
  } else {
    report.status = 'outdated'
    const state = deps.readState()

    if (state.installedVersion === latest) {
      // Running an older copy (usually a git checkout) while npm already holds
      // the current release: say so instead of installing it again.
      report.lines.push(
        `${PACKAGE_NAME} ${latest} is already installed; this run is ${current}.`,
      )
    } else {
      report.lines.push(
        `${PACKAGE_NAME} ${latest} is available (you are on ${current}) — updating…`,
      )
      const npm = deps.which('npm')
      if (!npm) {
        report.status = 'failed'
        report.action = 'failed'
        report.lines.push(
          `${GLYPH.failure} Could not update: npm is not on your PATH.`,
          `${GLYPH.arrow} Install it yourself with \`npm i -g ${PACKAGE_NAME}@latest\`.`,
        )
      } else {
        const args = ['i', '-g', `${PACKAGE_NAME}@latest`]
        report.command = `${npm} ${args.join(' ')}`
        const result = await deps.run(npm, args, {
          timeoutMs: INSTALL_TIMEOUT_MS,
        })
        if (result.ok) {
          report.status = 'updated'
          report.action = 'installed'
          deps.writeState({
            installedVersion: latest,
            installedAt: deps.now().toISOString(),
          })
          report.lines.push(
            `${GLYPH.success} Updated to ${latest}. Restart fbdoc to use it.`,
          )
        } else {
          report.status = 'failed'
          report.action = 'failed'
          const reason =
            result.error ??
            result.stderr.trim().split('\n').slice(-1)[0]?.trim() ??
            `npm exited with code ${result.code ?? 'unknown'}`
          report.lines.push(
            `${GLYPH.failure} Could not update automatically: ${reason}`,
            `${GLYPH.arrow} Run \`npm i -g ${PACKAGE_NAME}@latest\` yourself, or re-run with --verbose to see why.`,
          )
        }
      }
    }
  }

  const checkout = await inspectCheckout(options.root ?? packageRoot(), deps)
  if (checkout) {
    report.checkout = checkout
    report.lines.push(...checkoutLines(checkout))
  }

  return report
}

/** Prints the report, dimmed, to stderr — it is news, not a result. */
export function printUpdateReport(report: SelfUpdateReport): void {
  if (report.lines.length === 0) return
  writeErr('')
  for (const line of report.lines) writeErr(`  ${c().dim(line)}`)
}
