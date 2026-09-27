import fs from 'node:fs'
import path from 'node:path'

import { safeStat, walkFiles } from '../util/fs-scan.js'
import { anonymizePath } from '../util/platform.js'
import {
  found,
  type CheckContext,
  type DiagnosticCheck,
  type ResultInit,
} from './types.js'

/** Highest config schema version this build of the doctor understands. */
export const CURRENT_SCHEMA_VERSION = 1

/** Keys a settings/state file might use to declare its own format version. */
const SCHEMA_KEYS = [
  'schemaVersion',
  'schema_version',
  'configVersion',
  'stateVersion',
  'formatVersion',
] as const

/** Files left behind by an interrupted write, which often means a corrupt config. */
const LEFTOVER = /\.(tmp|temp|bak|corrupt|old|orig)$|~$/i
const CONFIG_FILE = /\.jsonc?$/i

/** Config files are small; anything larger is data, not settings. */
const MAX_CONFIG_BYTES = 2 * 1024 * 1024

export interface ConfigParseResult {
  ok: boolean
  value: unknown
}

/**
 * Removes `//` and block comments and trailing commas while respecting string
 * literals, so JSON-with-comments config files parse the way their authors meant.
 */
export function cleanJson(text: string): string {
  let out = ''
  let inString = false
  let quote = ''

  for (let index = 0; index < text.length; index += 1) {
    const char = text[index]
    const next = text[index + 1]

    if (inString) {
      out += char
      if (char === '\\') {
        out += next ?? ''
        index += 1
        continue
      }
      if (char === quote) inString = false
      continue
    }

    if (char === '"' || char === "'") {
      inString = true
      quote = char
      out += char
      continue
    }
    if (char === '/' && next === '/') {
      while (index < text.length && text[index] !== '\n') index += 1
      out += '\n'
      continue
    }
    if (char === '/' && next === '*') {
      index += 2
      while (
        index < text.length &&
        !(text[index] === '*' && text[index + 1] === '/')
      ) {
        index += 1
      }
      index += 1
      continue
    }
    if (char === ',') {
      let lookahead = index + 1
      while (lookahead < text.length && /\s/.test(text[lookahead] ?? '')) {
        lookahead += 1
      }
      const following = text[lookahead]
      if (following === '}' || following === ']') continue
    }
    out += char
  }

  return out
}

/** Parses strict JSON, then JSONC (comments and trailing commas) as a fallback. */
export function parseConfig(text: string): ConfigParseResult {
  const trimmed = text.trim()
  if (!trimmed) return { ok: false, value: null }
  try {
    return { ok: true, value: JSON.parse(trimmed) }
  } catch {
    /* fall through to the tolerant parser */
  }
  try {
    return { ok: true, value: JSON.parse(cleanJson(trimmed)) }
  } catch {
    return { ok: false, value: null }
  }
}

/** Reads the declared schema/format version out of a parsed config. */
export function schemaVersionOf(value: unknown): number | null {
  if (!value || typeof value !== 'object') return null
  const record = value as Record<string, unknown>
  for (const key of SCHEMA_KEYS) {
    const raw = record[key]
    if (typeof raw === 'number' && Number.isFinite(raw)) return raw
    if (typeof raw === 'string' && /^\d+(\.\d+)?$/.test(raw.trim())) {
      return Number(raw.trim())
    }
  }
  return null
}

/** `apiKey` → `api_key`, `api-key` → `api_key`. */
export function toSnakeCase(key: string): string {
  return key
    .replace(/([a-z0-9])([A-Z])/g, '$1_$2')
    .replace(/[-\s]+/g, '_')
    .toLowerCase()
}

/** `api_key` → `apiKey`, `api-key` → `apiKey`. */
export function toCamelCase(key: string): string {
  return key.replace(/[-_\s]+(.)?/g, (_match, char: string) =>
    char ? char.toUpperCase() : '',
  )
}

/**
 * Finds two spellings of the same setting living side by side, which almost
 * always means an older version wrote one of them while the app now reads the
 * other. Compares names only, never values.
 */
