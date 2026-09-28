import path from 'node:path'

import { collectSessionLogs } from './session-logs.js'
import {
  found,
  type CheckContext,
  type DiagnosticCheck,
  type ResultInit,
} from './types.js'

export type StateRole = 'cli' | 'desktop' | 'legacy'

export interface StateLocation {
  role: StateRole
  label: string
  /** Anonymized path, for messages. */
  display: string
  sessions: number
  newestMs: number
}

/**
 * Pure verdict for "where does my history actually live?".
 *
 * The CLI and the desktop app legitimately keep separate stores, so coexisting
 * `manicode` and `freebuff-desktop` directories are not a problem. Sessions
 * sitting in the old `codebuff` directory are: the current build no longer
 * reads them, which is why history can look like it vanished after a rename.
 */
export function classifySplitState(locations: StateLocation[]): ResultInit {
  const withSessions = locations.filter((entry) => entry.sessions > 0)
  const legacy = withSessions.filter((entry) => entry.role === 'legacy')

  const describe = (entry: StateLocation): string =>
    `${entry.label}: ${entry.sessions} session file${entry.sessions === 1 ? '' : 's'} at ${entry.display}`

  if (legacy.length > 0) {
    const stale = legacy[0] as StateLocation
    const live = withSessions.filter((entry) => entry.role !== 'legacy')
    return {
      status: 'warn',
      message: `Local history is split across ${withSessions.length} locations — ${stale.sessions} session file${stale.sessions === 1 ? '' : 's'} still sit in the old Codebuff directory.`,
      details: [
        ...withSessions.map(describe),
        ...(live.length > 0
          ? [
              `Freebuff reads ${live.map((entry) => entry.display).join(' and ')}, so anything in ${stale.display} will not appear in the app.`,
            ]
          : []),
        'Copy the old session files into the directory your current build reads if you still need them.',
      ],
      faqSlug: 'session--context-recovery',
      data: { locations: withSessions.map(describe) },
    }
  }

  if (withSessions.length === 0) {
    return {
      status: 'pass',
      message: 'No local sessions exist yet, so there is nothing to be split.',
      data: { locations: [] },
    }
  }

  if (withSessions.length === 1) {
    const only = withSessions[0] as StateLocation
    return {
      status: 'pass',
      message: `All local history is in one place (${only.label}, ${only.sessions} session file${only.sessions === 1 ? '' : 's'}).`,
      details: [describe(only)],
      data: { locations: withSessions.map(describe) },
    }
  }

  return {
    status: 'pass',
    message: `Local history lives in ${withSessions.length} separate stores, one per Freebuff surface.`,
    details: [
      ...withSessions.map(describe),
      'The CLI and the desktop app keep their own histories by design, so this is expected.',
    ],
    data: { locations: withSessions.map(describe) },
  }
}

/** Counts sessions per state root and reports any that were left behind. */
export const splitStateCheck: DiagnosticCheck = {
  id: 'split-state',
  title: 'Where local history lives',
  async run(context: CheckContext) {
    const { paths } = context
    const candidates: Array<{ role: StateRole; label: string; path: string }> =
      [
        { role: 'cli', label: 'CLI', path: paths.cliState },
        { role: 'desktop', label: 'Desktop app', path: paths.desktopState },
        { role: 'legacy', label: 'Legacy Codebuff', path: paths.legacyState },
      ]

    const logs = collectSessionLogs(candidates.map((entry) => entry.path))
    const all = [...logs.chatFiles, ...logs.desktopDbs]

    const locations: StateLocation[] = candidates.map((entry) => {
      // Match only this root's own files, not a sibling with a longer name.
      const prefix = `${entry.path.replace(/[\\/]+$/, '')}${path.sep}`
      const mine = all.filter((file) => file.path.startsWith(prefix))
      return {
        role: entry.role,
        label: entry.label,
        display: entry.path,
        sessions: mine.length,
        newestMs: mine.reduce(
          (latest, file) => (file.mtimeMs > latest ? file.mtimeMs : latest),
          0,
        ),
      }
    })

    return found(classifySplitState(locations))
  },
}
