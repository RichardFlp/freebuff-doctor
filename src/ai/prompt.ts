import { checkDoc } from '../checks/catalog.js'
import type { CheckResult, CheckSummary } from '../checks/types.js'
import type { EnvironmentSnapshot } from '../util/environment.js'
import { anonymizePath, type PlatformPaths } from '../util/platform.js'
import { redact } from '../util/redact.js'
import { AI_MODEL } from './config.js'

/**
 * Everything the assistant is told about the machine it is advising. All of it
 * is redacted on the way out — see `buildSystemPrompt`.
 */
export interface AssistantContext {
  results: CheckResult[]
  summary: CheckSummary
  environment: EnvironmentSnapshot
  paths: PlatformPaths
  home: string
  doctorVersion: string
  platform: string
  nodeVersion: string
  offline: boolean
}

/** Only this much of the run is ever sent, so a noisy machine cannot flood the request. */
export const MAX_FINDINGS_CHARS = 8_000

const MAX_DETAIL_LINES = 6
const MAX_PATH_ENTRIES = 25
const MAX_VARIABLES = 15

/** One finding, as the model reads it: what it was, why, and what to run. */
export function describeFinding(result: CheckResult): string[] {
  const lines = [
    `- [${result.status}] ${result.id} — ${result.title}: ${result.message}`,
  ]
  for (const detail of (result.details ?? []).slice(0, MAX_DETAIL_LINES)) {
    lines.push(`    detail: ${detail}`)
  }
  if (result.fix) lines.push(`    suggested fix: ${result.fix}`)
  if (result.faqSlug) {
    lines.push(
      `    faq: https://github.com/RichardFlp/freebuff-doctor/blob/main/faq.md#${result.faqSlug}`,
    )
  }
  const doc = checkDoc(result.id)
  if (doc) lines.push(`    this check looks at: ${doc.looks.join('; ')}`)
  return lines
}

/**
 * The findings, worst first, bounded in size. The model gets the same verdict a
 * human sees in the `Next` line of a check run, plus enough detail to reason
 * about it — but never the raw `data` payloads, which are noise.
 */
export function buildFindings(
  results: CheckResult[],
  summary: CheckSummary,
  maxChars = MAX_FINDINGS_CHARS,
): string {
  if (results.length === 0) {
    return 'The diagnostics have not been run in this session, so there are no findings yet. If the question needs them, say so and point the person at `fbdoc check`.'
  }

  const lines = [
    `${summary.total} checks: ${summary.pass} passed, ${summary.warn} warning(s), ${summary.fail} failed, ${summary.skip} skipped.`,
  ]

  const ranked = [...results].sort((a, b) => weight(b) - weight(a))
  const attention = ranked.filter(
    (result) => result.status === 'fail' || result.status === 'warn',
  )

  if (attention.length === 0) {
    lines.push('No check failed or warned: this machine looks healthy.')
  } else {
    lines.push('', 'What needs attention, most serious first:')
    let used = lines.join('\n').length
    let omitted = 0
    for (const result of attention) {
      const block = describeFinding(result)
      const size = block.join('\n').length + 1
      if (used + size > maxChars) {
        omitted += 1
        continue
      }
      used += size
      lines.push(...block)
    }
    if (omitted > 0) {
      lines.push(
        `… ${omitted} further finding(s) omitted for length; the full list is in \`fbdoc export\`.`,
      )
    }
  }

  const clean = results.filter(
    (result) => result.status === 'pass' || result.status === 'skip',
  )
  if (clean.length > 0) {
    lines.push(
      '',
      `Passed or skipped, by id: ${clean.map((result) => result.id).join(', ')}.`,
    )
  }

  return lines.join('\n')
}

/** Sort weight: failures first, then warnings that come with a fix. */
function weight(result: CheckResult): number {
  const base = result.status === 'fail' ? 3 : result.status === 'warn' ? 2 : 0
  return base + (result.fix ? 1 : 0)
}

