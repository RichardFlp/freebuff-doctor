import Fuse from 'fuse.js'

import { SECTION_ALIASES } from './aliases.js'
import { loadFaq, type Faq, type FaqSection } from './loader.js'

export interface FaqMatch {
  section: FaqSection
  /** 0 to 1, where 1 is a certain match. */
  confidence: number
  /**
   * How direct the evidence was: 3 for a title hit, 2 for a keyword hit, 1 for
   * token overlap, 0 for a purely fuzzy match.
   */
  tier: number
}

export interface FaqIndex {
  faq: Faq
  fuse: Fuse<SearchDoc>
  docs: SearchDoc[]
  /** How many sections contain each token, used to spot non-discriminating words. */
  documentFrequency: Map<string, number>
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

/**
 * Filler words that add noise without narrowing a search. Deliberately excludes
 * meaningful short words like "not", "no", "cant" and "help", and is only
 * applied when at least one substantive token would remain.
 */
const STOP_WORDS = new Set([
  'a',
  'an',
  'the',
  'i',
  'im',
  'my',
  'me',
  'is',
  'it',
  'its',
  'this',
  'that',
  'these',
  'those',
  'to',
  'on',
  'in',
  'at',
  'for',
  'of',
  'and',
  'or',
  'but',
  'do',
  'does',
  'did',
  'am',
  'are',
  'be',
  'been',
  'was',
  'were',
  'with',
  'from',
  'as',
  'so',
  'if',
  'then',
  'than',
  'there',
  'here',
  'when',
  'why',
  'how',
  'what',
  'which',
  'who',
  'whom',
  'can',
  'could',
  'would',
  'should',
  'will',
  'you',
  'your',
  'we',
  'us',
  'they',
  'them',
  'their',
  'our',
  'please',
  'pls',
  'just',
  'really',
  'very',
  'some',
  'any',
  'about',
  'get',
  'getting',
  'have',
  'has',
  'had',
])

/** A token appearing in this share of sections is too common to narrow anything. */
export const COMMON_TOKEN_RATIO = 0.25

/**
 * Query tokens with filler removed. Given an index, words that are ubiquitous
 * in the FAQ are dropped too; the raw tokens are the fallback so a query never
 * becomes empty (a bare "help" still has to resolve).
 */
export function significantTokens(phrase: string, index?: FaqIndex): string[] {
  const tokens = tokenize(phrase)
  const meaningful = tokens.filter((token) => {
    if (STOP_WORDS.has(token)) return false
    if (!index) return true
    const rate =
      (index.documentFrequency.get(token) ?? 0) / Math.max(1, index.docs.length)
    return rate < COMMON_TOKEN_RATIO
  })
  return meaningful.length > 0 ? meaningful : tokens
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

  // Document frequency lets a query drop words that are everywhere in this FAQ
  // ("help", "issue") without needing them enumerated by hand.
  const documentFrequency = new Map<string, number>()
  for (const doc of docs) {
    const seen = new Set(tokenize(`${doc.title} ${doc.keywords} ${doc.body}`))
    for (const token of seen) {
      documentFrequency.set(token, (documentFrequency.get(token) ?? 0) + 1)
    }
  }

  return { faq, fuse, docs, documentFrequency }
}

const FIELD_WEIGHT = { title: 1, keywords: 0.85, body: 0.4 } as const

/** Edit distance, used to recognise typos as the same word. */
function levenshtein(a: string, b: string): number {
  if (a === b) return 0
  const previous = new Array<number>(b.length + 1)
  const current = new Array<number>(b.length + 1)
  for (let j = 0; j <= b.length; j += 1) previous[j] = j

  for (let i = 1; i <= a.length; i += 1) {
    current[0] = i
    for (let j = 1; j <= b.length; j += 1) {
      const substitution = a[i - 1] === b[j - 1] ? 0 : 1
      current[j] = Math.min(
        (previous[j] ?? 0) + 1,
        (current[j - 1] ?? 0) + 1,
        (previous[j - 1] ?? 0) + substitution,
      )
    }
    for (let j = 0; j <= b.length; j += 1) previous[j] = current[j] ?? 0
  }
  return previous[b.length] ?? 0
}

/** Similarity in 0..1 between two words (1 means identical). */
export function wordSimilarity(a: string, b: string): number {
  const longest = Math.max(a.length, b.length)
  if (longest === 0) return 1
  return 1 - levenshtein(a, b) / longest
}

/** Above this similarity a word counts as a typo of the query token. */
const TYPO_SIMILARITY = 0.7

/**
 * Scores a query token inside a field, preferring whole-word hits.
 *
 * `typoTolerant` compares against individual words, so `netwrok` still scores
 * against a `network` title. It is only enabled for the short, high-signal
 * fields: a typo in a long body paragraph is weak evidence at best.
 */
function fieldScore(
  field: string,
  token: string,
  typoTolerant = false,
): number {
  if (!field) return 0
  const words = field.split(' ')
  if (words.includes(token)) return 1

  // Plurals and typos are checked before the loose substring fallback, and score
  // almost full marks. Without this, "issue" only weakly matched the "issues" in
  // a section title, so a query like "netwrok issue" tied with an unrelated
  // section whose title happens to contain "issues".
  if (typoTolerant && token.length >= 4) {
    let best = 0
    for (const word of words) {
      if (word.length < 4) continue
      if (word.startsWith(token) || token.startsWith(word)) {
        best = Math.max(best, 0.9)
        continue
      }
      if (Math.abs(word.length - token.length) > 2) continue
      const similarity = wordSimilarity(token, word)
      if (similarity >= TYPO_SIMILARITY) best = Math.max(best, similarity * 0.9)
    }
    if (best > 0) return best
  }

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

  // Every significant word landing on the curated keyword list is as strong a
  // signal as the phrase itself, so conversational phrasing ("i cant connect
  // please") ranks the same as the terse form ("cant connect").
  if (tokens.length > 1) {
    const keywordTokens = doc.keywords.split(' ')
    if (tokens.every((token) => keywordTokens.includes(token))) {
      return { confidence: 0.92, tier: 2 }
    }
  }

  if (tokens.length === 0) return { confidence: 0, tier: 0 }
  let total = 0
  for (const token of tokens) {
    total += Math.max(
      fieldScore(doc.title, token, true) * FIELD_WEIGHT.title,
      fieldScore(doc.keywords, token, true) * FIELD_WEIGHT.keywords,
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
  // Filler and ubiquitous words are dropped from token scoring so that "can you
  // help me i cant connect" ranks like "cant connect" instead of diluting into
  // an ambiguous list.
  const tokens = significantTokens(phrase, index)

  const scored = new Map<string, Evidence>()
  for (const doc of index.docs) {
    const direct = evidence(doc, phrase, tokens)
    if (direct.confidence > 0) scored.set(doc.slug, direct)
  }

  // Fuse is the recall safety net for sections that share no word with the
  // query, searching the cleaned tokens rather than the raw phrasing, and then
  // once per token — multi-term fuzzy scoring hides a real match behind its
  // unmatched terms. It never *raises* a section that already has direct
  // evidence: fuzzy scores are generous for short fields, and letting them
  // overwrite a real score made two unrelated sections look equally likely.
  const fuseQueries = new Set([tokens.join(' '), ...tokens])
  for (const fuseQuery of fuseQueries) {
    for (const result of index.fuse.search(fuseQuery)) {
      const doc = result.item
      if (scored.has(doc.slug)) continue
      const fuzzy = Math.min(1, Math.max(0, 1 - (result.score ?? 1)))
      scored.set(doc.slug, { confidence: fuzzy, tier: 0 })
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
    .map(({ section, confidence, tier }) => ({ section, confidence, tier }))
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
 * Decides whether to print one answer or offer a short list. The evidence
 * *tier* matters more than the raw score: fuzzy scores for unrelated sections
 * sit close enough to genuine matches that a pure confidence margin gets the
 * wrong answer.
 */
export function decideMatches(
  matches: FaqMatch[],
  options: DecideOptions = {},
): MatchDecision {
  const singleThreshold = options.singleThreshold ?? 0.72
  const margin = options.margin ?? 0.08

  const [best, runnerUp] = matches
  if (!best) return { kind: 'none' }

  const hasDirectEvidence = best.tier >= 1

  // Confidence is only comparable within a tier: a fuzzy-only match can score
  // higher than a genuine keyword hit purely because its field is short, so
  // only candidates matching the winner's evidence tier count as rivals.
  const rival = matches.find(
    (match) => match !== best && match.tier === best.tier,
  )
  const lead = best.confidence - (rival?.confidence ?? 0)

  // 1. Nothing else rests on equally strong evidence: the answer is not in
  //    doubt. This is what keeps a typo'd or conversational query from becoming
  //    a needless pick-one list.
  if (hasDirectEvidence && best.confidence >= LONE_MATCH_FLOOR && !rival) {
    return { kind: 'single', match: best }
  }

  // 2. A lone candidate. Without direct evidence it has to be very convincing,
  //    since "pick one" from a list of one is worse than just showing it.
  if (!runnerUp) {
    const bar = hasDirectEvidence
      ? Math.min(singleThreshold, LONE_MATCH_FLOOR)
      : singleThreshold
    return best.confidence >= bar
      ? { kind: 'single', match: best }
      : { kind: 'multiple', matches }
  }

  // 3. An equally-grounded winner that is clearly ahead of its rival.
  if (
    hasDirectEvidence &&
    lead >= margin &&
    best.confidence >= LONE_MATCH_FLOOR
  ) {
    return { kind: 'single', match: best }
  }

  // 4. Comparable candidates: genuinely ambiguous, so let the user choose.
  return { kind: 'multiple', matches }
}
