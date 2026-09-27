import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

export interface FaqSection {
  /** GitHub-compatible anchor id, e.g. `network-issues`. */
  slug: string
  title: string
  /** The level-1 heading this section sits under. */
  group: string
  /** Raw markdown body, excluding the section heading itself. */
  body: string
  /** 1-based line number of the heading, used for `--verbose` output. */
  line: number
}

export interface Faq {
  title: string
  sections: FaqSection[]
  groups: string[]
  /** Absolute path of the bundled FAQ file. */
  source: string
  raw: string
}

/**
 * Turns a heading into a GitHub-compatible anchor: punctuation is dropped and
 * runs of whitespace become hyphens (so `A & B` becomes `a--b`).
 */
export function slugifyHeading(title: string): string {
  return title
    .trim()
    .toLowerCase()
    .replace(
      /[\u2000-\u206f\u2e00-\u2e7f\\'!"#$%&()*+,./:;<=>?@[\]^`{|}~]/g,
      '',
    )
    .replace(/\s+/g, (match) => '-'.repeat(match.length))
}

/** Parses `faq.md` into indexable sections. Code fences are never treated as headings. */
export function parseFaq(markdown: string, source = 'faq.md'): Faq {
  const lines = markdown.replace(/\r\n/g, '\n').split('\n')
  const sections: FaqSection[] = []
  const usedSlugs = new Set<string>()

  let title = 'Freebuff FAQ'
  let seenTitle = false
  let group = ''
  let current: { title: string; line: number; body: string[] } | null = null
  let fenceMarker: string | null = null

  const close = (): void => {
    if (!current) return
    let slug = slugifyHeading(current.title)
    if (!slug) slug = 'section'
    let unique = slug
    let counter = 1
    while (usedSlugs.has(unique)) {
      unique = `${slug}-${counter}`
      counter += 1
    }
    usedSlugs.add(unique)
    sections.push({
      slug: unique,
      title: current.title,
      group: group || title,
      body: current.body.join('\n').trim(),
      line: current.line,
    })
    current = null
  }

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index] ?? ''

    const fence = /^\s*(```|~~~)/.exec(line)
    if (fence) {
      const marker = fence[1] ?? '```'
      if (fenceMarker === null) fenceMarker = marker
      else if (marker === fenceMarker) fenceMarker = null
      current?.body.push(line)
      continue
    }
    if (fenceMarker !== null) {
      current?.body.push(line)
      continue
    }

    const heading = /^(#{1,6})\s+(.+?)\s*$/.exec(line)
    if (heading) {
      const level = (heading[1] ?? '#').length
      const text = (heading[2] ?? '').trim()
      if (level === 1) {
        close()
        if (!seenTitle) {
          title = text
          seenTitle = true
        }
        group = text
        continue
      }
      if (level === 2) {
        close()
        current = { title: text, line: index + 1, body: [] }
        continue
      }
    }

    current?.body.push(line)
  }
  close()

  const groups: string[] = []
  for (const section of sections) {
    if (!groups.includes(section.group)) groups.push(section.group)
  }

  return { title, sections, groups, source, raw: markdown }
}

/** Locates the bundled `faq.md`, relative to this module rather than the cwd. */
export function faqPath(): string {
  const override = process.env.FBDOC_FAQ_PATH
  if (override && fs.existsSync(override)) return path.resolve(override)

  let dir = path.dirname(fileURLToPath(import.meta.url))
  for (let depth = 0; depth < 6; depth += 1) {
    const candidate = path.join(dir, 'faq.md')
    if (fs.existsSync(candidate)) return candidate
    const parent = path.dirname(dir)
    if (parent === dir) break
    dir = parent
  }
  throw new Error(
    'Bundled faq.md could not be found next to the installed package. Reinstall with `npm install -g freebuff-doctor`.',
  )
}

let cached: Faq | null = null

/** Loads and parses the bundled FAQ once per process. */
export function loadFaq(): Faq {
  if (cached) return cached
  const source = faqPath()
  cached = parseFaq(fs.readFileSync(source, 'utf8'), source)
  return cached
}

/** Clears the parsed-FAQ cache. Used by tests. */
export function resetFaqCache(): void {
  cached = null
}

/** Finds a section by exact slug, falling back to a case-insensitive title match. */
export function findSection(faq: Faq, slugOrTitle: string): FaqSection | null {
  const needle = slugOrTitle.trim().toLowerCase()
  return (
    faq.sections.find((section) => section.slug === needle) ??
    faq.sections.find((section) => section.title.toLowerCase() === needle) ??
    null
  )
}