function describePaths(context: AssistantContext): string {
  const anonymize = (value: string): string =>
    anonymizePath(value, context.home)
  return [
    `- CLI state (\`~/.config/manicode\`): ${anonymize(context.paths.cliState)}`,
    `- Desktop state: ${anonymize(context.paths.desktopState)}`,
    `- Legacy Codebuff state: ${anonymize(context.paths.legacyState)}`,
  ].join('\n')
}

/** The environment snapshot, already anonymized, trimmed to what is useful. */
function describeEnvironment(environment: EnvironmentSnapshot): string {
  const lines = [
    `- Shell: ${environment.shell ?? 'unknown'}`,
    `- npm: ${environment.npm ?? 'unknown'}`,
  ]

  const entries = environment.pathEntries.slice(0, MAX_PATH_ENTRIES)
  if (entries.length > 0) {
    lines.push(
      `- PATH (${environment.pathEntries.length} entries, search order):`,
      ...entries.map(
        (entry) =>
          `    ${entry.index}. ${entry.value}${entry.duplicate ? ' (duplicate)' : ''}`,
      ),
    )
  }

  const variables = environment.variables.slice(0, MAX_VARIABLES)
  if (variables.length > 0) {
    lines.push(
      '- Variables that affect Freebuff:',
      ...variables.map((variable) => `    ${variable.name}=${variable.value}`),
    )
  }

  return lines.join('\n')
}

const ROLE = `You are the assistant built into Freebuff Doctor (\`fbdoc\`), a terminal tool that diagnoses problems with Freebuff and its desktop app. You are talking to the person who just ran the diagnostics on their own machine, in a terminal. Your only job is to help them fix the problem they are looking at.

You are running as ${AI_MODEL} on Groq. You have the findings from their run below, and nothing else: no files, no shell, no network.`

const HOW_TO_ANSWER = `How to answer:

- Lead with the most likely cause, then the exact steps to fix it.
- Give commands they can paste as-is, written for their platform and shell. Include the whole command, not a description of one.
- Name the finding you mean, e.g. "the \`dns\` check", so they can match it to their screen.
- Keep it short: a sentence or two, then a numbered list of at most five steps. At most one code block, under fifteen lines.
- When you need a detail you do not have, ask one short question instead of guessing.
- Never invent a Freebuff flag, setting, file path, URL or feature. If you are not sure, say so and point them at \`fbdoc export\` so a human helper can read the full report.
- You cannot run anything. Say "run ..." rather than implying you did it.
- Their home directory and secrets were redacted before reaching you. Never ask them to paste an API key, token or password into this chat.
- If nothing is wrong, say so in one line and offer something useful: a check to re-run, or \`fbdoc export\`.

What the tool can do, if you want to suggest it:

- \`fbdoc check\` runs all the diagnostics; \`fbdoc check --only <id>\` runs one.
- \`fbdoc explain <id>\` describes what a check looks at and why it matters.
- \`fbdoc faq "<words>"\` searches the bundled FAQ.
- \`fbdoc report\` prints a short redacted report; \`fbdoc export\` writes a detailed .md file to their Downloads folder.
- \`fbdoc diff before.json after.json\` shows whether a fix changed anything.`

/**
 * The instructions and context sent at the start of every conversation. Built
 * from the actual results rather than a summary of them, so the advice can be
 * specific — and put through the redactor, so a check that echoed a secret
 * cannot leak it into a third-party API.
 */
export function buildSystemPrompt(context: AssistantContext): string {
  const sections = [
    ROLE,
    `## Findings from this run\n\n${buildFindings(context.results, context.summary)}`,
    `## This machine\n\n- Platform: ${context.platform}\n- Node: ${context.nodeVersion}\n- fbdoc: ${context.doctorVersion}\n- Network checks: ${context.offline ? 'skipped (--offline was used)' : 'ran normally'}\n- Freebuff directories (home shown as \`~\`):\n${describePaths(context)}`,
    `## Environment (already redacted)\n\n${describeEnvironment(context.environment)}`,
    HOW_TO_ANSWER,
  ]
  return redact(sections.join('\n\n'), context.home)
}

/** The user's own turn, redacted before it leaves the machine. */
export function buildUserMessage(question: string, home?: string): string {
  return redact(question.trim(), home)
}
