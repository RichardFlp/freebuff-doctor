import { describe, expect, it } from 'vitest'

import { SECTION_ALIASES } from '../src/faq/aliases.js'
import { loadFaq, parseFaq, slugifyHeading } from '../src/faq/loader.js'
import {
  createIndex,
  decideMatches,
  normalize,
  searchIndex,
  significantTokens,
} from '../src/faq/search.js'

const faq = loadFaq()
const index = createIndex(faq)

const topSlug = (query: string): string | null =>
  searchIndex(index, query)[0]?.section.slug ?? null

describe('parseFaq', () => {
  it('indexes every level-2 heading in the bundled FAQ', () => {
    expect(faq.sections.length).toBeGreaterThan(25)
    expect(faq.sections.map((section) => section.slug)).toContain(
      'network-issues',
    )
    expect(faq.sections.map((section) => section.slug)).toContain(
      'troubleshooting-official',
    )
  })

  it('groups sections under their level-1 heading', () => {
    const network = faq.sections.find(
      (section) => section.slug === 'network-issues',
    )
    const quickStart = faq.sections.find(
      (section) => section.slug === 'quick-start',
    )
    expect(network?.group).toMatch(/Support FAQ/)
    expect(quickStart?.group).toMatch(/Official Documentation/)
  })

  it('keeps section bodies non-empty and free of the heading itself', () => {
    for (const section of faq.sections) {
      expect(section.body.length).toBeGreaterThan(0)
      expect(section.body.startsWith('## ')).toBe(false)
      expect(section.body).not.toContain('# Freebuff — Support FAQ')
    }
  })

  it('never treats fenced content as a heading', () => {
    const fixture = [
      '# Title',
      '',
      '## Real Section',
      '',
      '```bash',
      '# a comment that looks like a heading',
      '',
      '# Another Fake Title',
      '```',
      '',
      '## Second Section',
      '',
      'body two',
    ].join('\n')
    const parsed = parseFaq(fixture)
    expect(parsed.title).toBe('Title')
    expect(parsed.sections.map((section) => section.title)).toEqual([
      'Real Section',
      'Second Section',
    ])
    expect(parsed.sections[0]?.body).toContain('# Another Fake Title')
  })

  it('de-duplicates repeated headings', () => {
    const parsed = parseFaq('# T\n\n## Same\n\nx\n\n## Same\n\ny\n')
    expect(parsed.sections.map((section) => section.slug)).toEqual([
      'same',
      'same-1',
    ])
  })
})

describe('slugifyHeading', () => {
  it('matches GitHub anchors, including collapsed punctuation', () => {
    expect(slugifyHeading('Network Issues')).toBe('network-issues')
    expect(slugifyHeading('Freebucks (Currency) & Daily Limits')).toBe(
      'freebucks-currency--daily-limits',
    )
    expect(slugifyHeading('Session / Context Recovery')).toBe(
      'session--context-recovery',
    )
    expect(slugifyHeading('Crash on Start / Updating')).toBe(
      'crash-on-start--updating',
    )
    expect(slugifyHeading("Can't connect")).toBe('cant-connect')
  })
})

describe('aliases', () => {
  it('only references sections that exist', () => {
    const slugs = new Set(faq.sections.map((section) => section.slug))
    for (const slug of Object.keys(SECTION_ALIASES)) {
      expect(
        slugs.has(slug),
        `alias "${slug}" has no matching FAQ section`,
      ).toBe(true)
    }
  })
})

describe('normalize', () => {
  it('removes apostrophes, punctuation and case', () => {
    expect(normalize("Can't connect!")).toBe('cant connect')
    expect(normalize('  DNS / VPN  ')).toBe('dns vpn')
  })
})

