import { mkdtempSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'

import { aiTimeoutMs, groundingNotice } from '../src/commands/ai.js'
import { DEFAULT_AI_TIMEOUT_MS } from '../src/ai/client.js'
import {
  AiError,
  answerFromBody,
  chat,
  deltaFromSsePayload,
  describeFailure,
  fitMessages,
  MAX_REQUEST_TOKENS,
  sanitizeText,
  serverMessage,
  splitSseBuffer,
  type ChatMessage,
} from '../src/ai/client.js'
import {
  AI_MODEL,
  API_KEY_ENV,
  clearStoredKey,
  keyFile,
  looksLikeApiKey,
  maskApiKey,
  readStoredKey,
  resolveApiKey,
  storeApiKey,
} from '../src/ai/config.js'
import {
  buildFindings,
  buildKnowledgeMessage,
  buildSystemPrompt,
  buildUserMessage,
} from '../src/ai/prompt.js'
import {
  buildKnowledge,
  buildTurnKnowledge,
  checkCatalogue,
  faqIndex,
  MAX_KNOWLEDGE_CHARS,
} from '../src/ai/knowledge.js'
import { estimateTokens } from '../src/util/tokens.js'
import {
  claimsIgnorance,
  commandClaims,
  quotedSections,
  unsupportedClaims,
} from '../src/ai/grounding.js'
import { createColors } from 'picocolors'

import { AnswerRenderer, renderAnswer } from '../src/ai/render.js'
import { MENU_CHOICES } from '../src/commands/menu.js'
import type { CheckResult } from '../src/checks/types.js'
import { summarize } from '../src/checks/types.js'
import { allSections } from '../src/faq/reference.js'
import { collectSnapshot } from '../src/util/environment.js'
import { resolvePlatformPaths } from '../src/util/platform.js'
import { redact } from '../src/util/redact.js'
import { stringWidth } from '../src/util/width.js'

/**
 * A deliberately fake key. Groq keys are `gsk_` plus a long alphanumeric tail,
 * so this has the right shape for the validation, masking and redaction tests
 * while being worthless to anyone who reads it. Never put a real key here.
 */
const TEST_KEY = 'gsk_faketestkey0123456789abcdefghijTEST'

const HOME = process.platform === 'win32' ? 'C:\\Users\\tester' : '/home/tester'

function tempConfigRoot(): string {
  return mkdtempSync(path.join(tmpdir(), 'fbdoc-ai-'))
}

function env(overrides: Record<string, string> = {}): NodeJS.ProcessEnv {
  return { ...overrides } as NodeJS.ProcessEnv
}

describe('apikey', () => {
  it('recognises a Groq key and rejects everything else', () => {
    expect(looksLikeApiKey(TEST_KEY)).toBe(true)
    expect(looksLikeApiKey(`  ${TEST_KEY}  `)).toBe(true)
    expect(looksLikeApiKey('gsk_short')).toBe(false)
    expect(looksLikeApiKey('sk-proj-abcdefghijklmnopqrstuvwx')).toBe(false)
    expect(looksLikeApiKey('')).toBe(false)
    expect(looksLikeApiKey(undefined)).toBe(false)
  })

  it('masks a key without revealing it', () => {
    const masked = maskApiKey(TEST_KEY)
    expect(masked).not.toContain(TEST_KEY)
    expect(masked).not.toBe(TEST_KEY)
    expect(masked).toMatch(/^gsk_fake/)
    expect(masked.endsWith('TEST')).toBe(true)
    // Nothing usable survives: no long run of the secret's body.
    expect(masked).not.toContain('testkey0123456789')
    expect(maskApiKey('gsk_x')).toBe('••••')
  })

  it('lives under the config root, honouring XDG_CONFIG_HOME', () => {
    expect(keyFile('/home/tester', env())).toBe(
      path.join('/home/tester', '.config', 'freebuff-doctor', 'groq.json'),
    )
    expect(keyFile('/home/tester', env({ XDG_CONFIG_HOME: '/tmp/xdg' }))).toBe(
      path.join('/tmp/xdg', 'freebuff-doctor', 'groq.json'),
    )
  })

  it('prefers GROQ_API_KEY over a saved key', () => {
    const configRoot = tempConfigRoot()
    storeApiKey('gsk_saved00000000000000000000', {
      env: env({ XDG_CONFIG_HOME: configRoot }),
    })

    const fromEnv = resolveApiKey({
      home: HOME,
      env: env({ XDG_CONFIG_HOME: configRoot, [API_KEY_ENV]: TEST_KEY }),
    })
    expect(fromEnv?.source).toBe('env')
    expect(fromEnv?.key).toBe(TEST_KEY)

    const fromFile = resolveApiKey({
      home: HOME,
      env: env({ XDG_CONFIG_HOME: configRoot }),
    })
    expect(fromFile?.source).toBe('file')
    expect(fromFile?.key).toBe('gsk_saved00000000000000000000')
  })

  it('returns null when nothing is configured', () => {
    const configRoot = tempConfigRoot()
    expect(
      resolveApiKey({ home: HOME, env: env({ XDG_CONFIG_HOME: configRoot }) }),
    ).toBeNull()
  })

  it('round-trips a saved key and can forget it', () => {
    const configRoot = tempConfigRoot()
    const file = storeApiKey(TEST_KEY, {
      env: env({ XDG_CONFIG_HOME: configRoot }),
    })
    expect(file).toBe(path.join(configRoot, 'freebuff-doctor', 'groq.json'))

    const stored = readStoredKey(HOME, env({ XDG_CONFIG_HOME: configRoot }))
    expect(stored?.key).toBe(TEST_KEY)
    expect(stored?.source).toBe('file')
    // The provider and model are recorded alongside it, so the file explains itself.
    expect(readFileSync(file ?? '', 'utf8')).toContain(AI_MODEL)
    expect(readFileSync(file ?? '', 'utf8')).toContain('groq')

    expect(clearStoredKey({ env: env({ XDG_CONFIG_HOME: configRoot }) })).toBe(
      true,
    )
    expect(readStoredKey(HOME, env({ XDG_CONFIG_HOME: configRoot }))).toBeNull()
    expect(clearStoredKey({ env: env({ XDG_CONFIG_HOME: configRoot }) })).toBe(
      false,
    )
  })

  it('keeps the saved key readable only by its owner', () => {
    if (process.platform === 'win32') return
    const configRoot = tempConfigRoot()
    const file = storeApiKey(TEST_KEY, {
      env: env({ XDG_CONFIG_HOME: configRoot }),
    })
    expect(statSync(file ?? '').mode & 0o077).toBe(0)
  })

  it('accepts a plain-text key file as well as JSON', () => {
    const configRoot = tempConfigRoot()
    const file = keyFile(HOME, env({ XDG_CONFIG_HOME: configRoot }))
    storeApiKey('gsk_placeholder000000000000000', {
      env: env({ XDG_CONFIG_HOME: configRoot }),
    })
    writeFileSync(file, `${TEST_KEY}\n`)
    expect(readStoredKey(HOME, env({ XDG_CONFIG_HOME: configRoot }))?.key).toBe(
      TEST_KEY,
    )
  })
})

describe('redaction of Groq keys', () => {
  it('scrubs a Groq key wherever it appears', () => {
    expect(redact(`GROQ_API_KEY=${TEST_KEY}`)).not.toContain(TEST_KEY)
    expect(redact(`export GROQ_API_KEY=${TEST_KEY}`)).toContain('[redacted')
    expect(redact(`Authorization: Bearer ${TEST_KEY}`)).not.toContain(TEST_KEY)
    expect(redact(`the key is ${TEST_KEY} ok`)).toBe(
      'the key is [redacted token] ok',
    )
  })
})

describe('splitSseBuffer', () => {
  it('returns whole events and keeps the partial tail', () => {
    const { payloads, rest } = splitSseBuffer(
      'data: {"a":1}\n\ndata: {"b":2}\n\ndata: {"c":',
    )
    expect(payloads).toEqual(['{"a":1}', '{"b":2}'])
    expect(rest).toBe('data: {"c":')
  })

  it('handles CRLF line endings and keeps a following chunk intact', () => {
    const { payloads, rest } = splitSseBuffer('data: {"a":1}\r\n\r\n')
    expect(payloads).toEqual(['{"a":1}'])
    expect(rest).toBe('')
    const joined = splitSseBuffer(`${rest}data: {"b":2}\n\n`)
    expect(joined.payloads).toEqual(['{"b":2}'])
  })

  it('ignores comments, blank events and non-data fields', () => {
    const { payloads } = splitSseBuffer(
      ': keep-alive\n\n\n\nevent: message\ndata: [DONE]\n\n',
    )
    expect(payloads).toEqual(['[DONE]'])
  })
})

describe('deltaFromSsePayload', () => {
  it('reads one fragment of the answer', () => {
    expect(
      deltaFromSsePayload('{"choices":[{"delta":{"content":"Hello"}}]}'),
    ).toBe('Hello')
  })

  it('ignores the terminator, empty frames and malformed JSON', () => {
    expect(deltaFromSsePayload('[DONE]')).toBeNull()
    expect(
      deltaFromSsePayload('{"choices":[{"delta":{"role":"assistant"}}]}'),
    ).toBeNull()
    expect(
      deltaFromSsePayload('{"choices":[{"delta":{"content":""}}]}'),
    ).toBeNull()
    expect(deltaFromSsePayload('not json at all')).toBeNull()
  })
})

describe('answerFromBody', () => {
  it('reads a non-streamed answer', () => {
    expect(
      answerFromBody(
        JSON.stringify({
          choices: [{ message: { content: '  Run fbdoc check.  ' } }],
        }),
      ),
    ).toBe('Run fbdoc check.')
  })

  it('returns an empty string rather than throwing on nonsense', () => {
    expect(answerFromBody('<html>502</html>')).toBe('')
    expect(answerFromBody('{"choices":[]}')).toBe('')
  })
})

/** The shape of a real answer: prose, a fenced block and a numbered list. */
const SAMPLE_ANSWER = [
  'The diagnostics found five warnings.',
  'Below are the likely causes and the commands to paste into **cmd.exe**.',
  '',
  '```cmd',
  ':: 1. Update the global CLI',
  'npm i -g freebuff@latest',
  '',
  ':: 2. Remove superseded engine copies',
  'del "%USERPROFILE%\\.config\\manicode\\freebuff.exe.old.*"',
  '```',
  '',
  '## What each step does',
  '',
  '1. **global-install** — brings the CLI up to date.',
  '2. **cache-integrity** — deletes old engine binaries.',
  '',
  'Then re-run `fbdoc check` to confirm.',
].join('\n')

/** A real answer that answers in a table — the shape that used to print raw pipes. */
const TABLE_ANSWER = [
  'The diagnostics found two warnings.',
  '',
  '| Finding | What it means | Fix |',
  '| --- | --- | --- |',
  '| global-install | Your global CLI is out of date. | npm i -g freebuff@latest |',
  '| env-hygiene | A token sits in .npmrc. | Delete the authToken line. |',
  '',
  'Run `fbdoc check` again to confirm.',
].join('\n')

const PLAIN = { color: false, width: 80 } as const

function styled(markdown: string, width = 80): string {
  return renderAnswer(markdown, {
    color: true,
    colors: createColors(true),
    width,
  }).join('\n')
}

describe('AnswerRenderer', () => {
  it('renders emphasis and inline code instead of printing the markers', () => {
    const rendered = styled(
      'Paste this into **cmd.exe** and run `fbdoc check`.',
    )
    expect(rendered).not.toContain('**')
    expect(rendered).not.toContain('`')
    expect(rendered).toContain('\u001b[1m') // bold
    expect(rendered).toContain('\u001b[36m') // cyan inline code
  })

  it('styles a real answer end to end', () => {
    const lines = renderAnswer(SAMPLE_ANSWER, {
      color: true,
      colors: createColors(true),
      width: 80,
    })
    const text = lines.join('\n')

    // No raw markdown survives in the styled output.
    expect(text).not.toContain('**')
    expect(text).not.toContain('```')
    expect(text).not.toContain('##')

    // Headings become bold text with a rule underneath.
    expect(text).toContain('\u001b[1mWhat each step does\u001b[22m')
    expect(text).toContain('─')

    // Code is indented and kept verbatim, comments and all.
    expect(lines).toContain('  :: 1. Update the global CLI')
    expect(lines).toContain('  npm i -g freebuff@latest')

    // Blank lines only ever separate blocks.
    expect(lines[0]).not.toBe('')
    expect(lines.at(-1)).not.toBe('')
    expect(text).not.toMatch(/\n\n\n/)
  })

  it('strips every marker when colour is unavailable', () => {
    const lines = renderAnswer(SAMPLE_ANSWER, PLAIN)
    const text = lines.join('\n')
    expect(text).not.toContain('\u001b')
    expect(text).not.toContain('**')
    expect(text).not.toContain('```')
    expect(text).not.toContain('##')
    expect(lines).toContain('What each step does')
    expect(lines).toContain('  :: 1. Update the global CLI')
    expect(lines.at(-1)).toBe('Then re-run fbdoc check to confirm.')
  })

  it('turns list markers into bullets and keeps the text aligned', () => {
    const lines = renderAnswer('- first item\n- **second** item', {
      color: true,
      colors: createColors(true),
      width: 80,
    })
    expect(lines).toEqual([
      '\u001b[2m•\u001b[22m first item',
      '\u001b[2m•\u001b[22m \u001b[1msecond\u001b[22m item',
    ])
  })

  it('hangs numbered and bulleted list text under its marker', () => {
    const numbered = renderAnswer(
      `1. **Update the CLI** — ${'pulls the latest release so you are not '.repeat(3)}running an outdated version.`,
      { ...PLAIN, width: 60 },
    )
    expect(numbered[0]?.startsWith('1. Update the CLI')).toBe(true)
    for (const line of numbered.slice(1))
      expect(line.startsWith('   ')).toBe(true)

    const bulleted = renderAnswer(
      `- **First** ${'and some more words to force a wrap '.repeat(3)}here`,
      { ...PLAIN, width: 60 },
    )
    // In plain mode the original marker is kept rather than redrawn.
    expect(bulleted[0]?.startsWith('- First')).toBe(true)
    for (const line of bulleted.slice(1))
      expect(line.startsWith('  ')).toBe(true)
  })

  it('trims the double spaces markdown uses for a hard break', () => {
    expect(renderAnswer('ends here.  \nnext line', PLAIN)).toEqual([
      'ends here.',
      'next line',
    ])
  })

  it('wraps long prose to the width it was given', () => {
    const long = `word ${'filler '.repeat(40)}`
    const lines = renderAnswer(long.trim(), { ...PLAIN, width: 40 })
    expect(lines.length).toBeGreaterThan(1)
    for (const line of lines) expect(stringWidth(line)).toBeLessThanOrEqual(40)
  })

  it('gives identical output however the stream is chunked', () => {
    // The whole point: a fragment can split anywhere, including inside a fence
    // marker, an emphasis run, a table row, or a multi-byte character.
    for (const markdown of [SAMPLE_ANSWER, TABLE_ANSWER]) {
      const expected = renderAnswer(markdown, PLAIN)
      for (const size of [1, 2, 3, 5, 7, 11, 40, 500]) {
        const renderer = new AnswerRenderer(PLAIN)
        const lines: string[] = []
        const chunks = [...markdown]
        let index = 0
        while (index < chunks.length) {
          const fragment = chunks.slice(index, index + size).join('')
          lines.push(...renderer.push(fragment))
          index += size
        }
        lines.push(...renderer.flush())
        expect(lines, `chunk size ${size}`).toEqual(expected)
      }
    }
  })

  it('renders a markdown table as aligned columns, never raw pipe rows', () => {
    const lines = renderAnswer(TABLE_ANSWER, {
      color: true,
      colors: createColors(true),
      width: 80,
    })
    const text = lines.join('\n')

    // No row survives as its source form, and no separator row is printed.
    expect(text).not.toContain('| ---')
    expect(text).not.toMatch(/^\s*\|/m)
    expect(text).not.toContain('| Finding |')

    // It uses the FAQ's own table furniture instead: box separators, a bold
    // header and a rule under it.
    expect(text).toContain('\u001b[1mFinding\u001b[22m')
    expect(text).toContain('\u2502')
    expect(text).toContain('\u2500\u253c\u2500')

    // Each row is a single line, with its cells side by side.
    const row = lines.find((line) => line.includes('global-install'))
    expect(row).toContain('npm i -g freebuff@latest')
    expect(lines.find((line) => line.includes('env-hygiene'))).toContain(
      'Delete the authToken line.',
    )

    // It never overflows the width it was given.
    for (const line of lines) expect(stringWidth(line)).toBeLessThanOrEqual(80)
  })

  it('renders a plain table with separators but no escape codes', () => {
    const lines = renderAnswer(TABLE_ANSWER, PLAIN)
    const text = lines.join('\n')
    expect(text).not.toContain('\u001b')
    expect(text).not.toContain('| ---')
    expect(text).not.toMatch(/^\s*\|/m)
    expect(text).toContain('\u2502')
    expect(lines.some((line) => line.includes('global-install'))).toBe(true)
    expect(lines.at(-1)).toBe('Run fbdoc check again to confirm.')
  })

  it('renders a table that is still open when the stream ends', () => {
    const renderer = new AnswerRenderer(PLAIN)
    const lines = [
      ...renderer.push('| a | b |\n| --- | --- |\n| 1 | 2 |'),
      ...renderer.flush(),
    ]
    expect(lines).toHaveLength(3)
    expect(lines[2]).toContain('1')
    expect(lines[2]).toContain('2')
    expect(lines.join('\n')).toContain('\u2502')
  })

  it('prints a pipe run that is not a table as the prose it is', () => {
    // No separator row, so markdown would not treat this as a table either.
    expect(renderAnswer('| nothing | to see |\n| here |', PLAIN)).toEqual([
      '| nothing | to see |',
      '| here |',
    ])
    expect(renderAnswer('| alone |', PLAIN)).toEqual(['| alone |'])
  })

  it('renders a final line that arrived without a newline', () => {
    const renderer = new AnswerRenderer(PLAIN)
    expect(renderer.push('no trailing newline')).toEqual([])
    expect(renderer.flush()).toEqual(['no trailing newline'])
  })

  it('holds back blank lines so the answer never starts or ends with one', () => {
    expect(renderAnswer('\n\nHello\n\n\n', PLAIN)).toEqual(['Hello'])
    expect(renderAnswer('Hello\n\n\nWorld\n', PLAIN)).toEqual([
      'Hello',
      '',
      'World',
    ])
  })

  it('keeps code lines intact even when they are longer than the terminal', () => {
    const command = `del "${'x'.repeat(120)}"`
    const lines = renderAnswer(`\`\`\`cmd\n${command}\n\`\`\``, PLAIN)
    expect(lines).toEqual([`  ${command}`])
  })

  it('leaves no trailing whitespace on blank lines inside code', () => {
    const lines = renderAnswer('\`\`\`cmd\na\n\nb\n\`\`\`', PLAIN)
    expect(lines).toEqual(['  a', '', '  b'])
    expect(lines.some((line) => line !== line.trimEnd())).toBe(false)
  })

  it('never prints a fence marker, even an unterminated one', () => {
    const lines = renderAnswer('\`\`\`cmd\nstill going', PLAIN)
    expect(lines).toEqual(['  still going'])
    const renderer = new AnswerRenderer(PLAIN)
    renderer.push('\`\`\`cmd\n')
    expect(renderer.inFence).toBe(true)
  })
})

describe('sanitizeText', () => {
  it('keeps the characters an answer is allowed to have', () => {
    expect(sanitizeText('Run this:\n\tnpm i -g freebuff@latest\n')).toBe(
      'Run this:\n\tnpm i -g freebuff@latest\n',
    )
  })

  it('turns a carriage return into a newline instead of overwriting the line', () => {
    expect(sanitizeText('windows\r\nlines')).toBe('windows\nlines')
    expect(sanitizeText('overwritten\rrest survived\n')).toBe(
      'overwritten\nrest survived\n',
    )
  })

  it('strips escape sequences so a model cannot scramble the terminal', () => {
    // Exactly what the answer used to do to a console that honours these:
    // erase the line, jump to the start, then print on top of the user's text.
    expect(sanitizeText('\u001b[2K\u001b[1Gclean')).toBe('clean')
    expect(sanitizeText('\u001b[?2026h\u001b[31mred\u001b[0m')).toBe('red')
    expect(
      sanitizeText('\u001b]8;;https://x.test\u0007label\u001b]8;;\u0007'),
    ).toBe('label')
    expect(sanitizeText('before\u0007after')).toBe('beforeafter')
  })
})

describe('describeFailure', () => {
  const body = JSON.stringify({
    error: { message: 'Invalid API Key', type: 'invalid_request_error' },
  })

  it('explains a rejected key and where to get a new one', () => {
    const failure = describeFailure(401, body)
    expect(failure.message).toContain('rejected the API key')
    expect(failure.message).toContain('Invalid API Key')
    expect(failure.hint).toContain('console.groq.com/keys')
  })

  it('explains rate limits, oversize requests and Groq outages', () => {
    expect(describeFailure(429, body).hint).toMatch(/wait a moment/i)
    expect(describeFailure(429, body).message).toMatch(/rate limiting/i)
    expect(describeFailure(413, '').hint).toContain('--no-checks')
    expect(describeFailure(503, '').message).toMatch(/server error/i)
    expect(describeFailure(503, '').hint).toMatch(/try again/i)
  })

  it('explains a missing model in terms of this build', () => {
    const failure = describeFailure(404, '')
    expect(failure.message).toContain(AI_MODEL)
    expect(failure.hint).toMatch(/update freebuff-doctor/i)
  })

  it('says something useful for an unexpected status', () => {
    expect(describeFailure(418, '').message).toContain('HTTP 418')
  })

  it('extracts a single-line server message', () => {
    expect(serverMessage(body)).toBe('Invalid API Key')
    expect(serverMessage('not json')).toBeNull()
    expect(serverMessage('{}')).toBeNull()
  })
})

/** A fake `fetch` that records what was sent and replays a canned response. */
function recordingFetch(response: Response | (() => Response)): {
  fetchImpl: typeof fetch
  requests: Array<{ url: string; init: RequestInit }>
} {
  const requests: Array<{ url: string; init: RequestInit }> = []
  const fetchImpl = (async (url: unknown, init: unknown) => {
    requests.push({ url: String(url), init: (init ?? {}) as RequestInit })
    return typeof response === 'function' ? response() : response
  }) as unknown as typeof fetch
  return { fetchImpl, requests }
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  })
}

