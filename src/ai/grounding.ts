/**
 * Checks an answer against the material it was supposed to come from.
 *
 * The assistant is a small model, and a small model asked about a product it
 * has opinions about will happily invent the missing piece: in testing it
 * described a "Share" button the FAQ explicitly says does not exist, and
 * `freebuff project url` / `fb project list` commands that were never real.
 * Instruction alone does not stop that — the model complied on one run and
 * fabricated on the next.
 *
 * So the answer is read back and its *checkable* fragments — the things it
 * presents as something to type — are looked for in the material the model was
 * given. Anything presented as a command that is not in that material is
 * reported, and `fbdoc ask` prints the FAQ's own wording underneath instead of
 * letting invented commands stand unremarked.
 */

/** Programs whose name at the start of a fragment makes it a command to check. */
const PROGRAMS = new Set([
  'brew',
  'bun',
  'choco',
  'codebuff',
  'curl',
  'del',
  'erase',
  'export',
  'fb',
  'freebuff',
  'git',
  'node',
  'nodejs',
  'notepad',
  'npm',
  'npx',
  'pip',
  'pnpm',
  'powershell',
  'pwsh',
  'python',
  'rmdir',
  'rundll32',
  'scoop',
  'setx',
  'taskkill',
  'winget',
  'yarn',
])

/**
 * `fbdoc` is deliberately absent from that list: it is this tool, its commands
 * are documented in the prompt, and suggesting one is never a fabrication.
 */
const OWN_TOOL = 'fbdoc'

const FN = /`([^`\n]+)`/g
const QUOTE_LINE = /^\s*>\s?(.*)$/
const INDENTED_CODE = /^(?: {2,}|\t+\S)/

/**
 * Flattens the differences that do not change what a command means: fancy
 * dashes and quotes, case, and runs of whitespace.
 */
export function normalizeClaim(value: string): string {
  return value
    .normalize('NFKD')
    .replace(/[\u2010-\u2015\u2212]/g, '-')
    .replace(/[\u2018\u2019\u201b]/g, "'")
    .replace(/[\u201c\u201d]/g, '"')
    .replace(/\u2026/g, '...')
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim()
}

/** Would this fragment be read as something to type? */
function looksLikeCommand(fragment: string): boolean {
  const text = fragment.trim().replace(/^[$#>]\s*/, '')
  if (text.length < 4) return false
  const [first = '', second] = text.split(/\s+/)
  const word = first.toLowerCase().replace(/[^a-z0-9]/g, '')
  if (word === OWN_TOOL) return false
  if (!PROGRAMS.has(word)) return false
  // A bare `fb` or `git` in prose is not a command to run; one with an argument
  // or a flag is.
  return second !== undefined || text.includes(' ')
}

/** The fragments of an answer that claim to be something the reader can run. */
export function commandClaims(answer: string): string[] {
  const claims: string[] = []
  const add = (fragment: string): void => {
    const text = fragment.trim()
    if (text && looksLikeCommand(text)) claims.push(text)
  }

  let inFence = false
  for (const line of answer.replace(/\r\n/g, '\n').split('\n')) {
    if (/^\s*(```|~~~)/.test(line)) {
      inFence = !inFence
      continue
    }
    if (inFence || INDENTED_CODE.test(line) || /^\s{0,3}\S/.test(line)) {
      add(line)
    }
    const quote = QUOTE_LINE.exec(line)
    if (quote) add(quote[1] ?? '')
  }

  for (const match of answer.matchAll(FN)) add(match[1] ?? '')
  return claims
}

const SECTION_HEAD = /^#### (.+)$/
const QUESTION_LINE = /^Then answer this question:/

/**
 * The FAQ text that was quoted into a turn, recovered from the turn itself, so
 * the correction shown to the reader is exactly what the model was handed.
 */
export function quotedSections(
  material: string,
): Array<{ title: string; body: string }> {
  const sections: Array<{ title: string; body: string[] }> = []
  let current: { title: string; body: string[] } | null = null

  for (const line of material.replace(/\r\n/g, '\n').split('\n')) {
    if (QUESTION_LINE.test(line)) break
    const heading = SECTION_HEAD.exec(line)
    if (heading) {
      current = { title: (heading[1] ?? '').trim(), body: [] }
      sections.push(current)
      continue
    }
    if (!current) continue
    // A different level of heading ends the excerpt that was quoted.
    if (/^#{1,3} /.test(line)) {
      current = null
      continue
    }
    current.body.push(line)
  }

  return sections
    .map((section) => ({
      title: section.title,
      body: section.body.join('\n').trim(),
    }))
    .filter((section) => section.body.length > 0)
}

/**
 * Ways an answer can say it does not know, or hand the question straight back.
 * Being read back matters because the FAQ text for the question was in the turn
 * when it said this: the reader is about to be sent to Discord for something
 * `fbdoc faq` already answers.
 */
const IGNORANCE = [
  /\b(?:i )?(?:do not|don't) have (?:any )?(?:information|details|info)/i,
  /\b(?:i )?(?:am|'m) not sure\b/i,
  /\b(?:i )?(?:cannot|can't|can not) (?:help|answer|find|provide)/i,
  /\bno (?:specific |detailed )?information\b/i,
  /\bfaq does not (?:cover|contain|mention|have)/i,
  /\bdoes not (?:cover|mention|address) (?:that|this|your question)\b/i,
  /\bwhich\b[^.?!\n]{0,40}\bdo you mean\b/i,
  /\bare you (?:asking|looking for)\b/i,
]

/** True when the answer asks rather than telling, or says it does not know. */
export function claimsIgnorance(answer: string): boolean {
  return IGNORANCE.some((pattern) => pattern.test(answer))
}

/**
 * The claims in `answer` that do not appear in `material` — the whole context
 * the model was given, so a command quoted from the FAQ, from a finding or from
 * its own instructions counts as supported.
 */
export function unsupportedClaims(
  answer: string,
  material: string,
  limit = 3,
): string[] {
  const haystack = normalizeClaim(material)
  const flagged: string[] = []
  for (const claim of commandClaims(answer)) {
    const needle = normalizeClaim(claim)
    if (haystack.includes(needle)) continue
    // A line of a quoted block is vouched for when the whole block is.
    if (
      flagged.some(
        (existing) =>
          normalizeClaim(existing).includes(needle) ||
          needle.includes(normalizeClaim(existing)),
      )
    ) {
      continue
    }
    flagged.push(claim)
    if (flagged.length >= limit) break
  }
  return flagged
}
