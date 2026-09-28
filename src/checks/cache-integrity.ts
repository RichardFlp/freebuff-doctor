import path from 'node:path'

import { formatBytes, listDir, safeStat } from '../util/fs-scan.js'
import { anonymizePath } from '../util/platform.js'
import {
  found,
  type CheckContext,
  type DiagnosticCheck,
  type ResultInit,
} from './types.js'

/** The cached engine executable, under every name Freebuff has shipped. */
export const ENGINE_FILE = /^(freebuff|codebuff)(\.exe)?$/i

/** Copies an update left behind: `freebuff.exe.old.1785516577696`, `.bak`, … */
export const STALE_ENGINE = /\.(old|bak|backup|prev)(\.\d+)?$/i

/** Artefacts of a download that never finished. */
export const PARTIAL_DOWNLOAD = /\.(part|partial|download|crdownload|tmp|!ut)$/i

export type CacheArtifactKind = 'stale-engine' | 'partial-download'

export interface CacheArtifact {
  kind: CacheArtifactKind
  /** Absolute path, used to build the cleanup command. */
  path: string
  /** Anonymized path, for messages. */
  display: string
  bytes: number
  /** Milliseconds since the file was last written. */
  ageMs: number
}

export interface CacheFacts {
  platform: NodeJS.Platform
  /** Directories that were searched. */
  scanned: string[]
  artifacts: CacheArtifact[]
  /** True when a live engine binary was found. */
  enginePresent: boolean
}

function deleteFix(platform: NodeJS.Platform, target: string): string {
  return platform === 'win32' ? `del "${target}"` : `rm "${target}"`
}

/**
 * Pure verdict for cached download artefacts.
 *
 * `binary-integrity` covers a single broken engine file; this check covers the
 * debris around it — half-written downloads and the previous engine copies an
 * interrupted update leaves on disk, which together can reclaim hundreds of
 * megabytes and confuse the next update.
 */
export function classifyCache(facts: CacheFacts): ResultInit {
  const { platform, artifacts, enginePresent, scanned } = facts

  const partials = artifacts.filter(
    (entry) => entry.kind === 'partial-download',
  )
  const stale = artifacts.filter((entry) => entry.kind === 'stale-engine')
  const staleBytes = stale.reduce((total, entry) => total + entry.bytes, 0)

  if (artifacts.length === 0) {
    return {
      status: 'pass',
      message: enginePresent
        ? 'The cached engine is intact, with no interrupted downloads or leftover copies.'
        : 'No cached engine or download artefacts yet — the engine is fetched on first run.',
      data: {
        scanned,
        enginePresent,
        staleCopies: 0,
        partials: 0,
      },
    }
  }

  const data = {
    scanned,
    enginePresent,
    staleCopies: stale.length,
    staleBytes,
    partials: partials.map((entry) => entry.display),
    artifacts: artifacts.map((entry) => ({
      kind: entry.kind,
      path: entry.display,
      bytes: entry.bytes,
    })),
  }

  const details = [
    ...partials.map(
      (entry) =>
        `Interrupted download: ${entry.display} (${formatBytes(entry.bytes)}, ${Math.max(1, Math.round(entry.ageMs / 3_600_000))}h old)`,
    ),
    ...stale
      .sort((a, b) => b.bytes - a.bytes)
      .map(
        (entry) =>
          `Superseded engine copy: ${entry.display} (${formatBytes(entry.bytes)})`,
      ),
  ]

  if (partials.length > 0) {
    const first = partials[0] as CacheArtifact
    return {
      status: 'warn',
      message: `${partials.length} interrupted download${partials.length === 1 ? '' : 's'} are sitting in the Freebuff state directory, which makes the next update re-download and can leave a broken engine behind.`,
      details: [
        ...details,
        'Deleting the partial file is safe: Freebuff downloads a fresh copy when it next needs one.',
      ],
      fix: deleteFix(platform, first.path),
      faqSlug: 'crash-on-start--updating',
      data,
    }
  }

  const biggest = [...stale].sort((a, b) => b.bytes - a.bytes)[0]
  return {
    status: 'warn',
    message: `An earlier version of the engine is still cached (${formatBytes(staleBytes)} across ${stale.length} cop${stale.length === 1 ? 'y' : 'ies'}) — disk space an interrupted update never reclaimed.`,
    details: [
      ...details,
      'The superseded copies are not read by anything; removing them only frees space.',
    ],
    ...(biggest
      ? {
          fix:
            platform === 'win32'
              ? `del "${path.join(path.dirname(biggest.path), '*.old.*')}"`
              : `rm -f "${path.dirname(biggest.path)}"/*.old.*`,
        }
      : {}),
    faqSlug: 'crash-on-start--updating',
    data,
  }
}

/** Finds partial downloads and superseded engine copies in the state directories. */
export const cacheIntegrityCheck: DiagnosticCheck = {
  id: 'cache-integrity',
  title: 'Cached engine and downloads',
  async run(context: CheckContext) {
    const dirs = [
      context.paths.cliState,
      context.paths.desktopState,
      context.paths.legacyState,
    ]

    const artifacts: CacheArtifact[] = []
    const scanned: string[] = []
    let enginePresent = false
    const now = Date.now()

    for (const dir of dirs) {
      if (!safeStat(dir)?.isDirectory()) continue
      scanned.push(anonymizePath(dir, context.home, context.platform))

      for (const entry of listDir(dir)) {
        if (!entry.isFile() && !entry.isSymbolicLink()) continue
        const full = path.join(dir, entry.name)
        const stat = safeStat(full)
        const bytes = stat?.size ?? 0
        const ageMs = stat ? Math.max(0, now - stat.mtimeMs) : 0

        if (ENGINE_FILE.test(entry.name)) {
          enginePresent = true
          continue
        }
        if (STALE_ENGINE.test(entry.name)) {
          artifacts.push({
            kind: 'stale-engine',
            path: full,
            display: anonymizePath(full, context.home, context.platform),
            bytes,
            ageMs,
          })
          continue
        }
        if (PARTIAL_DOWNLOAD.test(entry.name)) {
          artifacts.push({
            kind: 'partial-download',
            path: full,
            display: anonymizePath(full, context.home, context.platform),
            bytes,
            ageMs,
          })
        }
      }
    }

    return found(
      classifyCache({
        platform: context.platform,
        scanned,
        artifacts,
        enginePresent,
      }),
    )
  },
}