function sseResponse(frames: string[]): Response {
  const encoder = new TextEncoder()
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const frame of frames) controller.enqueue(encoder.encode(frame))
      controller.close()
    },
  })
  return new Response(body, {
    status: 200,
    headers: { 'content-type': 'text/event-stream' },
  })
}

const MESSAGES = [{ role: 'user' as const, content: 'why is it broken?' }]

describe('chat', () => {
  it('posts to Groq with the pinned model and returns the answer', async () => {
    const { fetchImpl, requests } = recordingFetch(
      jsonResponse({
        choices: [{ message: { content: 'Run `npm i -g freebuff@latest`.' } }],
      }),
    )

    const answer = await chat({
      apiKey: TEST_KEY,
      messages: MESSAGES,
      fetchImpl,
    })

    expect(answer).toBe('Run `npm i -g freebuff@latest`.')
    const request = requests[0]
    expect(request?.url).toBe('https://api.groq.com/openai/v1/chat/completions')
    const sent = JSON.parse(String(request?.init.body)) as {
      model: string
      stream: boolean
      messages: unknown
    }
    expect(sent.model).toBe(AI_MODEL)
    expect(sent.stream).toBe(false)
    expect(sent.messages).toEqual(MESSAGES)

    const headers = request?.init.headers as Record<string, string>
    expect(headers.authorization).toBe(`Bearer ${TEST_KEY}`)
    // The key travels in the header only — never in the body a report might quote.
    expect(String(request?.init.body)).not.toContain(TEST_KEY)
  })

  it('streams every fragment in order when given a callback', async () => {
    const frames = [
      'data: {"choices":[{"delta":{"role":"assistant"}}]}\n\n',
      'data: {"choices":[{"delta":{"content":"First "}}]}\n\n',
      'data: {"choices":[{"delta":{"content":"second."}}]}\n\n',
      'data: [DONE]\n\n',
    ]
    // Split across chunk boundaries to prove the buffer reassembles events.
    const encoder = new TextEncoder()
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        const joined = frames.join('')
        controller.enqueue(encoder.encode(joined.slice(0, 24)))
        controller.enqueue(encoder.encode(joined.slice(24, 40)))
        controller.enqueue(encoder.encode(joined.slice(40)))
        controller.close()
      },
    })
    const { fetchImpl, requests } = recordingFetch(
      new Response(stream, { status: 200 }),
    )

    const fragments: string[] = []
    const answer = await chat(
      { apiKey: TEST_KEY, messages: MESSAGES, fetchImpl },
      (delta) => fragments.push(delta),
    )

    expect(fragments).toEqual(['First ', 'second.'])
    expect(answer).toBe('First second.')
    const sent = JSON.parse(String(requests[0]?.init.body)) as {
      stream: boolean
    }
    expect(sent.stream).toBe(true)
  })

  it('never hands a control character to the renderer', async () => {
    const frames = [
      'data: {"choices":[{"delta":{"content":"safe "}}]}\n\n',
      'data: {"choices":[{"delta":{"content":"\\u001b[2K\\u001b[1G\\rbroken"}}]}\n\n',
      'data: [DONE]\n\n',
    ]
    const { fetchImpl } = recordingFetch(sseResponse(frames))

    const fragments: string[] = []
    const answer = await chat(
      { apiKey: TEST_KEY, messages: MESSAGES, fetchImpl },
      (delta) => fragments.push(delta),
    )

    expect(fragments.join('')).toBe('safe \nbroken')
    expect(answer).toBe('safe \nbroken')
    expect(fragments.join('')).not.toMatch(
      /[\u0000-\u0008\u000b\u000c\u000e-\u001f]/,
    )
  })

  it('throws an actionable error when Groq rejects the key', async () => {
    const { fetchImpl } = recordingFetch(
      jsonResponse({ error: { message: 'Invalid API Key' } }, 401),
    )
    await expect(
      chat({ apiKey: 'gsk_bad', messages: MESSAGES, fetchImpl }),
    ).rejects.toMatchObject({ name: 'AiError', status: 401 })
  })

  it('turns an unreachable network into advice about proxies', async () => {
    const fetchImpl = (async () => {
      throw new TypeError('fetch failed')
    }) as unknown as typeof fetch

    const error = await chat({
      apiKey: TEST_KEY,
      messages: MESSAGES,
      fetchImpl,
    })
      .then(() => null)
      .catch((caught: unknown) => caught as AiError)

    expect(error).toBeInstanceOf(AiError)
    expect(error?.message).toContain('Could not reach Groq')
    expect(error?.hint).toContain('HTTPS_PROXY')
  })

  it('reports a deadline as a deadline, not a crash', async () => {
    const fetchImpl = (async () => {
      const error = new Error('The operation was aborted')
      error.name = 'TimeoutError'
      throw error
    }) as unknown as typeof fetch

    const error = await chat({
      apiKey: TEST_KEY,
      messages: MESSAGES,
      fetchImpl,
    })
      .then(() => null)
      .catch((caught: unknown) => caught as AiError)
    expect(error?.message).toContain('did not answer in time')
  })

  it('refuses to guess when an answer cannot be read', async () => {
    const { fetchImpl } = recordingFetch(new Response('<html>nope</html>'))
    await expect(
      chat({ apiKey: TEST_KEY, messages: MESSAGES, fetchImpl }),
    ).rejects.toThrow(/could not read/)
  })
})

