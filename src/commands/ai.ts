import {
  AI_MODEL,
  ANSWER_TEMPERATURE,
  API_KEY_ENV,
  KEY_SIGNUP_URL,
  looksLikeApiKey,
  maskApiKey,
  resolveApiKey,
  storeApiKey,
  type ApiKeySource,
} from '../ai/config.js'
import { quotedSections, unsupportedClaims } from '../ai/grounding.js'
import {
  AiError,
  DEFAULT_AI_TIMEOUT_MS,
  chat,
  type ChatMessage,
} from '../ai/client.js'
import {
  buildKnowledgeMessage,
  buildSystemPrompt,
  buildUserMessage,
} from '../ai/prompt.js'
import { AnswerRenderer } from '../ai/render.js'
import { runChecks } from '../checks/index.js'
import {
  createContext,
  summarize,
  type CheckContext,
  type CheckResult,
  type CheckSummary,
} from '../checks/types.js'
import { heading, printResult, write, writeErr } from '../ui/output.js'
import { ask, askSecret, confirm } from '../ui/prompts.js'
import { c, GLYPH, isInteractive, terminalWidth } from '../ui/theme.js'
import { renderMarkdown } from '../util/markdown.js'
import {
  collectSnapshot,
  type EnvironmentSnapshot,
} from '../util/environment.js'
import { doctorVersion } from '../util/version.js'
import { orderForDisplay } from './check.js'
import type { GlobalOptions } from './options.js'

export interface AiCommandOptions extends GlobalOptions {
  /** Answer one question and exit, instead of opening the chat. */
  question?: string
  /** `false` for `--no-checks`: answer from the question alone. */
  diagnostics?: boolean
}

/** Commands that exit non-zero are the ones that could not answer. */
const FAILED = 1
const OK = 0

/**
 * The assistant's own deadline. An explanation takes far longer than a health
 * check, so `--timeout` is treated as a floor rather than the AI's limit.
 */
export function aiTimeoutMs(options: Pick<GlobalOptions, 'timeoutMs'>): number {
  return Math.max(options.timeoutMs, DEFAULT_AI_TIMEOUT_MS)
}

interface Prepared {
  context: CheckContext
  results: CheckResult[]
  summary: CheckSummary
  environment: EnvironmentSnapshot
}

/** Runs the diagnostics the assistant should reason about. */
async function collectForAssistant(
  options: AiCommandOptions,
): Promise<Prepared> {
  const context = createContext({
    offline: options.offline,
    timeoutMs: options.timeoutMs,
  })

  let results: CheckResult[] = []
  if (options.diagnostics !== false) {
    // A plain status line rather than a spinner: on a console that does not
    // honour ANSI, a spinner frame is never erased and the findings below are
    // printed on top of it. The assistant's whole flow stays cursor-free.
    writeErr(c().dim('Running the diagnostics so the assistant has context…'))
    results = await runChecks({
      context,
      ...(options.only ? { only: options.only } : {}),
    })
  }

  const summary = summarize(results)
  const npmVersion =
    (results.find((result) => result.id === 'node-runtime')?.data
      ?.npmVersion as string | undefined) ?? null
  const environment = collectSnapshot(process.env, {
    home: context.home,
    npmVersion,
  })

  return { context, results, summary, environment }
}

function systemMessage(prepared: Prepared): string {
  return buildSystemPrompt({
    results: prepared.results,
    summary: prepared.summary,
    environment: prepared.environment,
    paths: prepared.context.paths,
    home: prepared.context.home,
    doctorVersion: doctorVersion(),
    platform: `${prepared.context.platform} (${prepared.context.arch})`,
    nodeVersion: prepared.context.nodeVersion,
    offline: prepared.context.offline,
  })
}

/**
 * Mirrors the top of a `check` run: the counts, then every problem in full, so
 * the reader can see what the assistant is about to be told.
 */
function printDigest(results: CheckResult[], summary: CheckSummary): void {
  if (results.length === 0) {
    writeErr(
      c().dim(
        'No diagnostics in this session — the assistant answers from your question alone.',
      ),
    )
    return
  }

  write('')
  heading('What the assistant has been told')
  const counts = [
    `${summary.total} checks`,
    `${summary.pass} passed`,
    `${summary.warn} warning${summary.warn === 1 ? '' : 's'}`,
    `${summary.fail} failed`,
  ]
  if (summary.skip > 0) counts.push(`${summary.skip} skipped`)
  write(c().dim(counts.join(' · ')))
  write('')

  const { attention } = orderForDisplay(results)
  if (attention.length === 0) {
    write(`${c().green(GLYPH.success)} Nothing needs fixing.`)
    return
  }
  for (const result of attention) {
    printResult(result)
    write('')
  }
}

