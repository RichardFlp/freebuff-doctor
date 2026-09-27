import { loadFaq, type FaqSection } from './loader.js'

export interface FaqReference {
  slug: string
  title: string
  /** Command a user can run to read this section. */
  command: string
}

/**
 * Looks up the FAQ section behind a check's `faqSlug`. Returns `null` rather
 * than throwing if the bundled FAQ is missing, since a diagnostic must still
 * report its findings.
 */
export function faqReference(slug: string): FaqReference | null {
  try {
    const section = loadFaq().sections.find(
      (candidate) => candidate.slug === slug,
    )
    if (!section) return null
    return {
      slug: section.slug,
      title: section.title,
      command: `fbdoc faq "${section.title}"`,
    }
  } catch {
    return null
  }
}

/** Every section, in document order. */
export function allSections(): FaqSection[] {
  try {
    return loadFaq().sections
  } catch {
    return []
  }
}
