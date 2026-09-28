import { mkdtempSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'

import { aiTimeoutMs } from '../src/commands/ai.js'
import { DEFAULT_AI_TIMEOUT_MS } from '../src/ai/client.js'
import {
  AiError,
  answerFromBody,
  chat,
  deltaFromSsePayload,
  describeFailure,
  sanitizeText,
  serverMessage,
  splitSseBuffer,
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
  buildSystemPrompt,
  buildUserMessage,
} from '../src/ai/prompt.js'
import { createColors } from 'picocolors'

import { AnswerRenderer, renderAnswer } from '../src/ai/render.js'
import { MENU_CHOICES } from '../src/commands/menu.js'
import type { CheckResult } from '../src/checks/types.js'
import { summarize } from '../src/checks/types.js'
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
    // marker, an emphasis run, or a multi-byte character.
    const expected = renderAnswer(SAMPLE_ANSWER, PLAIN)
    for (const size of [1, 2, 3, 5, 7, 11, 40, 500]) {
      const renderer = new AnswerRenderer(PLAIN)
      const lines: string[] = []
      const chunks = [...SAMPLE_ANSWER]
      let index = 0
      while (index < chunks.length) {
        const fragment = chunks.slice(index, index + size).join('')
        lines.push(...renderer.push(fragment))
        index += size
      }
      lines.push(...renderer.flush())
      expect(lines, `chunk size ${size}`).toEqual(expected)
    }
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

  it('tells the model to stay short, honest and offline', () => {
    expect(prompt).toMatch(/Never invent a Freebuff flag/)
    expect(prompt).toMatch(/You cannot run anything/)
    expect(prompt).toMatch(/fbdoc export/)
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