function makeResult(overrides: Partial<CheckResult> = {}): CheckResult {
  return {
    id: 'global-install',
    title: 'Global Freebuff CLI install',
    status: 'warn',
    message: 'freebuff 0.0.118 is behind the latest release.',
    durationMs: 12,
    ...overrides,
  }
}

function makeContext(results: CheckResult[]) {
  const paths = resolvePlatformPaths(HOME, env(), 'linux')
  return {
    results,
    summary: summarize(results),
    environment: collectSnapshot(
      {
        PATH: [`${HOME}/bin`, '/usr/bin'].join(path.delimiter),
        NODE_OPTIONS: '--max-old-space-size=4096',
      } as NodeJS.ProcessEnv,
      { home: HOME, npmVersion: '11.6.2' },
    ),
    paths,
    home: HOME,
    doctorVersion: '0.5.0',
    platform: 'linux (x64)',
    nodeVersion: 'v24.13.0',
    offline: false,
  }
}

describe('buildFindings', () => {
  it('says so plainly when the diagnostics have not been run', () => {
    const findings = buildFindings([], summarize([]))
    expect(findings).toContain('have not been run')
    expect(findings).toContain('fbdoc check')
  })

  it('lists failures before warnings and carries the fix, FAQ and detail', () => {
    const failure = makeResult({
      id: 'dns',
      title: 'DNS resolution',
      status: 'fail',
      message: 'freebuff.com did not resolve.',
      details: ['resolver: 192.168.1.1'],
      fix: 'Set your DNS servers to 1.1.1.1 and 8.8.8.8.',
      faqSlug: 'network-issues',
    })
    const warning = makeResult()
    const findings = buildFindings(
      [warning, failure],
      summarize([warning, failure]),
    )

    expect(findings).toContain('2 checks: 0 passed, 1 warning(s), 1 failed')
    expect(findings.indexOf('[fail] dns')).toBeLessThan(
      findings.indexOf('[warn] global-install'),
    )
    expect(findings).toContain('    detail: resolver: 192.168.1.1')
    expect(findings).toContain('    suggested fix: Set your DNS servers')
    expect(findings).toContain('faq.md#network-issues')
    expect(findings).toContain('this check looks at:')
  })

  it('says the machine looks healthy when nothing warned', () => {
    const clean = makeResult({ status: 'pass', message: 'All good.' })
    const findings = buildFindings([clean], summarize([clean]))
    expect(findings).toContain('looks healthy')
    expect(findings).toContain('Passed or skipped, by id: global-install')
  })

  it('caps the findings and admits what it dropped', () => {
    const many = Array.from({ length: 40 }, (_, index) =>
      makeResult({
        id: `check-${index}`,
        title: `Check ${index}`,
        message: 'x'.repeat(120),
      }),
    )
    const findings = buildFindings(many, summarize(many), 600)
    expect(findings.length).toBeLessThan(1_500)
    expect(findings).toMatch(/further finding\(s\) omitted/)
  })
})

