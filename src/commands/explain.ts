import {
  CATEGORY_LABEL,
  checkDoc,
  type CheckCategory,
} from '../checks/catalog.js'
import { checksByCategory, findCheck } from '../checks/index.js'
import { faqReference } from '../faq/reference.js'
import { heading, hint, write, writeErr } from '../ui/output.js'
import { c, GLYPH } from '../ui/theme.js'
import { padTo } from '../util/width.js'

export interface ExplainCommandOptions {
  json: boolean
}

interface ExplainPayload {
  id: string
  title: string
  category: CheckCategory | null
  summary: string | null
  looks: string[]
  why: string | null
  network: boolean
  fixHint: string
  faq: { slug: string; title: string; command: string } | null
}

function payloadFor(id: string): ExplainPayload | null {
  const check = findCheck(id)
  if (!check) return null
  const doc = checkDoc(check.id)
  const reference = doc?.faqSlug ? faqReference(doc.faqSlug) : null

  return {
    id: check.id,
    title: check.title,
    category: doc?.category ?? null,
    summary: doc?.summary ?? null,
    looks: doc?.looks ?? [],
    why: doc?.why ?? null,
    network: doc?.network ?? false,
    fixHint: `fbdoc check --only ${check.id}`,
    faq: reference
      ? {
          slug: reference.slug,
          title: reference.title,
          command: reference.command,
        }
      : null,
  }
}

/** Lists every check with its summary and category. */
function listAll(): void {
  heading('Diagnostic checks')
  write('')
  for (const group of checksByCategory()) {
    write(`  ${c().bold(CATEGORY_LABEL[group.category])}`)
    for (const { check, doc } of group.checks) {
      write(
        `    ${c().cyan(padTo(check.id, 18))}${c().dim(doc?.summary ?? check.title)}`,
      )
    }
    write('')
  }
  hint('Explain one in detail with `fbdoc explain <id>`.')
  hint('Run a single check with `fbdoc check --only <id>`.')
}

/** `fbdoc explain [id]` — what a check looks at, and why it matters. */
export async function runExplainCommand(
  id: string | undefined,
  options: ExplainCommandOptions,
): Promise<number> {
  if (!id || !id.trim()) {
    if (options.json) {
      const all = checksByCategory().flatMap((group) =>
        group.checks.map(({ check }) => payloadFor(check.id)),
      )
      write(JSON.stringify({ checks: all.filter(Boolean) }, null, 2))
      return 0
    }
    listAll()
    return 0
  }

  const payload = payloadFor(id)
  if (!payload) {
    writeErr(`${c().red(`${GLYPH.failure} No check is called "${id}".`)}`)
    hint('List every check with `fbdoc explain`.')
    return 1
  }

  if (options.json) {
    write(JSON.stringify(payload, null, 2))
    return 0
  }

  write('')
  write(`${c().bold(payload.title)} ${c().dim(`(${payload.id})`)}`)
  write(
    c().dim(
      `${payload.category ? CATEGORY_LABEL[payload.category] : 'Uncategorised'}${payload.network ? ' · needs the network (skipped by --offline)' : ' · works offline'}`,
    ),
  )
  write('')

  if (payload.summary) {
    for (const line of [payload.summary]) write(`  ${line}`)
    write('')
  }

  if (payload.looks.length > 0) {
    write(`  ${c().bold('What it looks at')}`)
    for (const item of payload.looks)
      write(`    ${c().dim(GLYPH.bullet)} ${item}`)
    write('')
  }

  if (payload.why) {
    write(`  ${c().bold('Why it matters')}`)
    write(`    ${payload.why}`)
    write('')
  }

  write(`  ${c().bold('Run it on its own')}`)
  write(`    ${c().cyan(payload.fixHint)}`)
  write('')

  if (payload.faq) {
    write(`  ${c().bold('Related FAQ')}`)
    write(`    ${payload.faq.title}`)
    write(`    ${c().dim(payload.faq.command)}`)
    write('')
  }

  return 0
}
