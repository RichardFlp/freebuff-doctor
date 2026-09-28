import { AI_MODEL, GROQ_API_BASE } from './config.js'

export type ChatRole = 'system' | 'user' | 'assistant'

export interface ChatMessage {
  role: ChatRole
  content: string
}

/** How long one answer may take. Generous: a full explanation is not a ping. */
export const DEFAULT_AI_TIMEOUT_MS = 90_000

/**
 * A failure worth showing a human: the message says what happened, the hint
 * says what to do about it. Anything else is a bug and should keep its stack.
 */
export class AiError extends Error {
  readonly status: number | null
  readonly hint: string | null

  constructor(
    message: string,
    options: { status?: number | null; hint?: string | null } = {},
  ) {
    super(message)
    this.name = 'AiError'
    this.status = options.status ?? null
    this.hint = options.hint ?? null
  }
}

export interface ChatOptions {
  apiKey: string
  messages: ChatMessage[]
  model?: string
  baseUrl?: string
  temperature?: number
  maxTokens?: number
  /** How long the whole request may take before it is aborted. */
  timeoutMs?: number
  /** Injected by tests; defaults to the global `fetch`. */
  fetchImpl?: typeof fetch
}

/**
 * Splits a Server-Sent Events buffer into complete `data:` payloads, returning
 * whatever is left of a partially received event. Only the SSE subset Groq uses
 * is handled: newline-delimited `data:` lines inside `\n\n`-separated events.
 */
export function splitSseBuffer(buffer: string): {
  payloads: string[]
  rest: string
} {
  const normalized = buffer.replace(/\r\n/g, '\n')
  const events = normalized.split('\n\n')
  const rest = events.pop() ?? ''
  const payloads: string[] = []
  for (const event of events) {
    for (const line of event.split('\n')) {
      if (!line.startsWith('data:')) continue
      const data = line.slice('data:'.length).trim()
      if (data) payloads.push(data)
    }
  }
  return { payloads, rest }
}

/**
 * The text carried by one streamed chunk. Returns `null` for the terminator,
 * for role-only openers, and for anything unparseable — a malformed chunk must
 * not throw away an answer that is otherwise arriving fine.
 */
export function deltaFromSsePayload(payload: string): string | null {
  if (payload === '[DONE]') return null
  try {
    const parsed = JSON.parse(payload) as {
      choices?: Array<{ delta?: { content?: unknown } }>
    }
    const content = parsed.choices?.[0]?.delta?.content
    return typeof content === 'string' && content.length > 0 ? content : null
  } catch {
    return null
  }
}

/** The answer text in a non-streamed response body. */
export function answerFromBody(body: string): string {
  try {
    const parsed = JSON.parse(body) as {
      choices?: Array<{ message?: { content?: unknown } }>
    }
    const content = parsed.choices?.[0]?.message?.content
    return typeof content === 'string' ? content.trim() : ''
  } catch {
    return ''
  }
}

/** Groq's own error message, when it sent a readable one. */
export function serverMessage(body: string): string | null {
  try {
    const parsed = JSON.parse(body) as { error?: { message?: unknown } }
    const message = parsed.error?.message
    if (typeof message !== 'string') return null
    const trimmed = message.trim()
    return trimmed ? trimmed.split('\n')[0]!.slice(0, 300) : null
  } catch {
    return null
  }
}