describe('buildSystemPrompt', () => {
  const result = makeResult({ status: 'fail' })
  const prompt = buildSystemPrompt(makeContext([result]))

  it('names the assistant, the provider and the pinned model', () => {
    expect(prompt).toContain('Freebuff Doctor')
    expect(prompt).toContain(`You are running as ${AI_MODEL} on Groq.`)
  })

  it('carries the run, the machine and the environment', () => {
    expect(prompt).toContain('This machine')
    expect(prompt).toContain('Platform: linux (x64)')
    expect(prompt).toContain('Node: v24.13.0')
    expect(prompt).toContain('NODE_OPTIONS=--max-old-space-size=4096')
    expect(prompt).toContain(`${HOME}/bin`.replace(HOME, '~'))
    expect(prompt).toContain('- CLI state')
  })

  it('hands the model the Freebuff FAQ and the check catalogue', () => {
    expect(prompt).toContain('## Freebuff knowledge')
    // What the FAQ covers, so it never claims to know nothing about Freebuff.
    expect(prompt).toContain('What the bundled FAQ covers')
    expect(prompt).toContain('Network Issues')
    expect(prompt).toContain('Freebucks Refunds')
    // What each check looks at, so it can explain any of them.
    expect(prompt).toContain('What fbdoc checks')
    expect(prompt).toContain('- global-install —')

    // A finding that names an FAQ section gets its text quoted, not summarised.
    const withSlug = buildSystemPrompt(
      makeContext([makeResult({ status: 'fail', faqSlug: 'network-issues' })]),
    )
    expect(withSlug).toContain('FAQ sections behind this run')
    expect(withSlug).toContain('#### Network Issues')
  })

  it('sends the FAQ section a follow-up is about, and nothing for an empty question', () => {
    const message = buildKnowledgeMessage(
      'how do I get my project URL?',
      [],
      HOME,
    )
    expect(message).toContain('#### Getting Your Project URL')
    expect(message).toMatch(/fbdoc faq/)
    expect(buildKnowledgeMessage('', [], HOME)).toBeNull()
  })

  it('tells the model to stay short, honest and offline', () => {
    expect(prompt).toMatch(/the only authority on Freebuff here/i)
    expect(prompt).toMatch(/say so instead of guessing/)
    expect(prompt).toMatch(/never put your own wording inside a quote/)
    expect(prompt).toMatch(/You cannot run anything/)
    expect(prompt).toMatch(/fbdoc export/)
  })

  it('asks for plain ASCII and short table cells the console can render', () => {
    expect(prompt).toMatch(/never use emoji/i)
    expect(prompt).toMatch(/empty box/i)
    expect(prompt).toMatch(/keep every cell to a few words/i)
  })

  it('never hands a secret or a home directory to a third party', () => {
    const leaky = makeResult({
      id: 'auth-session',
      status: 'fail',
      message: `stored credential ${TEST_KEY} in ${HOME}/.config/manicode`,
      fix: `cat ${HOME}/.config/manicode/credentials.json`,
    })
    const safe = buildSystemPrompt(makeContext([leaky]))
    expect(safe).not.toContain(TEST_KEY)
    expect(safe).not.toContain('gsk_')
    // The model is told a value was hidden rather than being left to wonder.
    expect(safe).toContain('[redacted token]')
    expect(safe.replace(/\\/g, '/')).toContain('~/.config/manicode')
    expect(safe).not.toContain(HOME)
  })
})

