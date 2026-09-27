const DEFAULT_REGISTRY = 'https://registry.npmjs.org'

export interface ProbeResult {
  ok: boolean
  status: number | null
  durationMs: number
  error?: string
}

/** Performs a lightweight GET and reports reachability without reading the body. */
export async function probe(
  url: string,
  timeoutMs = 8000,
): Promise<ProbeResult> {
  const started = Date.now()
  try {
    const response = await fetch(url, {
      method: 'GET',
      redirect: 'follow',
      headers: { 'user-agent': 'freebuff-doctor', accept: '*/*' },
      signal: AbortSignal.timeout(timeoutMs),
    })
    const durationMs = Date.now() - started
    // Release the socket; we only care that the request completed.
    await response.body?.cancel().catch(() => undefined)
    return { ok: response.ok, status: response.status, durationMs }
  } catch (error) {
    return {
      ok: false,
      status: null,
      durationMs: Date.now() - started,
      error: describeNetworkError(error),
    }
  }
}

/** Maps fetch/undici errors onto something a user can act on. */
export function describeNetworkError(error: unknown): string {
  const shaped = error as
    { code?: unknown; cause?: { code?: unknown } } | null | undefined
  const rawCode = shaped?.code ?? shaped?.cause?.code
  const code = typeof rawCode === 'string' ? rawCode : undefined
  const message = error instanceof Error ? error.message : String(error)
  switch (code) {
    case 'ENOTFOUND':
      return 'DNS lookup failed'
    case 'ECONNREFUSED':
      return 'connection refused (blocked by firewall or proxy?)'
    case 'ECONNRESET':
      return 'connection reset (interfered with mid-request)'
    case 'ETIMEDOUT':
      return 'timed out'
    case 'CERT_HAS_EXPIRED':
    case 'UNABLE_TO_VERIFY_LEAF_SIGNATURE':
      return 'TLS certificate rejected (a proxy may be intercepting traffic)'
    case 'UND_ERR_CONNECT_TIMEOUT':
      return 'timed out while connecting'
    default:
      if (/aborted|timeout/i.test(message)) return 'timed out'
      return message.split('\n')[0] ?? 'request failed'
  }
}

const latestCache = new Map<string, Promise<string | null>>()

/** Latest published version of an npm package, or `null` when unavailable. */
export function fetchLatestVersion(
  name: string,
  options: { timeoutMs?: number; registry?: string } = {},
): Promise<string | null> {
  const registry =
    options.registry ?? process.env.FBDOC_REGISTRY ?? DEFAULT_REGISTRY
  const key = `${registry}/${name}`
  const cached = latestCache.get(key)
  if (cached) return cached

  const request = (async (): Promise<string | null> => {
    try {
      const response = await fetch(`${registry}/${name}/latest`, {
        headers: {
          'user-agent': 'freebuff-doctor',
          accept: 'application/json',
        },
        signal: AbortSignal.timeout(options.timeoutMs ?? 8000),
      })
      if (!response.ok) return null
      const payload = (await response.json()) as { version?: unknown }
      return typeof payload.version === 'string' ? payload.version : null
    } catch {
      return null
    }
  })()

  latestCache.set(key, request)
  return request
}

/** Clears memoised registry lookups. Used by tests. */
export function resetRegistryCache(): void {
  latestCache.clear()
}
