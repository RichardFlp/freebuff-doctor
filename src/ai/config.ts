import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { resolvePlatformPaths } from '../util/platform.js'

/** The one provider the assistant talks to. */
export const GROQ_API_BASE = 'https://api.groq.com/openai/v1'

/**
 * The model every request uses. Pinned rather than configurable, so an answer
 * can be reproduced and so the tool only ever reaches models Groq serves to
 * everyone.
 */
export const AI_MODEL = 'openai/gpt-oss-20b'

/** The variable users are told to set when they would rather not save a key. */
export const API_KEY_ENV = 'GROQ_API_KEY'

export const KEY_SIGNUP_URL = 'https://console.groq.com/keys'

/** Where a key pasted into the menu is remembered. */
export function keyFile(
  home: string = os.homedir(),
  env: NodeJS.ProcessEnv = process.env,
): string {
  const { configRoot } = resolvePlatformPaths(home, env)
  return path.join(configRoot, 'freebuff-doctor', 'groq.json')
}

/** Groq keys are `gsk_` followed by a long random tail. */
export function looksLikeApiKey(value: string | undefined | null): boolean {
  return /^gsk_[A-Za-z0-9]{20,}$/.test((value ?? '').trim())
}

/**
 * `gsk_fake…TEST` — enough to tell two keys apart in a status line, not enough
 * to be worth pasting anywhere. Only ever used for display.
 */
export function maskApiKey(value: string): string {
  const trimmed = value.trim()
  if (trimmed.length <= 13) return '••••'
  return `${trimmed.slice(0, 8)}…${trimmed.slice(-4)}`
}

export interface ApiKeySource {
  key: string
  /** Where the key came from, so the reader can be told what is being used. */
  source: 'env' | 'file'
  /** The file it was read from, or the file an env var would be superseded by. */
  file: string
}

/** Reads a key out of the saved JSON, or out of a plain-text file. */
function extractKey(raw: string): string | null {
  const text = raw.trim()
  if (!text) return null
  if (text.startsWith('{')) {
    try {
      const parsed = JSON.parse(text) as { apiKey?: unknown; key?: unknown }
      const value =
        typeof parsed.apiKey === 'string'
          ? parsed.apiKey
          : typeof parsed.key === 'string'
            ? parsed.key
            : null
      return value?.trim() || null
    } catch {
      return null
    }
  }
  return text
}

/** The saved key, or `null` when there is no readable one. */
export function readStoredKey(
  home: string = os.homedir(),
  env: NodeJS.ProcessEnv = process.env,
): ApiKeySource | null {
  const file = keyFile(home, env)
  let raw: string
  try {
    raw = fs.readFileSync(file, 'utf8')
  } catch {
    return null
  }
  const key = extractKey(raw)
  if (!key) return null
  return { key, source: 'file', file }
}

/**
 * Resolves the key to use: `GROQ_API_KEY` wins, then the saved file. Returns
 * `null` when neither is present, which is the caller's cue to ask.
 */
export function resolveApiKey(
  options: { home?: string; env?: NodeJS.ProcessEnv } = {},
): ApiKeySource | null {
  const home = options.home ?? os.homedir()
  const env = options.env ?? process.env
  const fromEnv = env[API_KEY_ENV]?.trim()
  if (fromEnv) {
    return { key: fromEnv, source: 'env', file: keyFile(home, env) }
  }
  return readStoredKey(home, env)
}

/**
 * Saves a key with owner-only permissions, creating the directory if needed.
 * Returns the path written, or `null` when the filesystem refused.
 */
export function storeApiKey(
  key: string,
  options: { home?: string; env?: NodeJS.ProcessEnv } = {},
): string | null {
  const file = keyFile(options.home, options.env)
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 })
    fs.writeFileSync(
      file,
      `${JSON.stringify({ provider: 'groq', model: AI_MODEL, apiKey: key.trim() }, null, 2)}\n`,
      { encoding: 'utf8', mode: 0o600 },
    )
    // A file that already existed keeps its old mode, so tighten it explicitly.
    try {
      fs.chmodSync(file, 0o600)
    } catch {
      /* Windows has no POSIX mode; the write still succeeded */
    }
    return file
  } catch {
    return null
  }
}

/** Deletes the saved key. Returns false when there was nothing to delete. */
export function clearStoredKey(
  options: { home?: string; env?: NodeJS.ProcessEnv } = {},
): boolean {
  try {
    fs.rmSync(keyFile(options.home, options.env))
    return true
  } catch {
    return false
  }
}