describe('Freebuff knowledge', () => {
  it('lists every FAQ section it can be asked about', () => {
    const index = faqIndex()
    expect(index).toContain('Network Issues')
    expect(index).toContain('Freebucks Refunds')
    expect(index).toContain('Getting Your Project URL')
    // The official docs are part of the knowledge too, not just the community FAQ.
    expect(index).toMatch(/codebuff\.com\/docs/)
    expect(index).not.toMatch(/further sections: run/i)
  })

  it('catalogues every check with what it looks at and why it matters', () => {
    const catalogue = checkCatalogue()
    for (const id of ['node-runtime', 'global-install', 'cache-integrity']) {
      expect(catalogue).toContain(`- ${id} —`)
    }
    expect(catalogue).toContain('Why it matters:')
    expect(catalogue).toContain('FAQ:')
    // Nothing is dropped for want of budget: an unknown check would invite a guess.
    expect(catalogue).not.toMatch(/further checks/)
  })

  it('quotes the FAQ sections a question is about, verbatim', () => {
    const turn = buildTurnKnowledge('how do I get my project URL?')
    expect(turn).toContain('#### Getting Your Project URL')
    // The body, not the model's memory of it.
    const section = allSections().find(
      (candidate) => candidate.title === 'Getting Your Project URL',
    )
    expect(section).toBeTruthy()
    expect(turn).toContain((section?.body ?? '').split('\n')[0] ?? '')
  })

  it('names the section behind a finding', () => {
    const turn = buildTurnKnowledge('anything at all', [
      makeResult({ faqSlug: 'freebucks-refunds' }),
    ])
    expect(turn).toContain('#### Freebucks Refunds')
  })

  it('says nothing, rather than guessing, when the FAQ has nothing to offer', () => {
    expect(buildTurnKnowledge('')).toBeNull()
  })

  it('keeps the standing knowledge inside its budget', () => {
    const knowledge = buildKnowledge([
      makeResult({ status: 'fail', faqSlug: 'crash-on-start--updating' }),
      makeResult({ id: 'dns', status: 'warn', faqSlug: 'network-issues' }),
    ])
    expect(knowledge.length).toBeLessThanOrEqual(MAX_KNOWLEDGE_CHARS)
    expect(knowledge).toContain('What the bundled FAQ covers')
    expect(knowledge).toContain('What fbdoc checks')
    expect(knowledge).toContain('FAQ sections behind this run')
    // Small enough to leave the free tier's minute to the answer itself.
    expect(estimateTokens(knowledge)).toBeLessThan(3_200)
  })
})

