import fs from 'node:fs'
import path from 'node:path'

import { canAccess } from '../util/fs-scan.js'
import { classifyAddress } from './dns.js'
import {
  found,
  type CheckContext,
  type DiagnosticCheck,
  type ResultInit,
} from './types.js'

/** Hosts Freebuff depends on: a pinned entry for any of these breaks it. */
export const WATCHED_HOSTS = [
  'freebuff.com',
  'www.freebuff.com',
  'api.freebuff.com',
  'codebuff.com',
] as const

export interface HostsEntry {
  lineNumber: number
  address: string
  hosts: string[]
  /** The raw line, so the user can recognise it. */
  raw: string
}

export interface HostsFileFacts {
  platform: NodeJS.Platform
  /** Anonymized path, for messages. */
  display: string
  exists: boolean
  readable: boolean
  entries: HostsEntry[]
}

/**
 * Where the hosts file lives. Windows exposes it under `SystemRoot`, which is
 * not always `C:\Windows`, so the environment is honoured before the default.
 */
export function hostsFilePath(
  platform: NodeJS.Platform,
  env: NodeJS.ProcessEnv = process.env,
): string {
  if (platform === 'win32') {
    const root = env.SystemRoot?.trim() || 'C:\\Windows'
    return path.join(root, 'System32', 'drivers', 'etc', 'hosts')
  }
  return '/etc/hosts'
}

/**
 * Parses a hosts file, ignoring comments and blank lines. `#` starts a comment
 * anywhere on the line, exactly as the resolver treats it.
 */
export function parseHostsFile(content: string): HostsEntry[] {
  const entries: HostsEntry[] = []
  const lines = content.split(/\r?\n/)

  lines.forEach((raw, index) => {
    const withoutComment = (raw.split('#')[0] ?? '').trim()
    if (!withoutComment) return
    const parts = withoutComment.split(/\s+/).filter(Boolean)
    const address = parts[0]
    if (!address) return
    const hosts = parts.slice(1).map((host) => host.toLowerCase())
    if (hosts.length === 0) return
    entries.push({ lineNumber: index + 1, address, hosts, raw: raw.trim() })
  })

  return entries
}

/** Entries that pin one of the hosts Freebuff talks to. */
export function findPinnedHosts(
  entries: HostsEntry[],
  watched: readonly string[] = WATCHED_HOSTS,
): Array<HostsEntry & { matched: string[] }> {
  const wanted = new Set(watched.map((host) => host.toLowerCase()))
  const matches: Array<HostsEntry & { matched: string[] }> = []
  for (const entry of entries) {
    const matched = entry.hosts.filter((host) => wanted.has(host))
    if (matched.length > 0) matches.push({ ...entry, matched })
  }
  return matches
}

/**
 * Pure verdict for the hosts file. A leftover entry is a classic cause of
 * "nothing loads but ping works", and it survives reinstalls because nobody
 * thinks to look there.
 */
export function classifyHostsFile(facts: HostsFileFacts): ResultInit {
  const { platform, display, exists, readable, entries } = facts

  if (!exists) {
    return {
      status: 'pass',
      message: `No hosts file at ${display}, so nothing is overriding Freebuff's DNS.`,
    }
  }

  if (!readable) {
    return {
      status: 'skip',
      message: `${display} could not be read, so pinned Freebuff hosts could not be checked.`,
      details: [
        'Reading the hosts file needs no special rights on most systems.',
      ],
    }
  }

  const pinned = findPinnedHosts(entries)
  if (pinned.length === 0) {
    return {
      status: 'pass',
      message: 'No Freebuff host is pinned in your hosts file.',
      details: [
        `Checked ${entries.length} entr${entries.length === 1 ? 'y' : 'ies'} in ${display}.`,
      ],
    }
  }

  const lines = pinned.map(
    (entry) =>
      `Line ${entry.lineNumber}: ${entry.matched.join(', ')} → ${entry.address}`,
  )
  const blocked = pinned.filter((entry) =>
    ['loopback', 'private', 'link-local', 'reserved', 'invalid'].includes(
      classifyAddress(entry.address),
    ),
  )

  const removeFix =
    platform === 'win32'
      ? `(Get-Content "${display}") -notmatch 'freebuff' | Set-Content "${display}"`
      : "sudo sed -i.bak '/freebuff/d' /etc/hosts"

  if (blocked.length > 0) {
    return {
      status: 'fail',
      message: `Your hosts file sends ${blocked[0]?.matched.join(', ') ?? 'a Freebuff host'} to ${blocked[0]?.address ?? 'a local address'}, so the request never leaves this machine.`,
      details: [
        ...lines,
        'This is almost always a leftover from an old workaround or a blocking script.',
      ],
      fix: removeFix,
      faqSlug: 'network-issues',
      data: { path: display, pinned: lines },
    }
  }

  return {
    status: 'warn',
    message: `Your hosts file pins ${pinned.length} Freebuff host${pinned.length === 1 ? '' : 's'} to a fixed address, which breaks things when that address becomes stale.`,
    details: [
      ...lines,
      'A worked-around IP is the usual reason Freebuff connects on one network and not another.',
    ],
    fix: removeFix,
    faqSlug: 'network-issues',
    data: { path: display, pinned: lines },
  }
}

/** Looks for leftover hosts-file entries that redirect Freebuff's own domains. */
export const hostsPinCheck: DiagnosticCheck = {
  id: 'hosts-pin',
  title: 'Hosts file overrides',
  async run(context: CheckContext) {
    const target = hostsFilePath(context.platform, context.env)
    const display = target
    const stat = (() => {
      try {
        return fs.statSync(target)
      } catch {
        return null
      }
    })()

    if (!stat?.isFile()) {
      return found(
        classifyHostsFile({
          platform: context.platform,
          display,
          exists: false,
          readable: false,
          entries: [],
        }),
      )
    }

    let content = ''
    let readable = true
    try {
      content = fs.readFileSync(target, 'utf8')
    } catch {
      readable = false
    }

    return found(
      classifyHostsFile({
        platform: context.platform,
        display,
        exists: true,
        readable: readable && canAccess(target, fs.constants.R_OK),
        entries: readable ? parseHostsFile(content) : [],
      }),
    )
  },
}
