import type { FaqSection } from '../faq/loader.js'
import {
  createIndex,
  decideMatches,
  searchIndex,
  type FaqIndex,
  type FaqMatch,
} from '../faq/search.js'
import {
  hint,
  printFaqMatches,
  printFaqSection,
  write,
  heading,
} from '../ui/output.js'
import { ask, choose } from '../ui/prompts.js'
import { c } from '../ui/theme.js'
import { truncate } from '../util/width.js'
import type { GlobalOptions } from './options.js'

export interface FaqCommandOptions extends GlobalOptions {
  limit?: number
  list?: boolean
}

let cachedIndex: FaqIndex | null = null

function index(): FaqIndex {
  cachedIndex ??= createIndex()
  return cachedIndex
}

/** Every FAQ section as a lightweight JSON row. */
export function faqIndexForJson(): Array<{
  slug: string
  title: string
  group: string
  line: number
}> {
  return index().faq.sections.map((section) => ({
    slug: section.slug,
    title: section.title,
    group: section.group,
    line: section.line,
  }))
}

/** Prints the whole table of contents, grouped by document section. */
export function printAllSections(): void {
  const { faq } = index()
  for (const group of faq.groups) {
    write('')
    write(c().bold(group))
    for (const section of faq.sections.filter(
      (candidate) => candidate.group === group,
    )) {
      write(`  ${c().dim('•')} ${section.title}`)
    }
  }
  write('')
  hint('Read one with `fbdoc faq "section title"`.')
}

/**
 * Presents matches the way the spec asks: one confident answer is printed
 * directly, an ambiguous query becomes a short list to choose from.
 */
export async function presentMatches(
  matches: FaqMatch[],
  options: { interactive: boolean },
): Promise<FaqSection[]> {
  const decision = decideMatches(matches)

  if (decision.kind === 'none') {
    write('')
    write(`${c().yellow('No FAQ section matched that.')}`)
    hint('Try different words, or list everything with `fbdoc faq --list`.')
    write('')
    return []
  }

  if (decision.kind === 'single') {
    printFaqSection(decision.match.section)
    return [decision.match.section]
  }

  // Guard: never ask someone to pick from a list of one.
  const only = decision.matches[0]
  if (decision.matches.length === 1 && only) {
    printFaqSection(only.section)
    return [only.section]
  }

  write('')
  write(
    `${c().bold('Several sections could match')} ${c().dim('— pick one to read:')}`,
  )
  write('')
  printFaqMatches(decision.matches)
  write('')

  if (!options.interactive) {
    hint(
      'Re-run with more specific words, or open one with `fbdoc faq "<title>"`.',
    )
    write('')
    return decision.matches.map((match) => match.section)
  }

  // A distinct sentinel, so "show all" is never confused with Ctrl+C (which
  // surfaces as `null` and must simply stop).
  const ALL = '__all__' as const
  const chosen = await choose<FaqSection | typeof ALL>({
    message: 'Which section?',
    choices: [
      ...decision.matches.map((match) => ({
        name: match.section.title,
        value: match.section,
        description: match.section.group,
      })),
      {
        name: 'Show all of them',
        value: ALL,
        description: 'Print every matching section',
      },
    ],
  })

  if (chosen === null) {
    write(c().dim('Cancelled.'))
    return []
  }

  if (chosen === ALL) {
    for (const match of decision.matches) {
      printFaqSection(match.section)
    }
    return decision.matches.map((match) => match.section)
  }

  printFaqSection(chosen)
  return [chosen]
}

/** Picks the best FAQ sections for a query, honouring explicit slugs. */
export function resolveSections(slugs: string[]): FaqSection[] {
  const { faq } = index()
  return slugs
    .map((slug) => faq.sections.find((section) => section.slug === slug))
    .filter((section): section is FaqSection => Boolean(section))
}

/** Interactive "search the FAQ" flow used by the menu and `fbdoc faq`. */
export async function promptFaqSearch(root: GlobalOptions): Promise<void> {
  const query = await ask({ message: 'What are you looking for?' })
  if (!query || !query.trim()) {
    write(c().dim('Nothing to search for.'))
    return
  }
  const matches = searchIndex(index(), query, { limit: root.json ? 50 : 5 })
  await presentMatches(matches, { interactive: true })
}

function searchSuggestions(): void {
  const { faq } = index()
  const picks = [
    'Network Issues',
    'Crash on Start / Updating',
    'Session / Context Recovery',
  ]
  write(`  ${c().dim('Popular sections:')}`)
  for (const title of picks) {
    const section = faq.sections.find((candidate) => candidate.title === title)
    if (section) write(`    ${c().cyan('•')} ${truncate(section.title, 60)}`)
  }
}

/** `fbdoc faq [query]`. */
export async function runFaqCommand(
  query: string | undefined,
  options: FaqCommandOptions,
): Promise<number> {
  if (options.json && !query) {
    write(JSON.stringify({ sections: faqIndexForJson() }, null, 2))
    return 0
  }

  if (options.list) {
    if (options.json) {
      write(JSON.stringify({ sections: faqIndexForJson() }, null, 2))
      return 0
    }
    printAllSections()
    return 0
  }

  if (!query || !query.trim()) {
    if (process.stdout.isTTY) {
      await promptFaqSearch(options)
      return 0
    }
    heading('fbdoc faq')
    write('Provide a search term, for example:')
    hint('fbdoc faq "can\'t connect"')
    hint('fbdoc faq "updating"')
    hint('fbdoc faq --list')
    searchSuggestions()
    return 1
  }

  const matches = searchIndex(index(), query, { limit: options.limit ?? 5 })

  if (options.json) {
    write(
      JSON.stringify(
        {
          query,
          matchCount: matches.length,
          matches: matches.map((match) => ({
            slug: match.section.slug,
            title: match.section.title,
            group: match.section.group,
            confidence: Number(match.confidence.toFixed(3)),
          })),
        },
        null,
        2,
      ),
    )
    return matches.length > 0 ? 0 : 1
  }

  const shown = await presentMatches(matches, {
    interactive: process.stdout.isTTY === true,
  })
  if (shown.length === 0) {
    // Matches existed but the user backed out of the picker: not an error.
    if (matches.length > 0) return 0
    searchSuggestions()
    return 1
  }
  return 0
}