export function findRenamedKeyPairs(keys: string[]): Array<[string, string]> {
  const present = new Set(keys)
  const seen = new Set<string>()
  const pairs: Array<[string, string]> = []

  for (const key of keys) {
    for (const variant of [toCamelCase(key), toSnakeCase(key)]) {
      if (variant === key || !present.has(variant)) continue
      const ordered = [key, variant].sort()
      const signature = ordered.join(' ')
      if (seen.has(signature)) continue
      seen.add(signature)
      pairs.push(ordered as [string, string])
    }
  }

  return pairs
}

export type ConfigIssueKind =
  | 'malformed'
  | 'empty'
  | 'unreadable'
  | 'schema-newer'
  | 'renamed-keys'
  | 'leftover'

export interface ConfigIssue {
  kind: ConfigIssueKind
  /** Real path, used to build a runnable fix command. */
  path: string
  /** Anonymized path, used in messages and details. */
  display: string
  /** Extra context, e.g. the schema version that was found. */
  detail?: string
}

const FAILING_KINDS: ConfigIssueKind[] = [
  'malformed',
  'unreadable',
  'schema-newer',
]

/** One-line description of what is wrong with a file. */
export function describeIssue(issue: ConfigIssue): string {
  switch (issue.kind) {
    case 'malformed':
      return 'is not valid JSON'
    case 'empty':
      return 'is empty, which usually means a write was interrupted'
    case 'unreadable':
      return 'cannot be read by your user account'
    case 'schema-newer':
      return `was written by a newer Freebuff${issue.detail ? ` (${issue.detail})` : ''}`
    case 'renamed-keys':
      return `sets both spellings of the same setting${issue.detail ? ` (${issue.detail})` : ''}, so one of them is ignored`
    case 'leftover':
    default:
      return 'is left over from an interrupted write'
  }
}

function issueMessage(issue: ConfigIssue): string {
  switch (issue.kind) {
    case 'malformed':
      return `${issue.display} no longer parses, which is the usual cause of Freebuff hanging on start-up without an error.`
    case 'unreadable':
      return `${issue.display} exists but your user account cannot read it.`
    case 'schema-newer':
      return `${issue.display} was written by a newer version of Freebuff${issue.detail ? ` (${issue.detail})` : ''}, so this install may not understand it.`
    case 'empty':
      return `${issue.display} is empty — an interrupted write may have truncated it.`
    case 'renamed-keys':
      return `${issue.display} sets both spellings of the same setting${issue.detail ? ` (${issue.detail})` : ''}, so one of them is being ignored.`
    case 'leftover':
    default:
      return `${issue.display} is left over from an interrupted write.`
  }
}

/** A single command that clears the problem, when one exists. */
export function issueFix(
  issue: ConfigIssue,
  platform: NodeJS.Platform,
): string | undefined {
  const name = path.basename(issue.path)
  const moveAside =
    platform === 'win32'
      ? `ren "${issue.path}" "${name}.corrupt"`
      : `mv "${issue.path}" "${issue.path}.corrupt"`

  switch (issue.kind) {
    case 'malformed':
    case 'empty':
    case 'leftover':
      return moveAside
    case 'unreadable':
      return platform === 'win32'
        ? `takeown /F "${issue.path}"`
        : `sudo chown $(whoami) "${issue.path}"`
    case 'schema-newer':
      return 'npm i -g freebuff@latest'
    case 'renamed-keys':
      // Nothing to run: the file needs editing, so the FAQ reference is the fix.
      return undefined
    default:
      return undefined
  }
}

