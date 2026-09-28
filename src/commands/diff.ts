import fs from 'node:fs'
import path from 'node:path'

import type { CheckResult, CheckStatus } from '../checks/types.js'
import { heading, hint, write, writeErr } from '../ui/output.js'
import { c, GLYPH, STATUS_ICON } from '../ui/theme.js'

/** The subset of `fbdoc check --json` this command relies on. */
interface SavedReport {
  summary?: {
    total?: number
    pass?: number
    warn?: number
    fail?: number
    skip?: number
  }
  checks?: Array<Pick<CheckResult, 'id' | 'title' | 'status' | 'message'>>
}

export interface DiffCommandOptions {
  json: boolean
}

export type ChangeKind =
  'fixed' | 'regressed' | 'still-broken' | 'new-check' | 'resolved-away'

export interface CheckChange {
  id: string
  title: string
  kind: ChangeKind
  from: CheckStatus | null
  to: CheckStatus | null
  message: string
}

const PROBLEM: CheckStatus[] = ['fail', 'warn']

/** Classifies what happened to one check between two saved reports. */
export function classifyChange(
  before: Pick<CheckResult, 'id' | 'title' | 'status' | 'message'> | null,
  after: Pick<CheckResult, 'id' | 'title' | 'status' | 'message'> | null,
): CheckChange | null {
  if (before && after && before.status === after.status) {
    // Unchanged problems are still worth showing; unchanged passes are not.
    if (!PROBLEM.includes(after.status)) return null
    return {
      id: after.id,
      title: after.title,
      kind: 'still-broken',
      from: before.status,
      to: after.status,
      message: after.message,
    }
  }

  if (!before && after) {
    if (!PROBLEM.includes(after.status)) return null
    return {
      id: after.id,
      title: after.title,
      kind: 'new-check',
      from: null,
      to: after.status,
      message: after.message,
    }
  }

  if (before && !after) {
    if (!PROBLEM.includes(before.status)) return null
    return {
      id: before.id,
      title: before.title,
      kind: 'resolved-away',
      from: before.status,
      to: null,
      message: before.message,
    }
  }

  if (!before || !after) return null

  const wasProblem = PROBLEM.includes(before.status)
  const isProblem = PROBLEM.includes(after.status)

  // Both are problems but the severity moved: warn → fail is worse, and fail →
  // warn is an improvement even though the check still has something to say.
  if (wasProblem && isProblem) {
    const rank = (status: CheckStatus): number =>
      status === 'fail' ? 2 : status === 'warn' ? 1 : 0
    if (rank(after.status) > rank(before.status)) {
      return {
        id: after.id,
        title: after.title,
        kind: 'regressed',
        from: before.status,
        to: after.status,
        message: after.message,
      }
    }
    return {
      id: after.id,
      title: after.title,
      kind: 'fixed',
      from: before.status,
      to: after.status,
      message: after.message,
    }
  }

  if (wasProblem && !isProblem) {
    return {
      id: after.id,
      title: after.title,
      kind: 'fixed',
      from: before.status,
      to: after.status,
      message: after.message,
    }
  }
  if (!wasProblem && isProblem) {
    return {
      id: after.id,
      title: after.title,
      kind: 'regressed',
      from: before.status,
      to: after.status,
      message: after.message,
    }
  }

  return null
}

/** Compares two saved reports and returns every meaningful change. */
export function compareReports(
  before: SavedReport,
  after: SavedReport,
): CheckChange[] {
  const beforeById = new Map(
    (before.checks ?? []).map((check) => [check.id, check]),
  )
  const afterById = new Map(
    (after.checks ?? []).map((check) => [check.id, check]),
  )
  const ids = [...new Set([...beforeById.keys(), ...afterById.keys()])]

  const changes: CheckChange[] = []
  for (const id of ids) {
    const change = classifyChange(
      beforeById.get(id) ?? null,
      afterById.get(id) ?? null,
    )
    if (change) changes.push(change)
  }

  // Fixes first, then regressions, then everything still outstanding.
  const order: Record<ChangeKind, number> = {
    fixed: 0,
    regressed: 1,
    'new-check': 2,
    'still-broken': 3,
    'resolved-away': 4,
  }
  return changes.sort((a, b) => order[a.kind] - order[b.kind])
}

function readReport(file: string): SavedReport | string {
  const target = path.resolve(process.cwd(), file)
  let raw: string
  try {
    raw = fs.readFileSync(target, 'utf8')
  } catch {
    return `could not read ${target}`
  }
  try {
    const parsed = JSON.parse(raw) as SavedReport
    if (!Array.isArray(parsed.checks)) {
      return `${target} is not a \`fbdoc check --json\` report (no checks array)`
    }
    return parsed
  } catch (error) {
    return `${target} is not valid JSON: ${error instanceof Error ? error.message : String(error)}`
  }
}

const KIND_LABEL: Record<ChangeKind, string> = {
  fixed: 'fixed',
  regressed: 'new problem',
  'new-check': 'new check reporting a problem',
  'still-broken': 'still needs attention',
  'resolved-away': 'no longer reported',
}

/** `fbdoc diff <before.json> <after.json>` — did the fix actually work? */
export async function runDiffCommand(
  beforeFile: string,
  afterFile: string,
  options: DiffCommandOptions,
): Promise<number> {
  const before = readReport(beforeFile)
  const after = readReport(afterFile)

  if (typeof before === 'string' || typeof after === 'string') {
    const problem = typeof before === 'string' ? before : after
    writeErr(`${c().red(`${GLYPH.failure} ${problem}`)}`)
    hint('Save a report first with `fbdoc check --json > before.json`.')
    return 1
  }

  const changes = compareReports(before, after)
  const fixed = changes.filter((change) => change.kind === 'fixed')
  const regressed = changes.filter(
    (change) => change.kind === 'regressed' || change.kind === 'new-check',
  )
  const outstanding = changes.filter((change) => change.kind === 'still-broken')

  if (options.json) {
    write(
      JSON.stringify(
        {
          fixed: fixed.length,
          regressed: regressed.length,
          outstanding: outstanding.length,
          before: before.summary ?? null,
          after: after.summary ?? null,
          changes,
        },
        null,
        2,
      ),
    )
    return regressed.length > 0 ? 1 : 0
  }

  heading('What changed')
  write(
    c().dim(
      `${beforeFile} → ${afterFile}${after.summary ? ` · ${after.summary.fail ?? 0} failed, ${after.summary.warn ?? 0} warnings now` : ''}`,
    ),
  )
  write('')

  if (changes.length === 0) {
    write(
      `${c().green(GLYPH.success)} Nothing changed between the two reports.`,
    )
    write('')
    if ((after.summary?.fail ?? 0) === 0 && (after.summary?.warn ?? 0) === 0) {
      write(c().dim('Both runs are clean.'))
    }
    return 0
  }

  for (const change of changes) {
    const from = change.from ? STATUS_ICON[change.from] : '—'
    const to = change.to ? STATUS_ICON[change.to] : '—'
    write(
      `${c().bold(change.title)} ${c().dim(`(${change.id})`)} ${c().dim(`· ${KIND_LABEL[change.kind]}`)}`,
    )
    write(`   ${from} → ${to}  ${change.message}`)
    write('')
  }

  write(
    `${c().bold(String(fixed.length))} fixed · ${c().bold(String(regressed.length))} new · ${c().bold(String(outstanding.length))} still outstanding`,
  )
  write('')

  return regressed.length > 0 ? 1 : 0
}