describe('searchIndex', () => {
  it('finds Network Issues for the classic phrasing', () => {
    expect(topSlug("can't connect")).toBe('network-issues')
    expect(topSlug('cant connect')).toBe('network-issues')
    expect(topSlug('no internet')).toBe('network-issues')
  })

  it('ignores filler words instead of letting them dilute the ranking', () => {
    // The conversational form must still land on a confident, single answer
    // rather than degrading into a pick-one list.
    const terse = searchIndex(index, 'cant connect')
    const conversational = searchIndex(index, 'i cant connect please')

    expect(conversational[0]?.section.slug).toBe('network-issues')
    // Filler must not weaken the answer: both forms carry the same confidence.
    expect(conversational[0]?.confidence).toBeCloseTo(
      terse[0]?.confidence ?? 0,
      1,
    )
    expect(conversational[0]?.confidence).toBeGreaterThanOrEqual(0.9)
    expect(decideMatches(conversational).kind).toBe('single')
  })

  it('answers directly even when a stray word fuzzy-matches another section', () => {
    // "can't" appears inside the Opening a Project section, which used to be
    // enough to turn this into a needless pick-one list.
    const matches = searchIndex(index, 'can you help me i cant connect')
    expect(matches[0]?.section.slug).toBe('network-issues')
    expect(decideMatches(matches).kind).toBe('single')
  })

  it('never strips a query down to nothing', () => {
    expect(significantTokens('the of and')).toEqual(['the', 'of', 'and'])
    expect(significantTokens('i cant connect')).toEqual(['cant', 'connect'])
    expect(significantTokens('not working')).toEqual(['not', 'working'])
  })

  it('tolerates typos and partial phrasing', () => {
    expect(topSlug('netwrok issue')).toBe('network-issues')
    expect(topSlug('update loup')).toBe('crash-on-start--updating')
  })

  it('routes other common complaints to the right section', () => {
    expect(topSlug('daily limit')).toBe('freebucks-currency--daily-limits')
    expect(topSlug('refund please')).toBe('freebucks-refunds')
    expect(topSlug('wont launch after update')).toBe('crash-on-start--updating')
    expect(topSlug('command not found')).toBe('troubleshooting-official')
    expect(topSlug('lost my chat history')).toBe('session--context-recovery')
    expect(topSlug('mcp server not ready')).toBe('mcp-server-setup-beta')
  })

  it('rates a whole-word title hit above a merely fuzzy one', () => {
    // "update" appears as a word in the crash/update title, which must beat
    // sections that only match loosely.
    expect(topSlug('update')).toBe('crash-on-start--updating')
    const matches = searchIndex(index, 'update')
    expect(matches[0]?.confidence).toBeGreaterThanOrEqual(0.9)
  })

  it('returns nothing for an empty query', () => {
    expect(searchIndex(index, '   ')).toEqual([])
  })

  it('returns nothing for gibberish', () => {
    expect(searchIndex(index, 'zzzqqqxxyy')).toEqual([])
  })

  it('honours the limit', () => {
    expect(
      searchIndex(index, 'project', { limit: 3 }).length,
    ).toBeLessThanOrEqual(3)
  })
})

describe('decideMatches', () => {
  it('picks a single answer when one section clearly wins', () => {
    const decision = decideMatches(searchIndex(index, "can't connect"))
    expect(decision.kind).toBe('single')
  })

  it('offers a list when several sections are plausible', () => {
    const decision = decideMatches(searchIndex(index, 'project'))
    expect(decision.kind).toBe('multiple')
    if (decision.kind === 'multiple') {
      expect(decision.matches.length).toBeGreaterThan(1)
    }
  })

  it('offers a list rather than guessing between two genuinely close sections', () => {
    const top = searchIndex(index, 'freebucks')[0]
    expect(top?.section.slug).toMatch(/^freebucks-/)
    expect(decideMatches(searchIndex(index, 'freebucks')).kind).toBe('multiple')
  })

  it('answers a clear winner directly instead of prompting with a list', () => {
    // Typos still collect weak fuzzy stragglers, but a direct hit that leads by
    // a clear margin must be answered rather than turned into a pick-list.
    expect(topSlug('netwrok issue')).toBe('network-issues')
    expect(decideMatches(searchIndex(index, 'netwrok issue')).kind).toBe(
      'single',
    )
    expect(decideMatches(searchIndex(index, 'update loup')).kind).toBe('single')
  })

  it('answers a lone candidate', () => {
    const matches = searchIndex(index, 'privecy')
    expect(matches).toHaveLength(1)
    expect(decideMatches(matches).kind).toBe('single')
  })

  it('reports none for an unmatched query', () => {
    expect(decideMatches(searchIndex(index, 'zzzqqqxxyy')).kind).toBe('none')
  })
})
