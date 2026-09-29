import { checkDoc, documentedIds } from '../checks/catalog.js'
import { listChecks } from '../checks/index.js'
import type { CheckResult } from '../checks/types.js'
import { allSections } from '../faq/reference.js'
import { createIndex, searchIndex, type FaqIndex } from '../faq/search.js'
import type { FaqSection } from '../faq/loader.js'
import { estimateTokens } from '../util/tokens.js'

/**
 * The assistant's Freebuff knowledge, assembled from what this package already
 * ships: the bundled FAQ that `fbdoc faq` searches, and the catalogue behind
 * `fbdoc explain`.
 *
 * It is sent as text, so it has to fit a budget. A free Groq key is limited to
 * 8000 tokens per minute for `gpt-oss-20b`, and the FAQ alone is about 7500 —
 * sending it whole would spend the entire minute on one question. So the prompt
 * carries an *index* of every section (the model knows what is covered), the
 * catalogue of every check, and the FAQ text itself only for the sections that
 * this question and these findings actually touch.
 */

/** Combined character budget of everything `buildKnowledge` adds to the prompt. */
export const MAX_KNOWLEDGE_CHARS = 11_500

/** Room the per-question FAQ text may take on top of the standing knowledge. */
export const MAX_TURN_KNOWLEDGE_CHARS = 5_400

export const MAX_FAQ_INDEX_CHARS = 2_600
export const MAX_CATALOGUE_CHARS = 7_000
export const MAX_FINDING_SECTIONS_CHARS = 4_000

/** How long one FAQ section may be before it is cut, so one cannot crowd out the rest. */
export const MAX_SECTION_CHARS = 2_800

/** How many sections a single question may pull in. */
export const MAX_SECTIONS_PER_TURN = 3

let cachedIndex: FaqIndex | null = null

/** The FAQ search index, built once — the same one `fbdoc faq` searches. */
function bundledIndex(): FaqIndex {
  cachedIndex ??= createIndex()
  return cachedIndex
}

/** Clears the search-index cache. Used by tests. */
export function resetKnowledgeCache(): void {
  cachedIndex = null
}

function clip(value: string, max: number): string {
  const text = value.trim()
  if (text.length <= max) return text
  const cut = text.slice(0, max)
  const stop = Math.max(cut.lastIndexOf('. '), cut.lastIndexOf('\n'))
  return `${stop > max * 0.5 ? cut.slice(0, stop + 1) : cut}…`
}

/**
 * What the assistant is told it can rely on before it reads the detail below.
 * Deliberately operational: the product facts come from the FAQ text rather
 * than from a summary written here, which is one more place they could drift.
 */
export const FREEBUFF_PRIMER = `Freebuff is the AI coding agent this tool supports: a desktop app, a web app and Cloud projects, plus the CLI the official docs describe. Its local state lives under the state directories listed above. The bundled FAQ below is the support reference this project ships — compiled from the Discord support forum and the official codebuff.com/docs — and it is the authority on Freebuff's behaviour here.

You have that FAQ in reach: its sections are listed below, the ones this question touches are quoted in full, and the person can print any of them with \`fbdoc faq "<words from the title>"\`. Prefer what the FAQ and the findings say over anything you remember about similar tools: if they do not cover something, say you are not sure and point at \`fbdoc export\` or the Discord.`

const faqTitleCache = new Map<string, string>()

/**
 * Every FAQ section, grouped the way the file is: enough for the model to know
 * what covers what, and to name the section someone should read.
 */
export function faqIndex(maxChars = MAX_FAQ_INDEX_CHARS): string {
  const sections = allSections()
  if (sections.length === 0) return ''
  const groups = new Map<string, string[]>()
  for (const section of sections) {
    const titles = groups.get(section.group) ?? []
    titles.push(section.title)
    groups.set(section.group, titles)
    faqTitleCache.set(section.slug, section.title)
  }

  const lines: string[] = []
  let used = 0
  for (const [group, titles] of groups) {
    const line = `- ${group}: ${titles.map((title) => `“${title}”`).join(' · ')}`
    if (used + line.length > maxChars) break
    lines.push(line)
    used += line.length + 1
  }
  const covered = lines.reduce(
    (total, line) => total + line.split(' · ').length,
    0,
  )
  if (covered < sections.length) {
    lines.push(
      `- (${sections.length - covered} further sections: run \`fbdoc faq\` to browse them.)`,
    )
  }
  return lines.join('\n')
}

/**
 * Every check `fbdoc` runs, with what it looks at and why it matters. The
 * explanation is dropped from the entries that do not fit the budget rather
 * than dropping the entries themselves, so no check is ever unknown to the
 * model — it can always point at `fbdoc explain <id>` for the rest.
 */