describe('grounding check', () => {
  const material = [
    'The bundled FAQ says:',
    '',
    '#### Getting Your Project URL',
    '',
    'There is no "share" button, so you will need to copy the URL manually.',
    '',
    '1. Open your Freebuff web/cloud project.',
    '2. Copy the address bar URL — it will look like `https://freebuff.com/{web/cloud}/project/{random-words}`.',
    '',
    'Then answer this question:',
    '',
    'how do I get my project URL?',
  ].join('\n')

  it('flags the commands a small model invents', () => {
    // Both of these came out of a real run, with the FAQ quoted above it.
    expect(
      unsupportedClaims('Run `fb project list` and pick an id.', material),
    ).toEqual(['fb project list'])
    expect(
      unsupportedClaims(
        'Use `freebuff project url <project-name>` to print it.',
        material,
      ),
    ).toEqual(['freebuff project url <project-name>'])
    expect(
      unsupportedClaims(
        'Select the project and click the Share button, then run:\n\n    npm i -g freebuff@latest\n',
        material,
      ),
    ).toEqual(['npm i -g freebuff@latest'])
  })

  it('accepts what the material actually says', () => {
    const good = [
      'The FAQ is clear that there is no "share" button:',
      '',
      '1. Open your Freebuff web/cloud project.',
      '2. Copy the address bar URL — it will look like',
      '   `https://freebuff.com/{web/cloud}/project/{random-words}`.',
      '',
      'Read it with `fbdoc faq "Getting Your Project URL"`.',
    ].join('\n')
    expect(unsupportedClaims(good, material)).toEqual([])
  })

  it('never flags fbdoc itself, whose commands the prompt documents', () => {
    expect(
      unsupportedClaims(
        'Run `fbdoc export` and `fbdoc check --only dns`, or `fbdoc faq "Network Issues"`.',
        material,
      ),
    ).toEqual([])
  })

  it('sees a command through fancy quotes and dashes', () => {
    const dashed =
      '#### Something\n\ndel "%USERPROFILE%\\.config\\manicode\\*.old.*" works.'
    expect(
      unsupportedClaims(
        'Run `del "%USERPROFILE%\\.config\\manicode\\*.old.*"`.',
        dashed,
      ),
    ).toEqual([])
    expect(
      commandClaims('Use `git config --global core.longpaths true`.'),
    ).toEqual(['git config --global core.longpaths true'])
  })

  it('notices an answer that asks instead of telling, or pleads ignorance', () => {
    // Both of these came out of real runs with the answer quoted in the turn.
    expect(
      claimsIgnorance(
        "I'm not sure which URL you're looking for. Do you want the link to the project on the Freebuff website, or the local path?",
      ),
    ).toBe(true)
    expect(
      claimsIgnorance(
        "I don't have any information about refunds for unused Freebuff credits.",
      ),
    ).toBe(true)
    expect(claimsIgnorance('The FAQ does not cover that question.')).toBe(true)
  })

  it('does not mistake a real answer for ignorance', () => {
    const answer = [
      'To get your project URL, follow the steps in the FAQ "Getting Your Project URL":',
      '',
      '1. Open your Freebuff web or cloud project.',
      '2. Copy the address bar URL.',
    ].join('\n')
    expect(claimsIgnorance(answer)).toBe(false)
    expect(
      claimsIgnorance(
        'Run `npm i -g freebuff@latest` and then re-run fbdoc check.',
      ),
    ).toBe(false)
  })

  it('recovers the quoted sections and the question from the turn', () => {
    const sections = quotedSections(material)
    expect(sections.map((section) => section.title)).toEqual([
      'Getting Your Project URL',
    ])
    expect(sections[0]?.body).toContain('no "share" button')
    // The question is not swallowed into the last section.
    expect(sections[0]?.body).not.toContain('how do I get my project URL?')
  })
})

