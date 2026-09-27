import fs from 'node:fs'

import { canAccess, exists, formatBytes, isDirectory } from '../util/fs-scan.js'
import { getGlobalPackages } from '../util/exec.js'
import { anonymizePath } from '../util/platform.js'
import { found, type DiagnosticCheck } from './types.js'

export const WARN_FREE_BYTES = 2 * 1024 ** 3
export const FAIL_FREE_BYTES = 512 * 1024 ** 2

export interface DiskUsage {
  freeBytes: number
  totalBytes: number
}

/** Reads free space for the volume holding `target`. Returns null if unavailable. */
export function readDiskUsage(target: string): DiskUsage | null {
  try {
    const stats = fs.statfsSync(target)
    return {
      freeBytes: Number(stats.bavail) * Number(stats.bsize),
      totalBytes: Number(stats.blocks) * Number(stats.bsize),
    }
  } catch {
    return null
  }
}

/** Checks that there is room to work and that Freebuff's directories are writable. */
export const storageCheck: DiagnosticCheck = {
  id: 'storage',
  title: 'Disk space and permissions',
  async run(context) {
    const show = (value: string): string =>
      anonymizePath(value, context.home, context.platform)

    const candidates = [
      context.paths.cliState,
      context.paths.desktopState,
      context.paths.configRoot,
    ]
    const target =
      candidates.find((candidate) => isDirectory(candidate)) ?? context.home
    const usage = readDiskUsage(target)
    const writable = canAccess(target, fs.constants.W_OK)

    const globals = await getGlobalPackages({
      timeoutMs: Math.min(Math.max(context.timeoutMs, 5000), 25_000),
    })
    const npmRoot = globals.npmRoot
    const npmRootWritable =
      npmRoot && exists(npmRoot) ? canAccess(npmRoot, fs.constants.W_OK) : null

    const data = {
      target: show(target),
      freeBytes: usage?.freeBytes ?? null,
      free: usage ? formatBytes(usage.freeBytes) : null,
      writable,
      npmRoot: npmRoot ? show(npmRoot) : null,
      npmRootWritable,
    }

    if (!writable) {
      return found({
        status: 'fail',
        message: `Your user account cannot write to ${show(target)} — Freebuff will fail to save sessions or updates.`,
        fix:
          context.platform === 'win32'
            ? `takeown /F "${target}" /R /D Y`
            : `sudo chown -R $(whoami) "${target}"`,
        faqSlug: 'troubleshooting-official',
        data,
      })
    }

    if (usage && usage.freeBytes < FAIL_FREE_BYTES) {
      return found({
        status: 'fail',
        message: `Only ${formatBytes(usage.freeBytes)} free on the volume holding ${show(target)} — Freebuff needs room to write sessions and caches.`,
        details: [`Total volume size: ${formatBytes(usage.totalBytes)}`],
        fix: 'Free up disk space, then re-run `fbdoc check`',
        faqSlug: 'session--context-recovery',
        data,
      })
    }

    if (usage && usage.freeBytes < WARN_FREE_BYTES) {
      return found({
        status: 'warn',
        message: `Low disk space: ${formatBytes(usage.freeBytes)} free on the volume holding ${show(target)}.`,
        details: [`Total volume size: ${formatBytes(usage.totalBytes)}`],
        fix: 'Free up disk space if you see write or update failures',
        faqSlug: 'session--context-recovery',
        data,
      })
    }

    if (npmRootWritable === false) {
      return found({
        status: 'warn',
        message: `${show(npmRoot ?? '')} is not writable, so installing or updating the CLI will fail with a permission error.`,
        details: [
          `Free space: ${usage ? formatBytes(usage.freeBytes) : 'unknown'} on the volume holding ${show(target)}.`,
        ],
        fix:
          context.platform === 'win32'
            ? `takeown /F "${npmRoot ?? ''}" /R /D Y`
            : `sudo chown -R $(whoami) "${npmRoot ?? ''}"`,
        faqSlug: 'troubleshooting-official',
        data,
      })
    }

    const details = [
      `Free space: ${usage ? formatBytes(usage.freeBytes) : 'unknown'} on the volume holding ${show(target)}.`,
    ]
    if (npmRoot)
      details.push(`npm global directory is writable: ${show(npmRoot)}`)

    return found({
      status: 'pass',
      message: `Disk space and permissions look healthy${usage ? ` (${formatBytes(usage.freeBytes)} free)` : ''}.`,
      details,
      data,
    })
  },
}
