import Fuse from 'fuse.js'

import { SECTION_ALIASES } from './aliases.js'
import { loadFaq, type Faq, type FaqSection } from './loader.js'

export interface FaqMatch {
  section: FaqSection
  /** 0 to 1, where 1 is a certain match. */
  confidence: number
}

export interface FaqIndex {
  faq: Faq
  fuse: Fuse<SearchDoc>
  docs: SearchDoc[]
}

interface SearchDoc {
  section: FaqSection
  slug: string
  title: string
  keywords: string
  body: string
}

export type MatchDecision =
  | { kind: 'none' }
  | { kind: 'single'; match: FaqMatch }
  | { kind: 'multiple'; matches: FaqMatch[] }

/**
 * Lower-cases, drops diacritics and strips punctuation including apostrophes,
 * so `can't connect` and `cant connect` become the same token stream.
 */
export function normalize(value: string): string {
  return (value ?? '')
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[''`]/g, '')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()
}

function tokenize(value: string): string[] {
  return normalize(value).split(' ').filter(Boolean)
}

/** Builds a reusable search index over the parsed FAQ. */
export function createIndex(faq: Faq = loadFaq()): FaqIndex {
  const docs: SearchDoc[] = faq.sections.map((section) => ({
    section,
    slug: section.slug,
    title: normalize(section.title),
    keywords: normalize(
      [
        ...(SECTION_ALIASES[section.slug] ?? []),
        section.group,
        section.slug.replace(/-/g, ' '),
      ].join(' '),
    ),
    body: normalize(section.body),
  }))

  const fuse = new Fuse(docs, {
    includeScore: true,
    ignoreLocation: true,
    threshold: 0.42,
    minMatchCharLength: 2,
    keys: [
      { name: 'title', weight: 0.55 },
      { name: 'keywords', weight: 0.3 },
      { name: 'body', weight: 0.15 },
    ],
  })

  return { faq, fuse, docs }
}

const FIELD_WEIGHT = { title: 1, keywords: 0.85, body: 0.4 } as const

/** Scores a query token inside a field, preferring whole-word hits. */
function fieldScore(field: string, token: string): number {
  if (!field) return 0
  if (field.split(' ').includes(token)) return 1
  return field.includes(token) ? 0.6 : 0
}

const compact = (value: string): string => value.split(' ').join('')

/** True when the query phrase lands on the title as a whole word. */
function titleHit(title: string, phrase: string): boolean {
  if (compact(title) === compact(phrase)) return true
  for (const token of title.split(' ')) {
    if (token === phrase) return true
    if (phrase.length >= 4 && token.startsWith(phrase)) return true
  }
  return phrase.includes(' ') && title.includes(phrase)
}

interface Evidence {
  confidence: number
  /**
   * How direct the evidence is. Fuse scores short fields generously, so a
   * whole-word title hit must outrank a merely fuzzy one.
   */
  tier: number
}

/** Direct (non-fuzzy) evidence that a document answers the query. */
function evidence(doc: SearchDoc, phrase: string, tokens: string[]): Evidence {
  if (!phrase) return { confidence: 0, tier: 0 }
  if (compact(doc.title) === compact(phrase)) return { confidence: 1, tier: 3 }
  if (titleHit(doc.title, phrase)) return { confidence: 0.95, tier: 3 }
  if (doc.keywords.includes(phrase)) return { confidence: 0.93, tier: 2 }

  if (tokens.length === 0) return { confidence: 0, tier: 0 }
  let total = 0
  for (const token of tokens) {
    total += Math.max(
      fieldScore(doc.title, token) * FIELD_WEIGHT.title,
      fieldScore(doc.keywords, token) * FIELD_WEIGHT.keywords,
      fieldScore(doc.body, token) * FIELD_WEIGHT.body,
    )
  }
  const confidence = (total / tokens.length) * 0.9
  return { confidence, tier: confidence > 0 ? 1 : 0 }
}

export interface SearchOptions {
  limit?: number
  /** Minimum confidence to keep a match. */
  floor?: number
}

/**
 * Ranks FAQ sections for a query, blending exact keyword evidence with Fuse's
 * typo-tolerant matching.
 */
export function searchIndex(
  index: FaqIndex,
  query: string,
  options: SearchOptions = {},
): FaqMatch[] {
  const limit = options.limit ?? 5
  const floor = options.floor ?? 0.3
  const phrase = normalize(query)
  if (!phrase) return []
  const tokens = tokenize(phrase)

  const scored = new Map<string, Evidence>()
  for (const doc of index.docs) {
    const direct = evidence(doc, phrase, tokens)
    if (direct.confidence > 0) scored.set(doc.slug, direct)
  }

  for (const result of index.fuse.search(query)) {
    const doc = result.item
    const fuzzy = Math.min(1, Math.max(0, 1 - (result.score ?? 1)))
    const current = scored.get(doc.slug)
    if (!current) {
      scored.set(doc.slug, { confidence: fuzzy, tier: 0 })
    } else if (fuzzy > current.confidence) {
      // Fuzzy matching can sharpen a candidate, but never demote the evidence
      // tier that a direct title or keyword hit already earned.
      scored.set(doc.slug, { confidence: fuzzy, tier: current.tier })
    }
  }

  const candidates = index.docs.map((doc, order) => {
    const value = scored.get(doc.slug)
    return {
      section: doc.section,
      confidence: value?.confidence ?? 0,
      tier: value?.tier ?? 0,
      order,
    }
  })

  return candidates
    .filter((candidate) => candidate.confidence >= floor)
    .sort((a, b) => {
      if (b.tier !== a.tier) return b.tier - a.tier
      if (b.confidence !== a.confidence) return b.confidence - a.confidence
      return a.order - b.order
    })
    .slice(0, limit)
    .map(({ section, confidence }) => ({ section, confidence }))
}

/** Convenience wrapper that loads the bundled FAQ on demand. */
export function searchFaq(
  query: string,
  options: SearchOptions = {},
): FaqMatch[] {
  return searchIndex(createIndex(), query, options)
}

export interface DecideOptions {
  /** Confidence at which a match is treated as definitive on its own. */
  singleThreshold?: number
  /** How far ahead of the runner-up the top match must be to stand alone. */
  margin?: number
}

/**
 * Confidence a *lone* candidate needs before it is answered directly. Asking
 * someone to pick from a list of one is worse than simply showing it, so the bar
 * is lower when there is nothing to choose between.
 */
export const LONE_MATCH_FLOOR = 0.45

/**
 * Decides whether to print one answer or offer a short list. An obvious winner
 * is printed directly; anything genuinely ambiguous is left for the user to pick.
 */
export function decideMatches(
  matches: FaqMatch[],
  options: DecideOptions = {},
): MatchDecision {
  const singleThreshold = options.singleThreshold ?? 0.72
  const margin = options.margin ?? 0.08

  const [best, runnerUp] = matches
  if (!best) return { kind: 'none' }

  if (!runnerUp) {
    return best.confidence >= Math.min(singleThreshold, LONE_MATCH_FLOOR)
      ? { kind: 'single', match: best }
      : { kind: 'multiple', matches }
  }

  if (
    best.confidence >= singleThreshold &&
    best.confidence - runnerUp.confidence >= margin
  ) {
    return { kind: 'single', match: best }
  }
  return { kind: 'multiple', matches }
}