/** Turns an HTTP failure into something a user can act on. */
export function describeFailure(
  status: number,
  body: string,
): { message: string; hint: string | null } {
  const detail = serverMessage(body)
  const withDetail = (message: string): string =>
    detail ? `${message} Groq said: ${detail}` : message

  if (status === 401 || status === 403) {
    return {
      message: withDetail('Groq rejected the API key.'),
      hint: 'Check the key at https://console.groq.com/keys — a key is only shown once, when you create it.',
    }
  }
  if (status === 404) {
    return {
      message: withDetail(`Groq does not offer \`${AI_MODEL}\` for this key.`),
      hint: 'This build talks to that model only; update freebuff-doctor and try again.',
    }
  }
  if (status === 413) {
    return {
      message: 'The request was too large for the model.',
      hint: 'Re-run with `fbdoc ask --no-checks "..."` so less context is sent.',
    }
  }
  if (status === 429) {
    return {
      message: withDetail('Groq is rate limiting this key (HTTP 429).'),
      hint: 'Wait a moment and ask again. Free tier limits reset within a minute.',
    }
  }
  if (status === 400 && detail && /decommission|not supported/i.test(detail)) {
    return {
      message: withDetail('Groq no longer serves that model.'),
      hint: 'Update freebuff-doctor to pick up the current model.',
    }
  }
  if (status >= 500) {
    return {
      message: withDetail(`Groq returned a server error (HTTP ${status}).`),
      hint: 'That is on Groq’s side — try again in a minute.',
    }
  }
  return {
    message: withDetail(`The request to Groq failed (HTTP ${status}).`),
    hint: 'Run with --verbose to see the full response.',
  }
}

/** Reads an SSE response, forwarding each fragment as it arrives. */
async function readStream(
  response: Response,
  onDelta: (text: string) => void,
): Promise<string> {
  const body = response.body as unknown as
    AsyncIterable<Uint8Array> | null | undefined
  if (!body) return answerFromBody(await response.text())

  const decoder = new TextDecoder()
  let buffer = ''
  let answer = ''

  const consume = (payloads: string[]): void => {
    for (const payload of payloads) {
      const delta = deltaFromSsePayload(payload)
      if (!delta) continue
      answer += delta
      onDelta(delta)
    }
  }

  for await (const chunk of body) {
    buffer += decoder.decode(chunk, { stream: true })
    const { payloads, rest } = splitSseBuffer(buffer)
    buffer = rest
    consume(payloads)
  }
  // Never drop a trailing event that arrived without its blank-line separator.
  consume(splitSseBuffer(`${buffer}\n\n`).payloads)

  return answer.trim()
}

/**
 * Sends one turn to Groq and returns the answer. With `onDelta` the response is
 * streamed and the fragments are handed over as they arrive; without it the
 * whole answer is fetched in one go.
 */
export async function chat(
  options: ChatOptions,
  onDelta?: (text: string) => void,
): Promise<string> {
  const fetchImpl = options.fetchImpl ?? globalThis.fetch
  if (typeof fetchImpl !== 'function') {
    throw new AiError('This Node runtime has no fetch implementation.', {
      hint: 'Upgrade to Node 22 or newer.',
    })
  }

  const model = options.model ?? AI_MODEL
  const baseUrl = (options.baseUrl ?? GROQ_API_BASE).replace(/\/+$/, '')
  const streaming = typeof onDelta === 'function'

  let response: Response
  try {
    response = await fetchImpl(`${baseUrl}/chat/completions`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        accept: streaming ? 'text/event-stream' : 'application/json',
        authorization: `Bearer ${options.apiKey}`,
      },
      body: JSON.stringify({
        model,
        messages: options.messages,
        temperature: options.temperature ?? 0.3,
        max_completion_tokens: options.maxTokens ?? 1200,
        stream: streaming,
      }),
      signal: AbortSignal.timeout(options.timeoutMs ?? DEFAULT_AI_TIMEOUT_MS),
    })
  } catch (error) {
    const reason = error instanceof Error ? error.name : ''
    if (reason === 'TimeoutError' || reason === 'AbortError') {
      throw new AiError('Groq did not answer in time.', {
        hint: 'Check your connection, or try a shorter question.',
      })
    }
    throw new AiError(
      `Could not reach Groq: ${error instanceof Error ? error.message : String(error)}`,
      {
        hint: 'Check your internet connection, and any proxy set in HTTPS_PROXY.',
      },
    )
  }

  if (!response.ok) {
    const body = await response.text().catch(() => '')
    const { message, hint } = describeFailure(response.status, body)
    throw new AiError(message, { status: response.status, hint })
  }

  if (!streaming) {
    const body = await response.text()
    const answer = answerFromBody(body)
    if (!answer) {
      throw new AiError('Groq returned an answer this build could not read.', {
        hint: 'Try again; if it keeps happening, please report it.',
      })
    }
    return answer
  }

  return readStream(response, onDelta)
}
