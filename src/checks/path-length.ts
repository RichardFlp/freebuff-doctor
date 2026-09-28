import { walkFiles } from '../util/fs-scan.js'
import { anonymizePath } from '../util/platform.js'
import {
  found,
  type CheckContext,
  type DiagnosticCheck,
  type ResultInit,
} from './types.js'

/** Windows refuses paths at or past this length unless long paths are enabled. */
export const FAIL_PATH_LENGTH = 260
/** Close enough that one nested folder will push it over. */
export const WARN_PATH_LENGTH = 200

const MAX_FILES = 6000

export interface PathLengthFacts {
  platform: NodeJS.Platform
  /** How many files were measured. */
  scanned: number
  longest: { display: string; length: number } | null
  /** Displayed paths at or past the failure threshold. */
  overFail: string[]
  /** Displayed paths between the warning and failure thresholds. */
  overWarn: string[]
  /** True when the walk stopped at its own cap. */
  capped: boolean
}

const LONGPATHS_FIX = 'git config --global core.longpaths true'

/**
 * Pure verdict for path lengths.
 *
 * `git-prereqs` reports whether `core.longpaths` is *configured*; this check
 * reports whether it *matters*, by measuring the paths that actually exist on
 * disk. Only Windows enforces the 260-character limit, so elsewhere the check
 * simply says so.
 */
export function classifyPathLength(facts: PathLengthFacts): ResultInit {
  const { platform, scanned, longest, overFail, overWarn, capped } = facts

  if (platform !== 'win32') {
    return {
      status: 'pass',
      message: `${platform} does not impose a 260-character path limit, so long paths are not a concern.`,
      details:
        scanned > 0
          ? [
              `Longest path checked: ${longest?.length ?? 0} characters (${longest?.display ?? 'n/a'}).`,
            ]
          : [],
      data: { scanned, longestLength: longest?.length ?? 0 },
    }
  }

  const data = {
    scanned,
    capped,
    longest: longest?.display ?? null,
    longestLength: longest?.length ?? 0,
    overFail: overFail.length,
    overWarn: overWarn.length,
  }

  if (overFail.length > 0) {
    return {
      status: 'fail',
      message: `${overFail.length} path${overFail.length === 1 ? '' : 's'} in your Freebuff directories reach Windows' 260-character limit, so they cannot be read or written at all.`,
      details: [
        `Longest: ${longest?.length ?? 0} characters — ${longest?.display ?? ''}`,
        ...overFail.slice(0, 3).map((entry) => `Over the limit: ${entry}`),
        'Long paths must be enabled in Windows itself as well as in Git; the policy below needs an administrator.',
      ],
      fix: LONGPATHS_FIX,
      faqSlug: 'troubleshooting-official',
      data,
    }
  }

  if (overWarn.length > 0) {
    return {
      status: 'warn',
      message: `${overWarn.length} path${overWarn.length === 1 ? '' : 's'} are within 60 characters of Windows' 260-character limit, so deep project folders may break them.`,
      details: [
        `Longest: ${longest?.length ?? 0} characters — ${longest?.display ?? ''}`,
        ...overWarn
          .slice(0, 3)
          .map((entry) => `Approaching the limit: ${entry}`),
        'Enabling long paths now avoids a confusing failure later.',
      ],
      fix: LONGPATHS_FIX,
      faqSlug: 'troubleshooting-official',
      data,
    }
  }

  return {
    status: 'pass',
    message: `No path exceeds ${WARN_PATH_LENGTH} characters (longest is ${longest?.length ?? 0}).`,
    details: [
      `Measured ${scanned.toLocaleString()} file${scanned === 1 ? '' : 's'} in the Freebuff directories.`,
      ...(capped
        ? [`The search stopped after ${MAX_FILES.toLocaleString()} files.`]
        : []),
    ],
    data,
  }
}

/** Measures the Freebuff directories for paths that Windows cannot handle. */
export const pathLengthCheck: DiagnosticCheck = {
  id: 'path-length',
  title: 'Path length limits',
  async run(context: CheckContext) {
    const roots = [
      context.paths.cliState,
      context.paths.desktopState,
      context.paths.legacyState,
      ...context.paths.desktopInstalls,
    ]

    const files = roots.flatMap((root) =>
      walkFiles(root, { maxDepth: 6, maxEntries: MAX_FILES }),
    )

    const overFail: string[] = []
    const overWarn: string[] = []
    let longest: PathLengthFacts['longest'] = null

    for (const file of files) {
      const length = file.path.length
      const display = anonymizePath(file.path, context.home, context.platform)
      if (!longest || length > longest.length) longest = { display, length }
      if (length >= FAIL_PATH_LENGTH) overFail.push(display)
      else if (length >= WARN_PATH_LENGTH) overWarn.push(display)
    }

    overFail.sort((a, b) => b.length - a.length)
    overWarn.sort((a, b) => b.length - a.length)

    return found(
      classifyPathLength({
        platform: context.platform,
        scanned: files.length,
        longest,
        overFail,
        overWarn,
        capped: files.length >= MAX_FILES,
      }),
    )
  },
}
