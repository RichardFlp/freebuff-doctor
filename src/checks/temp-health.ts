import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { formatBytes, listDir, safeStat } from '../util/fs-scan.js'
import { readDiskUsage } from './storage.js'
import {
  found,
  type CheckContext,
  type DiagnosticCheck,
  type ResultInit,
} from './types.js'

/** Below this, downloads and installers start failing in confusing ways. */
export const FAIL_FREE_BYTES = 512 * 1024 ** 2
export const WARN_FREE_BYTES = 5 * 1024 ** 3
/** Files nobody has touched for this long are stale by definition. */
export const STALE_DAYS = 7
export const WARN_STALE_BYTES = 5 * 1024 ** 3
export const MAX_ENTRIES = 20_000

/** The variable that decides where temporary files go, in precedence order. */
export function tempDirectory(
  env: NodeJS.ProcessEnv,
  platform: NodeJS.Platform = process.platform,
): string {
  const configured =
    env.TMPDIR?.trim() || env.TEMP?.trim() || env.TMP?.trim() || ''
  return (
    configured || os.tmpdir() || (platform === 'win32' ? 'C:\\Temp' : '/tmp')
  )
}

export interface TempFacts {
  platform: NodeJS.Platform
  display: string
  exists: boolean
  writable: boolean
  freeBytes: number | null
  /** Entries counted, capped at MAX_ENTRIES. */
  entryCount: number
  staleCount: number
  staleBytes: number
  /** True when the count stopped at the cap. */
  capped: boolean
}

function clearFix(platform: NodeJS.Platform, dir: string): string {
  return platform === 'win32'
    ? `Remove-Item "${dir}\\*" -Recurse -Force -ErrorAction SilentlyContinue`
    : `rm -rf "${dir}"/*`
}

function resetFix(platform: NodeJS.Platform): string {
  return platform === 'win32'
    ? "[Environment]::SetEnvironmentVariable('TEMP', $null, 'User')"
    : 'unset TMPDIR'
}

/**
 * Pure verdict for the temp directory. A full or unwritable temp directory
 * breaks installs and updates with errors that never mention the real cause.
 */
export function classifyTemp(facts: TempFacts): ResultInit {
  const {
    platform,
    display,
    exists,
    writable,
    freeBytes,
    entryCount,
    staleCount,
    staleBytes,
    capped,
  } = facts

  const data = {
    path: display,
    exists,
    writable,
    freeBytes,
    entryCount,
    staleCount,
    staleBytes,
    capped,
  }

  if (!exists) {
    return {
      status: 'fail',
      message: `${display} does not exist, but it is set as the temporary directory, so installs and updates fail before they start.`,
      details: [
        'Either create the directory or clear the variable that points at it.',
      ],
      fix: resetFix(platform),
      faqSlug: 'troubleshooting-official',
      data,
    }
  }

  if (!writable) {
    return {
      status: 'fail',
      message: `Your account cannot write to ${display}, so anything that needs a temporary file will fail.`,
      fix:
        platform === 'win32'
          ? `icacls "${display}" /grant %USERNAME%:F`
          : `sudo chmod 1777 "${display}"`,
      faqSlug: 'troubleshooting-official',
      data,
    }
  }

  if (freeBytes !== null && freeBytes < FAIL_FREE_BYTES) {
    return {
      status: 'fail',
      message: `Only ${formatBytes(freeBytes)} of free space on the volume holding ${display}, which is not enough to unpack an update.`,
      details: [`Path: ${display}`],
      fix: clearFix(platform, display),
      faqSlug: 'crash-on-start--updating',
      data,
    }
  }

  if (freeBytes !== null && freeBytes < WARN_FREE_BYTES) {
    return {
      status: 'warn',
      message: `Low free space on the volume holding ${display} (${formatBytes(freeBytes)} free), which can interrupt a large update.`,
      details: [`Path: ${display}`],
      fix: clearFix(platform, display),
      faqSlug: 'crash-on-start--updating',
      data,
    }
  }

  if (staleBytes >= WARN_STALE_BYTES || entryCount >= MAX_ENTRIES) {
    return {
      status: 'warn',
      message: `${display} holds ${entryCount.toLocaleString()} entr${entryCount === 1 ? 'y' : 'ies'}${staleCount > 0 ? `, ${staleCount.toLocaleString()} of them untouched for over ${STALE_DAYS} days (${formatBytes(staleBytes)})` : ''}.`,
      details: [
        'A clogged temp directory makes file scans and installs slower, and can exhaust the filesystem.',
        ...(capped
          ? [`The count stopped at ${MAX_ENTRIES.toLocaleString()} entries.`]
          : []),
        'Nothing in a temp directory is meant to survive a reboot.',
      ],
      fix: clearFix(platform, display),
      faqSlug: 'troubleshooting-official',
      data,
    }
  }

  return {
    status: 'pass',
    message: `Temporary directory is writable${freeBytes !== null ? ` with ${formatBytes(freeBytes)} free` : ''}.`,
    details: [
      `Path: ${display}`,
      `${entryCount.toLocaleString()} entr${entryCount === 1 ? 'y' : 'ies'}${staleCount > 0 ? `, ${formatBytes(staleBytes)} of it stale` : ''}.`,
    ],
    data,
  }
}

/** Checks that the temp directory usable — a quiet cause of failed installs. */
export const tempHealthCheck: DiagnosticCheck = {
  id: 'temp-health',
  title: 'Temporary directory',
  async run(context: CheckContext) {
    const target = tempDirectory(context.env, context.platform)
    const stat = safeStat(target)
    const display = target

    if (!stat?.isDirectory()) {
      return found(
        classifyTemp({
          platform: context.platform,
          display,
          exists: stat?.isDirectory() ?? false,
          writable: false,
          freeBytes: null,
          entryCount: 0,
          staleCount: 0,
          staleBytes: 0,
          capped: false,
        }),
      )
    }

    let writable = true
    try {
      fs.accessSync(target, fs.constants.W_OK)
    } catch {
      writable = false
    }

    const usage = readDiskUsage(target)
    const cutoff = Date.now() - STALE_DAYS * 86_400_000

    let entryCount = 0
    let staleCount = 0
    let staleBytes = 0
    let capped = false

    // Shallow scan: a temp directory's own files are what accumulate. The
    // count is capped so a pathological directory cannot stall the doctor.
    for (const entry of listDir(target)) {
      entryCount += 1
      if (entryCount >= MAX_ENTRIES) {
        capped = true
        break
      }
      if (!entry.isFile()) continue
      const fileStat = safeStat(path.join(target, entry.name))
      if (!fileStat || fileStat.mtimeMs > cutoff) continue
      staleCount += 1
      staleBytes += fileStat.size
    }

    return found(
      classifyTemp({
        platform: context.platform,
        display,
        exists: true,
        writable,
        freeBytes: usage?.freeBytes ?? null,
        entryCount,
        staleCount,
        staleBytes,
        capped,
      }),
    )
  },
}