/** Reads the key to use, asking for one when there is none to read. */
async function ensureApiKey(): Promise<ApiKeySource | null> {
  const existing = resolveApiKey()
  if (existing) {
    writeErr(
      c().dim(
        existing.source === 'env'
          ? `Using ${API_KEY_ENV} from your environment (${maskApiKey(existing.key)}).`
          : `Using the Groq key saved at ${existing.file} (${maskApiKey(existing.key)}).`,
      ),
    )
    return existing
  }

  if (!isInteractive()) {
    writeErr('')
    writeErr(`${c().red(`${GLYPH.failure} No Groq API key found.`)}`)
    writeErr(
      `  ${c().dim(GLYPH.arrow)} Create one at ${KEY_SIGNUP_URL}, then set ${c().cyan(`${API_KEY_ENV}=gsk_...`)} and run this again.`,
    )
    return null
  }

  write('')
  write(c().bold('Connect a Groq API key'))
  write(
    c().dim(
      `  One provider, one model: ${AI_MODEL} on Groq. No other service is contacted.`,
    ),
  )
  write(
    c().dim(
      `  Create a key at ${KEY_SIGNUP_URL} (it is shown once, so copy it straight away).`,
    ),
  )
  write('')

  const pasted = await askSecret({ message: 'Paste your Groq API key' })
  const key = (pasted ?? '').trim()
  if (!key) {
    writeErr(c().dim('No key entered — nothing was sent.'))
    return null
  }

  if (!looksLikeApiKey(key)) {
    const useAnyway = await confirm({
      message:
        'That does not look like a Groq key (they start with gsk_). Use it anyway?',
      default: false,
    })
    if (useAnyway !== true) return null
  }

  const save = await confirm({
    message: 'Save it on this machine so you do not have to paste it again?',
    default: true,
  })

  if (save === true) {
    const file = storeApiKey(key)
    writeErr(
      file
        ? c().dim(`Saved to ${file} — delete that file to forget the key.`)
        : c().yellow(
            'Could not save the key; it will be used for this session only.',
          ),
    )
  }

  return { key, source: 'file', file: '' }
}

/** Prints a Groq failure the way every other command prints one. */
function reportAiFailure(error: unknown, verbose: boolean): void {
  const message =
    error instanceof Error ? error.message : String(error ?? 'Unknown error')
  writeErr('')
  writeErr(`${c().red(`${GLYPH.failure} ${message}`)}`)
  if (error instanceof AiError && error.hint) {
    writeErr(`  ${c().dim(GLYPH.arrow)} ${error.hint}`)
  }
  if (!(error instanceof AiError)) {
    writeErr(`  ${c().dim(GLYPH.arrow)} Run with --verbose for the full error.`)
    if (verbose && error instanceof Error && error.stack) {
      writeErr('')
      writeErr(c().dim(error.stack))
    }
  }
}

/**
 * Reads the answer back against everything the model was handed.
 *
 * Instructions alone do not stop a small model from inventing a command it
 * half-remembers — the same question produced the FAQ's wording on one run and
 * `fb project list` on the next. So when an answer presents something to run
 * that appears nowhere in its context, the FAQ text for that question is
 * printed underneath it: the reader gets the authoritative wording instead of
 * instructions they cannot trust.
 */
function reportUngrounded(answer: string, messages: ChatMessage[]): void {
  const material = messages.map((message) => message.content).join('\n')
  const invented = unsupportedClaims(answer, material)
  if (invented.length === 0) return

  const quote = (value: string): string =>
    `“${value.replace(/\s+/g, ' ').trim().slice(0, 60)}”`
  write('')
  write(
    c().yellow(
      `${GLYPH.failure} Not in the FAQ: ${invented.map(quote).join(', ')} — the answer above may have guessed.`,
    ),
  )

  const sections = quotedSections(material).slice(0, 2)
  if (sections.length === 0) {
    write(
      c().dim(
        '  Run fbdoc faq with a few words from your question to read what it actually says.',
      ),
    )
    return
  }

  write(c().dim("  Here is the FAQ's own wording — trust this instead:"))
  for (const section of sections) {
    write('')
    write(c().bold(section.title))
    for (const line of renderMarkdown(section.body, {
      width: terminalWidth() - 2,
      indent: '  ',
    })) {
      write(line)
    }
    write(
      c().dim(
        `  Read it in full with ${c().cyan('fbdoc faq')} "${section.title}"`,
      ),
    )
  }
}

/**
 * Sends the conversation so far and prints the answer as it arrives.
 *
 * Deliberately no spinner. A spinner redraws the current line with ANSI cursor
 * control, and on a console that does not honour those codes its frames stay on
 * screen while the streamed text lands on top of them — which turns the answer
 * into a jumble of half-overwritten lines. This is the one place in the CLI
 * that writes *during* a wait, so it may not move the cursor at all: one status
 * line, then the answer, on ordinary newline-separated lines.
 *
 * The markdown itself is styled as it arrives, line by line, so the reader gets
 * headings, emphasis and code blocks rather than raw `**` and backticks.
 */