/** Turns collected issues into a single result, worst kind first. */
export function classifyConfigIssues(
  issues: ConfigIssue[],
  platform: NodeJS.Platform,
): ResultInit {
  if (issues.length === 0) {
    return {
      status: 'pass',
      message: 'Every settings and state file parsed cleanly.',
    }
  }

  const failing = issues.filter((issue) => FAILING_KINDS.includes(issue.kind))
  const primary = failing[0] ?? (issues[0] as ConfigIssue)
  const fix = issueFix(primary, platform)

  return {
    status: failing.length > 0 ? 'fail' : 'warn',
    message: issueMessage(primary),
    // The primary issue is already the message, so details list the rest.
    details: issues
      .filter((issue) => issue !== primary)
      .map((issue) => `${issue.display} ${describeIssue(issue)}`),
    ...(fix ? { fix } : {}),
    faqSlug: 'crash-on-start--updating',
  }
}

/** Collects the config-ish files worth validating from each state directory. */
export function collectConfigFiles(stateDirs: string[]): string[] {
  const files: string[] = []
  for (const dir of stateDirs) {
    for (const file of walkFiles(dir, {
      maxDepth: 1,
      maxEntries: 400,
      directoryFilter: (name) => name !== 'projects' && name !== 'chats',
      fileFilter: (name) => CONFIG_FILE.test(name) || LEFTOVER.test(name),
    })) {
      if (!files.includes(file.path)) files.push(file.path)
    }
  }
  return files
}

function inspectFile(
  file: string,
  platform: NodeJS.Platform,
  home: string,
): ConfigIssue | null {
  const name = path.basename(file)
  const display = anonymizePath(file, home, platform)
  const issue = (kind: ConfigIssueKind, detail?: string): ConfigIssue => ({
    kind,
    path: file,
    display,
    ...(detail ? { detail } : {}),
  })

  if (LEFTOVER.test(name)) return issue('leftover')
  if (!CONFIG_FILE.test(name)) return null

  const stat = safeStat(file)
  if (!stat) return null
  if (stat.size === 0) return issue('empty')
  if (stat.size > MAX_CONFIG_BYTES) return null

  let text: string
  try {
    text = fs.readFileSync(file, 'utf8')
  } catch {
    return issue('unreadable')
  }
  if (!text.trim()) return issue('empty')

  const parsed = parseConfig(text)
  if (!parsed.ok) return issue('malformed')
  if (!parsed.value || typeof parsed.value !== 'object') return null

  const version = schemaVersionOf(parsed.value)
  if (version !== null && version > CURRENT_SCHEMA_VERSION) {
    return issue(
      'schema-newer',
      `schema ${version}, this doctor knows ${CURRENT_SCHEMA_VERSION}`,
    )
  }

  const pairs = findRenamedKeyPairs(Object.keys(parsed.value))
  if (pairs.length > 0) {
    return issue(
      'renamed-keys',
      pairs.map(([a, b]) => `${a} + ${b}`).join(', '),
    )
  }

  return null
}

/**
 * Validates the settings and state files Freebuff reads at start-up. A file that
 * no longer parses is the classic silent start-up hang: the app never opens and
 * never says why.
 */
export const configHealthCheck: DiagnosticCheck = {
  id: 'config-health',
  title: 'Settings and state files',
  async run(context: CheckContext) {
    const stateDirs = [
      context.paths.cliState,
      context.paths.desktopState,
      context.paths.legacyState,
    ]
    const files = collectConfigFiles(stateDirs)
    const issues = files
      .map((file) => inspectFile(file, context.platform, context.home))
      .filter((issue): issue is ConfigIssue => issue !== null)

    const verdict = classifyConfigIssues(issues, context.platform)
    const data = {
      scanned: files.map((file) =>
        anonymizePath(file, context.home, context.platform),
      ),
      issues: issues.map((issue) => ({
        kind: issue.kind,
        path: issue.display,
        ...(issue.detail ? { detail: issue.detail } : {}),
      })),
    }

    if (files.length === 0) {
      return found({
        status: 'pass',
        message:
          'No settings or state files found yet — nothing to validate on this machine.',
        data,
      })
    }

    return found({
      ...verdict,
      ...(verdict.status === 'pass'
        ? {
            message: `All ${files.length} settings and state file${files.length === 1 ? '' : 's'} parsed cleanly.`,
          }
        : {}),
      data,
    })
  },
}