export function checkCatalogue(maxChars = MAX_CATALOGUE_CHARS): string {
  const ids = documentedIds()
  if (ids.length === 0) return ''
  const titles = new Map(listChecks().map((check) => [check.id, check.title]))

  const lines: string[] = []
  let used = 0
  for (const id of ids) {
    const doc = checkDoc(id)
    const title = titles.get(id) ?? id
    const faq = doc?.faqSlug ? ` FAQ: ${doc.faqSlug}.` : ''
    const summary = (doc?.summary ?? 'No description.').trim()
    const base = `- ${id} — ${title}: ${/[.!?]$/.test(summary) ? summary : `${summary}.`}`
    const why = doc?.why ? clip(doc.why, 120) : ''
    const full = why ? `${base} Why it matters: ${why}` : base
    const line =
      used + full.length + faq.length <= maxChars
        ? `${full}${faq}`
        : `${base}${faq}`
    if (used + line.length > maxChars) {
      lines.push(`- and ${ids.length - lines.length} further checks.`)
      break
    }
    lines.push(line)
    used += line.length + 1
  }
  return lines.join('\n')
}

/** Formats sections for the prompt, in the order they were chosen. */
export function formatSections(
  sections: FaqSection[],
  maxChars: number,
): string {
  const blocks: string[] = []
  let used = 0
  for (const section of sections) {
    const body = clip(
      section.body,
      Math.min(MAX_SECTION_CHARS, maxChars - used),
    )
    if (!body) continue
    const block = `#### ${section.title}\n\n${body}`
    if (used + block.length > maxChars) break
    blocks.push(block)
    used += block.length + 1
  }
  return blocks.join('\n\n')
}

/**
 * The FAQ sections worth quoting for a set of topics — a question, the ids of
 * the findings, or the URL-ish slugs they point at. The bundled search decides,
 * so the assistant and `fbdoc faq` agree on what a question is about.
 */
export function relevantSections(
  topics: string[],
  options: { limit?: number; maxChars?: number } = {},
): FaqSection[] {
  const limit = options.limit ?? MAX_SECTIONS_PER_TURN
  const query = topics.filter((topic) => topic.trim().length > 0).join(' ')
  if (!query.trim()) return []

  const chosen: FaqSection[] = []
  const seen = new Set<string>()

  // A finding that already names its FAQ section is not a guess: take it first.
  for (const topic of topics) {
    const slug = topic.trim().toLowerCase()
    const exact = allSections().find((section) => section.slug === slug)
    if (exact && !seen.has(exact.slug)) {
      chose(exact)
    }
  }
  for (const match of searchIndex(bundledIndex(), query, {
    limit: limit + 2,
    floor: 0.25,
  })) {
    if (chosen.length >= limit) break
    chose(match.section)
  }
  return chosen

  function chose(section: FaqSection): void {
    if (seen.has(section.slug) || chosen.length >= limit) return
    seen.add(section.slug)
    chosen.push(section)
  }
}

/** The standing knowledge block: the primer, the FAQ index and the catalogue. */
export function buildKnowledge(results: CheckResult[] = []): string {
  const blocks = [
    FREEBUFF_PRIMER,
    `### What the bundled FAQ covers\n\n${faqIndex()}`,
    `### What fbdoc checks\n\n${checkCatalogue()}`,
  ]

  // The FAQ text for this run's findings gets whatever is left of the budget,
  // so the standing knowledge is never what gets dropped for it.
  const room = Math.max(
    0,
    Math.min(
      MAX_FINDING_SECTIONS_CHARS,
      MAX_KNOWLEDGE_CHARS - blocks.join('\n\n').length,
    ),
  )
  const sections = relevantSections(
    results.flatMap((result) => (result.faqSlug ? [result.faqSlug] : [])),
    { limit: 2, maxChars: room },
  )
  const quoted = formatSections(sections, room)
  if (quoted) {
    blocks.push(`### FAQ sections behind this run's findings\n\n${quoted}`)
  }
  return blocks.filter((block) => block.trim().length > 0).join('\n\n')
}

/**
 * The FAQ text to send with one question, so the answer comes from the bundled
 * FAQ rather than from the model's memory of other coding agents — a small
 * model happily invents a button that the FAQ explicitly says does not exist.
 *
 * The framing is deliberately strict: this text is the only authority on
 * Freebuff for the turn, and nothing may be added to it.
 */
export function buildTurnKnowledge(
  question: string,
  results: CheckResult[] = [],
): string | null {
  const sections = relevantSections([
    question,
    ...results.flatMap((result) => (result.faqSlug ? [result.faqSlug] : [])),
  ])
  const quoted = formatSections(sections, MAX_TURN_KNOWLEDGE_CHARS)
  if (!quoted) return null
  return [
    'The person at the terminal is asking about Freebuff, and these are the sections of the bundled Freebuff FAQ that bear on it.',
    'This text is the only thing you may treat as fact about Freebuff for this answer: it is the same text `fbdoc faq` prints, and where it and your own idea of how such a tool works disagree, it wins.',
    'Do not add a step, a button, a menu, a setting, a flag or a command it does not contain, and never put your own wording inside a quote. If it does not answer the question, say the FAQ does not cover it and point at the closest titles from the list of FAQ sections you were given — those titles exactly, never one you have thought of yourself.',
    '',
    quoted,
  ].join('\n')
}

/** The title of a FAQ section by slug, for naming it in an answer. */
export function faqTitle(slug: string): string | null {
  if (faqTitleCache.size === 0) faqIndex()
  return faqTitleCache.get(slug) ?? null
}