async function answerOnce(
  messages: ChatMessage[],
  options: AiCommandOptions,
  source: ApiKeySource,
): Promise<string> {
  writeErr(c().dim('Asking Groq…'))

  let opened = false
  const open = (): void => {
    if (opened) return
    opened = true
    write('')
    write(c().bold('Freebuff assistant'))
  }

  const renderer = new AnswerRenderer()
  const print = (lines: string[]): void => {
    if (lines.length === 0) return
    open()
    for (const line of lines) write(line)
  }

  const answer = await chat(
    {
      apiKey: source.key,
      messages,
      temperature: ANSWER_TEMPERATURE,
      timeoutMs: aiTimeoutMs(options),
    },
    (delta) => print(renderer.push(delta)),
  )

  print(renderer.flush())
  open()
  if (!answer.trim()) {
    write(c().yellow('Groq sent an empty answer — try asking in another way.'))
  } else {
    reportUngrounded(answer, messages)
  }
  return answer
}

const EXIT_WORDS = /^(?:exit|quit|q|:q|\/exit|\/quit|bye|thanks|thank you)$/i

/**
 * The user turn for a question: the FAQ text this question should be answered
 * from, then the question itself.
 *
 * The standing prompt lists every FAQ section; this is what puts the right one
 * in full, in the same turn as the question, where a small model will actually
 * use it. The question goes last so the facts are in place before it arrives.
 */
function turnContent(
  question: string,
  results: CheckResult[],
  home: string,
): string {
  const asked = buildUserMessage(question, home)
  const knowledge = buildKnowledgeMessage(question, results, home)
  if (!knowledge) return asked
  return `${knowledge}\n\nThen answer this question:\n\n${asked}`
}

/** The back-and-forth loop. Ctrl+C or `exit` closes it, as does a cancelled prompt. */
async function openChat(
  messages: ChatMessage[],
  options: AiCommandOptions,
  source: ApiKeySource,
  home: string,
  results: CheckResult[],
): Promise<number> {
  write('')
  write(
    `${c().bold('Freebuff assistant')} ${c().dim(`${AI_MODEL} · Groq · your report is redacted`)}`,
  )
  for (const line of [
    'Ask about anything the checks found — "why is freebuff not updating?"',
    'Everything this chat sends goes to Groq. Type `exit` to leave.',
  ]) {
    write(c().dim(`  ${line}`))
  }

  for (;;) {
    write('')
    const input = await ask({ message: c().bold('You') })
    if (input === null) {
      write(c().dim('Chat closed.'))
      return OK
    }
    const question = input.trim()
    if (!question) continue
    if (EXIT_WORDS.test(question)) {
      write(c().dim('Chat closed.'))
      write(
        c().dim(
          `  ${GLYPH.arrow} If you still need a human, \`fbdoc export\` writes the full report to your Downloads folder.`,
        ),
      )
      return OK
    }

    // The turn is dropped if it fails, so a retry does not send it twice.
    const mark = messages.length
    messages.push({
      role: 'user',
      content: turnContent(question, results, home),
    })
    try {
      const answer = await answerOnce(messages, options, source)
      messages.push({ role: 'assistant', content: answer })
    } catch (error) {
      messages.length = mark
      reportAiFailure(error, options.verbose)
    }
  }
}

/** Shared guard: the assistant cannot work without the network. */
function offlineRefusal(): number {
  writeErr('')
  writeErr(
    `${c().yellow(`${GLYPH.failure} The AI assistant needs the network, so --offline cannot be used with it.`)}`,
  )
  writeErr(
    `  ${c().dim(GLYPH.arrow)} Drop --offline (the diagnostics run either way) and try again.`,
  )
  return FAILED
}

/**
 * The menu's "Connect Groq API for AI assistance": run the diagnostics, then
 * open a chat seeded with what they found.
 */
export async function runAiCommand(options: AiCommandOptions): Promise<number> {
  if (options.offline) return offlineRefusal()

  const prepared = await collectForAssistant(options)
  printDigest(prepared.results, prepared.summary)

  const source = await ensureApiKey()
  if (!source) return FAILED

  const messages: ChatMessage[] = [
    { role: 'system', content: systemMessage(prepared) },
  ]
  return openChat(
    messages,
    options,
    source,
    prepared.context.home,
    prepared.results,
  )
}

/**
 * `fbdoc ask [question]` — one question, one answer, no chat. With no question
 * on an interactive terminal it opens the chat instead.
 */
export async function runAskCommand(
  question: string | undefined,
  options: AiCommandOptions,
): Promise<number> {
  const asked = question?.trim()

  if (!asked) {
    if (!isInteractive()) {
      writeErr('')
      writeErr(
        `${c().red(`${GLYPH.failure} \`fbdoc ask\` needs a question when it is not attached to a terminal.`)}`,
      )
      writeErr(
        `  ${c().dim(GLYPH.arrow)} For example: ${c().cyan('fbdoc ask "why does freebuff keep updating?"')}`,
      )
      return FAILED
    }
    return runAiCommand(options)
  }

  if (options.offline) return offlineRefusal()

  const prepared = await collectForAssistant(options)
  printDigest(prepared.results, prepared.summary)

  const source = await ensureApiKey()
  if (!source) return FAILED

  const messages: ChatMessage[] = [
    { role: 'system', content: systemMessage(prepared) },
    {
      role: 'user',
      content: turnContent(asked, prepared.results, prepared.context.home),
    },
  ]

  try {
    await answerOnce(messages, options, source)
  } catch (error) {
    reportAiFailure(error, options.verbose)
    return FAILED
  }
  return OK
}