describe('groundingNotice', () => {
  const question = 'how do I get my project URL?'
  const knowledge = buildTurnKnowledge(question)
  const messages: ChatMessage[] = [
    {
      role: 'user',
      content: `${knowledge ?? ''}\n\nThen answer this question:\n\n${question}`,
    },
  ]

  it('prints the FAQ text when the answer asks instead of answering', () => {
    const notice = groundingNotice(
      "I'm not sure which URL you're looking for — the website link, or a local path?",
      messages,
    )
    const text = notice.join('\n')
    expect(text).toMatch(/does answer this/)
    // The section that was quoted, with its body — the actual FAQ wording.
    expect(text).toContain('Getting Your Project URL')
    expect(text).toContain('address bar URL')
    expect(text).toContain('fbdoc faq "Getting Your Project URL"')
  })

  it('prints the FAQ text when the answer invents a command', () => {
    const notice = groundingNotice(
      'Run `fb project list` and take the id.',
      messages,
    )
    const text = notice.join('\n')
    expect(text).toContain('Not in the FAQ')
    expect(text).toContain('fb project list')
    expect(text).toContain('address bar URL')
  })

  it('says nothing when the answer came from the FAQ', () => {
    const answer = [
      'The FAQ answers this directly:',
      '',
      '1. Open your Freebuff web/cloud project.',
      '2. Copy the address bar URL.',
      '',
      'Read it with `fbdoc faq "Getting Your Project URL"`.',
    ].join('\n')
    expect(groundingNotice(answer, messages)).toEqual([])
  })
})

