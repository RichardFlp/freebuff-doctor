import fs from 'node:fs'

import { exec } from '../util/exec.js'
import {
  found,
  type CheckContext,
  type DiagnosticCheck,
  type ResultInit,
} from './types.js'

/** Below this, editing a large repository starts losing file-change events. */
export const MIN_WATCHES = 65_536
/** Too few watch instances breaks editors that open one per workspace. */
export const MIN_INSTANCES = 128
/** macOS per-process file limit that tools like the engine inherit. */
export const MIN_MAXFILES = 8_192
export const MIN_MAXFILES_PER_PROC = 4_096

const PROC_WATCHES = '/proc/sys/fs/inotify/max_user_watches'
const PROC_INSTANCES = '/proc/sys/fs/inotify/max_user_instances'

export interface WatcherObservation {
  platform: NodeJS.Platform
  /** Linux inotify limits. */
  maxUserWatches: number | null
  maxUserInstances: number | null
  /** macOS `kern.maxfiles` and `kern.maxfilesperproc`. */
  maxFiles: number | null
  maxFilesPerProc: number | null
}

function fix(
  platform: NodeJS.Platform,
  setting: string,
  value: number,
): string {
  if (platform === 'darwin') return `sudo sysctl -w ${setting}=${value}`
  return `sudo sysctl -w ${setting}=${value} && echo "${setting}=${value}" | sudo tee -a /etc/sysctl.conf`
}

/**
 * Pure verdict for the OS file-watching limits. When these are too low, file
 * watching quietly stops noticing changes on a large repository — the app looks
 * broken rather than limited, and nothing in its own logs says why.
 */
export function classifyWatcherLimits(
  observation: WatcherObservation,
): ResultInit {
  const {
    platform,
    maxUserWatches,
    maxUserInstances,
    maxFiles,
    maxFilesPerProc,
  } = observation

  if (platform === 'win32') {
    return {
      status: 'pass',
      message:
        'Windows has no per-user file-watch limit to tune, so there is nothing to check here.',
      data: { platform },
    }
  }

  const data = {
    platform,
    maxUserWatches,
    maxUserInstances,
    maxFiles,
    maxFilesPerProc,
  }

  if (platform === 'linux') {
    if (maxUserWatches === null) {
      return {
        status: 'skip',
        message: `${PROC_WATCHES} could not be read, so the file-watch limit is unknown.`,
        data,
      }
    }

    if (maxUserWatches < MIN_WATCHES) {
      const lowInstances =
        maxUserInstances !== null && maxUserInstances < MIN_INSTANCES
      return {
        status: 'warn',
        message: `Linux only allows ${maxUserWatches.toLocaleString()} watched files per user, so large projects can silently stop noticing edits.`,
        details: [
          `Threshold used here: ${MIN_WATCHES.toLocaleString()} watched files.`,
          ...(lowInstances
            ? [
                `Only ${maxUserInstances} watch instances are allowed, which some editors exhaust on their own.`,
              ]
            : []),
          'Raising the limit takes effect immediately and survives until the next reboot unless it is written to /etc/sysctl.conf.',
        ],
        fix: fix(platform, 'fs.inotify.max_user_watches', MIN_WATCHES * 4),
        faqSlug: 'working-with-large-codebases',
        data,
      }
    }

    return {
      status: 'pass',
      message: `Linux allows ${maxUserWatches.toLocaleString()} watched files per user, which is comfortable for large projects.`,
      details:
        maxUserInstances !== null
          ? [`Watch instances allowed: ${maxUserInstances}.`]
          : [],
      data,
    }
  }

  if (platform === 'darwin') {
    if (maxFiles === null && maxFilesPerProc === null) {
      return {
        status: 'skip',
        message:
          'The macOS file limits could not be read, so nothing was compared.',
        data,
      }
    }

    const low =
      (maxFiles !== null && maxFiles < MIN_MAXFILES) ||
      (maxFilesPerProc !== null && maxFilesPerProc < MIN_MAXFILES_PER_PROC)

    if (low) {
      return {
        status: 'warn',
        message: `macOS caps open files low (maxfiles ${maxFiles ?? 'unknown'}, per process ${maxFilesPerProc ?? 'unknown'}), which makes watching a large repository unreliable.`,
        details: [
          `Thresholds used here: ${MIN_MAXFILES.toLocaleString()} total and ${MIN_MAXFILES_PER_PROC.toLocaleString()} per process.`,
          'The usual remedy is a sysctl launchd job so the value survives a reboot.',
        ],
        fix: fix(platform, 'kern.maxfiles', MIN_MAXFILES * 8),
        faqSlug: 'working-with-large-codebases',
        data,
      }
    }

    return {
      status: 'pass',
      message: 'macOS file limits are high enough to watch a large repository.',
      details: [
        `maxfiles: ${maxFiles?.toLocaleString() ?? 'unknown'} · per process: ${maxFilesPerProc?.toLocaleString() ?? 'unknown'}`,
      ],
      data,
    }
  }

  return {
    status: 'skip',
    message: `No file-watch limit is defined for ${platform}, so nothing was checked.`,
    data,
  }
}

function readNumber(file: string): number | null {
  try {
    const value = Number.parseInt(fs.readFileSync(file, 'utf8').trim(), 10)
    return Number.isFinite(value) ? value : null
  } catch {
    return null
  }
}

async function readSysctl(
  key: string,
  timeoutMs: number,
): Promise<number | null> {
  const result = await exec('sysctl', ['-n', key], { timeoutMs })
  if (!result.ok) return null
  const value = Number.parseInt(result.stdout.trim(), 10)
  return Number.isFinite(value) ? value : null
}

/** Reads the OS file-watching limits that decide whether big repos work. */
export const watcherLimitsCheck: DiagnosticCheck = {
  id: 'watcher-limits',
  title: 'File-watching limits',
  async run(context: CheckContext) {
    const timeoutMs = Math.min(Math.max(context.timeoutMs, 2000), 6000)

    if (context.platform === 'linux') {
      return found(
        classifyWatcherLimits({
          platform: context.platform,
          maxUserWatches: readNumber(PROC_WATCHES),
          maxUserInstances: readNumber(PROC_INSTANCES),
          maxFiles: null,
          maxFilesPerProc: null,
        }),
      )
    }

    if (context.platform === 'darwin') {
      const [maxFiles, maxFilesPerProc] = await Promise.all([
        readSysctl('kern.maxfiles', timeoutMs),
        readSysctl('kern.maxfilesperproc', timeoutMs),
      ])
      return found(
        classifyWatcherLimits({
          platform: context.platform,
          maxUserWatches: null,
          maxUserInstances: null,
          maxFiles,
          maxFilesPerProc,
        }),
      )
    }

    return found(
      classifyWatcherLimits({
        platform: context.platform,
        maxUserWatches: null,
        maxUserInstances: null,
        maxFiles: null,
        maxFilesPerProc: null,
      }),
    )
  },
}
