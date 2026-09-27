import fs from 'node:fs'
import path from 'node:path'

import { canAccess, isDirectory, safeStat } from '../util/fs-scan.js'
import { anonymizePath } from '../util/platform.js'
import { found, type DiagnosticCheck } from './types.js'

interface Target {
  label: string
  path: string
  /** Directories that should exist inside a healthy state directory. */
  expects?: string[]
}

/** Confirms the Freebuff directories exist, look sane and are readable. */
export const installPathsCheck: DiagnosticCheck = {
  id: 'install-paths',
  title: 'Install and state directories',
  async run(context) {
    const { paths } = context
    const targets: Target[] = [
      { label: 'CLI state', path: paths.cliState, expects: ['projects'] },
      {
        label: 'Desktop state',
        path: paths.desktopState,
        expects: ['projects'],
      },
      { label: 'Legacy Codebuff state', path: paths.legacyState },
      ...paths.desktopInstalls.map((install) => ({
        label: 'Desktop app',
        path: install,
      })),
    ]

    const show = (value: string): string =>
      anonymizePath(value, context.home, context.platform)
    const existing = targets.filter((target) => isDirectory(target.path))
    const unreadable = existing.filter(
      (target) => !canAccess(target.path, fs.constants.R_OK),
    )

    const details = existing.map((target) => {
      const projects = target.expects
        ? safeStat(path.join(target.path, 'projects'))
        : null
      const suffix = projects?.isDirectory() ? ' (has projects/)' : ''
      return `${target.label}: ${show(target.path)}${suffix}`
    })

    // The cached CLI binary is worth reporting: deleting it fixes a lot of
    // one-off weirdness, and it is the first thing support asks about.
    const cachedBinary = path.join(paths.cliState, 'codebuff')
    if (safeStat(cachedBinary)) {
      details.push(`Cached engine binary present: ${show(cachedBinary)}`)
    }

    const data = {
      found: existing.map((target) => ({
        label: target.label,
        path: show(target.path),
      })),
      missing: targets
        .filter((target) => !isDirectory(target.path))
        .map((target) => ({ label: target.label, path: show(target.path) })),
      unreadable: unreadable.map((target) => show(target.path)),
    }

    if (unreadable.length > 0) {
      const first = unreadable[0]
      return found({
        status: 'fail',
        message: `${unreadable.length} Freebuff director${unreadable.length === 1 ? 'y is' : 'ies are'} not readable by your user account.`,
        details,
        fix:
          context.platform === 'win32'
            ? `takeown /F "${first?.path ?? ''}" /R /D Y`
            : `sudo chown -R $(whoami) "${first?.path ?? ''}"`,
        faqSlug: 'troubleshooting-official',
        data,
      })
    }

    if (existing.length === 0) {
      return found({
        status: 'warn',
        message:
          'No Freebuff or Codebuff directories were found on this machine.',
        details: [
          `Looked in ${show(paths.configRoot)} and the usual desktop install locations.`,
          'This is expected if you have never run the desktop app or CLI here.',
        ],
        fix: 'Run Freebuff once, then re-run `fbdoc check`',
        faqSlug: 'installation-paths',
        data,
      })
    }

    const stateDirs = existing.filter((target) =>
      target.label.endsWith('state'),
    )
    const missingProjects = stateDirs.filter(
      (target) =>
        target.expects &&
        !isDirectory(path.join(target.path, ...target.expects)),
    )
    if (
      missingProjects.length > 0 &&
      stateDirs.length === missingProjects.length
    ) {
      return found({
        status: 'warn',
        message:
          'Freebuff is set up here but has no projects/ folder yet, so no local sessions exist.',
        details,
        fix: 'Open or create a project in Freebuff, then re-run `fbdoc check`',
        faqSlug: 'installation-paths',
        data,
      })
    }

    return found({
      status: 'pass',
      message: `Found ${existing.length} Freebuff director${existing.length === 1 ? 'y' : 'ies'} and they are readable.`,
      details,
      data,
    })
  },
}