describe('fitMessages', () => {
  const system: ChatMessage = { role: 'system', content: 'the standing prompt' }

  it('leaves a conversation that fits alone', () => {
    const messages: ChatMessage[] = [
      system,
      { role: 'user', content: 'hello' },
      { role: 'assistant', content: 'hi' },
      { role: 'user', content: 'again' },
    ]
    expect(fitMessages(messages)).toBe(messages)
  })

  it('drops the oldest turns and keeps the prompt and the question', () => {
    const messages: ChatMessage[] = [system]
    for (let turn = 0; turn < 40; turn += 1) {
      messages.push({ role: 'user', content: `question ${turn} `.repeat(200) })
      messages.push({
        role: 'assistant',
        content: `answer ${turn} `.repeat(200),
      })
    }
    messages.push({ role: 'user', content: 'the one being asked now' })

    const fitted = fitMessages(messages)
    expect(fitted[0]).toBe(system)
    expect(fitted.at(-1)?.content).toBe('the one being asked now')
    expect(fitted.length).toBeLessThan(messages.length)
    const tokens = fitted.reduce(
      (sum, message) => sum + estimateTokens(message.content),
      0,
    )
    expect(tokens).toBeLessThanOrEqual(MAX_REQUEST_TOKENS + 64)
  })
})

describe('buildUserMessage', () => {
  it('redacts a question before it is sent', () => {
    expect(buildUserMessage(`use ${TEST_KEY} please`, HOME)).not.toContain(
      TEST_KEY,
    )
    expect(
      buildUserMessage(`my config is at ${HOME}/.config/manicode`, HOME),
    ).toContain('~/.config/manicode')
  })

  it('trims whitespace', () => {
    expect(buildUserMessage('  hello  ', HOME)).toBe('hello')
  })
})

describe('the menu button', () => {
  it('offers the Groq assistant, in a menu that still has every destination', () => {
    const entry = MENU_CHOICES.find((choice) => choice.value === 'ai')
    expect(entry?.name).toBe('Connect Groq API for AI assistance')
    expect(entry?.description).toMatch(/gpt-oss-20b/)
    expect(entry?.description).toMatch(/diagnostics/i)

    expect(MENU_CHOICES.map((choice) => choice.value)).toEqual([
      'check',
      'faq',
      'wizard',
      'ai',
      'export',
      'report',
      'quit',
    ])
    expect(MENU_CHOICES.at(-1)?.value).toBe('quit')
    expect(MENU_CHOICES.every((choice) => choice.name.length > 0)).toBe(true)
  })
})

describe('aiTimeoutMs', () => {
  it('keeps the assistant deadline for the default --timeout', () => {
    expect(aiTimeoutMs({ timeoutMs: 8000 })).toBe(DEFAULT_AI_TIMEOUT_MS)
  })

  it('honours a longer --timeout', () => {
    expect(aiTimeoutMs({ timeoutMs: 120_000 })).toBe(120_000)
  })
})
