import path from 'node:path'

import { formatBytes, listDir, safeStat, walkFiles } from '../util/fs-scan.js'
import { anonymizePath } from '../util/platform.js'
import {
  found,
  type CheckContext,
  type DiagnosticCheck,
  type ResultInit,
} from './types.js'

/** A single log or database this large is runaway growth, not history. */
export const LARGE_FILE_BYTES = 500 * 1024 ** 2
/** One project holding this much local session data is worth pruning. */
export const LARGE_PROJECT_BYTES = 2 * 1024 ** 3
/** Total local session data past this is worth a warning on its own. */
export const TOTAL_WARN_BYTES = 5 * 1024 ** 3

/** Session data lives in these file types; everything else is not ours to weigh. */
const GROWABLE = /\.(jsonl|jsonl\.gz|db|sqlite|sqlite3|log)$/i
const MAX_PROJECTS = 40
const MAX_FILES = 20_000

export interface ProjectFootprint {
  name: string
  /** Real path, used to build the archive command. */
  path: string
  bytes: number
  files: number
}

export interface GrowthObservation {
  platform: NodeJS.Platform
  totalBytes: number
  projects: ProjectFootprint[]
  largestFile: { path: string; display: string; bytes: number } | null
}

/** Sums the growable files of one project without descending into its source. */
export function measureProject(projectDir: string): {
  bytes: number
  files: number
  largest: { path: string; bytes: number }
} {
  let bytes = 0
  let files = 0
  let largest: { path: string; bytes: number } | null = null

  for (const file of walkFiles(projectDir, {
    maxDepth: 3,
    maxEntries: MAX_FILES,
    directoryFilter: (name) => name !== 'node_modules' && name !== '.git',
    fileFilter: (name) => GROWABLE.test(name),
  })) {
    bytes += file.size
    files += 1
    if (!largest || file.size > largest.bytes) {
      largest = { path: file.path, bytes: file.size }
    }
  }

  return { bytes, files, largest: largest ?? { path: '', bytes: 0 } }
}

/**
 * Pure verdict for local data growth. This check never fails: a large history is
 * a housekeeping problem, and the point is to name the file that is eating the
 * volume rather than to alarm anyone.
 */
export function classifyGrowth(observation: GrowthObservation): ResultInit {
  const { totalBytes, projects, largestFile } = observation

  if (totalBytes === 0) {
    return {
      status: 'pass',
      message: 'No local session data to weigh yet.',
    }
  }

  const details: string[] = []
  const bySize = [...projects].sort((a, b) => b.bytes - a.bytes)
  for (const project of bySize.slice(0, 3)) {
    details.push(
      `${project.name}: ${formatBytes(project.bytes)} across ${project.files} file${project.files === 1 ? '' : 's'}`,
    )
  }
  if (largestFile && largestFile.bytes > 0) {
    details.push(
      `Largest single file: ${largestFile.display} (${formatBytes(largestFile.bytes)})`,
    )
  }

  const archiveFix = largestFile
    ? observation.platform === 'win32'
      ? `move "${largestFile.path}" "${largestFile.path}.old"`
      : `mv "${largestFile.path}" "${largestFile.path}.old"`
    : undefined

  if (largestFile && largestFile.bytes >= LARGE_FILE_BYTES) {
    return {
      status: 'warn',
      message: `${largestFile.display} has grown to ${formatBytes(largestFile.bytes)} — a single runaway log rather than useful history.`,
      details: [
        ...details,
        'Archiving or deleting it reclaims the space; older sessions stay in their own files.',
      ],
      ...(archiveFix ? { fix: archiveFix } : {}),
      faqSlug: 'session--context-recovery',
    }
  }

  const biggestProject = bySize[0]
  if (biggestProject && biggestProject.bytes >= LARGE_PROJECT_BYTES) {
    return {
      status: 'warn',
      message: `Project "${biggestProject.name}" holds ${formatBytes(biggestProject.bytes)} of local session data, which is a lot of volume to keep on disk.`,
      details: [
        ...details,
        'Export anything you still need, then prune the oldest chat logs.',
      ],
      faqSlug: 'session--context-recovery',
    }
  }

  if (totalBytes >= TOTAL_WARN_BYTES) {
    return {
      status: 'warn',
      message: `Local session data totals ${formatBytes(totalBytes)} across ${projects.length} project${projects.length === 1 ? '' : 's'}, which is worth pruning before it fills the volume.`,
      details: [
        ...details,
        'The storage check reports how much free space is left on the same volume.',
      ],
      faqSlug: 'session--context-recovery',
    }
  }

  return {
    status: 'pass',
    message: `Local session data totals ${formatBytes(totalBytes)} across ${projects.length} project${projects.length === 1 ? '' : 's'}.`,
    details: [
      ...details,
      'Nothing here is large enough to threaten the volume.',
    ],
  }
}

/** The `<state>/projects/*` directories that may hold session data. */
function projectDirs(stateDir: string): string[] {
  const projectsDir = path.join(stateDir, 'projects')
  if (!safeStat(projectsDir)?.isDirectory()) return []
  const dirs: string[] = []
  for (const entry of listDir(projectsDir)) {
    if (entry.isDirectory()) dirs.push(path.join(projectsDir, entry.name))
  }
  return dirs
}

/**
 * Measures how much local session history each project keeps. The storage check
 * reports the space left on the volume; this one reports what is using it.
 */
export const stateGrowthCheck: DiagnosticCheck = {
  id: 'state-growth',
  title: 'Local session data size',
  async run(context: CheckContext) {
    const stateDirs = [
      context.paths.cliState,
      context.paths.desktopState,
      context.paths.legacyState,
    ]

    const seen = new Set<string>()
    const projects: ProjectFootprint[] = []
    let totalBytes = 0
    let largestFile: GrowthObservation['largestFile'] = null
    let capped = false

    for (const stateDir of stateDirs) {
      for (const projectDir of projectDirs(stateDir)) {
        const name = path.basename(projectDir)
        if (seen.has(projectDir)) continue
        if (projects.length >= MAX_PROJECTS) {
          capped = true
          continue
        }
        seen.add(projectDir)

        const measured = measureProject(projectDir)
        if (measured.bytes === 0) continue
        totalBytes += measured.bytes
        projects.push({
          name,
          path: projectDir,
          bytes: measured.bytes,
          files: measured.files,
        })

        if (
          measured.largest.path &&
          (!largestFile || measured.largest.bytes > largestFile.bytes)
        ) {
          largestFile = {
            path: measured.largest.path,
            display: anonymizePath(
              measured.largest.path,
              context.home,
              context.platform,
            ),
            bytes: measured.largest.bytes,
          }
        }
      }
    }

    const verdict = classifyGrowth({
      platform: context.platform,
      totalBytes,
      projects,
      largestFile,
    })
    const details = capped
      ? [
          ...(verdict.details ?? []),
          `Only the largest ${MAX_PROJECTS} projects were measured, so the real total is higher.`,
        ]
      : verdict.details

    return found({
      ...verdict,
      ...(details ? { details } : {}),
      data: {
        capped,
        totalBytes,
        total: formatBytes(totalBytes),
        projects: projects
          .map((project) => ({
            name: project.name,
            bytes: project.bytes,
            files: project.files,
          }))
          .sort((a, b) => b.bytes - a.bytes),
        largestFile: largestFile
          ? { path: largestFile.display, bytes: largestFile.bytes }
          : null,
      },
    })
  },
}
