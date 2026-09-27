import { probe } from '../util/registry.js'
import { found, type CheckContext, type DiagnosticCheck } from './types.js'

const TARGETS = {
  api: 'https://freebuff.com/',
  registry: 'https://registry.npmjs.org/',
} as const

const PROXY_VARIABLES = [
  'HTTPS_PROXY',
  'https_proxy',
  'HTTP_PROXY',
  'http_proxy',
  'ALL_PROXY',
  'all_proxy',
] as const

/** Discovers proxy configuration, which Freebuff can be blocked or flagged for. */
export function detectProxy(
  env: NodeJS.ProcessEnv,
): { variable: string; value: string } | null {
  for (const variable of PROXY_VARIABLES) {
    const value = env[variable]?.trim()
    if (value) return { variable, value }
  }
  return null
}

/** Reaches Freebuff's domain and the npm registry, and reports proxy usage. */
export const networkCheck: DiagnosticCheck = {
  id: 'network',
  title: 'Network reachability',
  async run(context: CheckContext) {
    if (context.offline) {
      return found({
        status: 'skip',
        message: 'Skipped because --offline was requested.',
      })
    }

    const timeoutMs = Math.min(Math.max(context.timeoutMs, 2000), 20_000)
    const [api, registry] = await Promise.all([
      probe(TARGETS.api, timeoutMs),
      probe(TARGETS.registry, timeoutMs),
    ])

    const proxy = detectProxy(context.env)
    const details: string[] = []
    if (registry.ok) {
      details.push(`registry.npmjs.org reachable in ${registry.durationMs} ms.`)
    }
    if (proxy) {
      details.push(
        `Proxy configured via ${proxy.variable}. Freebuff can be blocked or mistakenly flagged on proxied networks — the FAQ's sanctioned option is Cloudflare WARP, which doesn't mask your location the way a VPN does.`,
      )
    }

    const data = {
      api: {
        host: TARGETS.api,
        ok: api.ok,
        status: api.status,
        durationMs: api.durationMs,
        error: api.error,
      },
      registry: {
        host: TARGETS.registry,
        ok: registry.ok,
        status: registry.status,
        error: registry.error,
      },
      proxy: proxy ? { variable: proxy.variable } : null,
    }

    if (!api.ok) {
      return found({
        status: 'fail',
        message: `Cannot reach ${TARGETS.api}${api.error ? ` — ${api.error}` : ` (HTTP ${api.status ?? 'no response'})`}.`,
        details: [
          ...details,
          'Check whether antivirus or a firewall is blocking freebuff.exe / bun.exe, and disable any TUN/VPN adapter.',
          'If you are on a restricted network, try a mobile hotspot to confirm the network is the cause.',
        ],
        fix: 'Set DNS to 8.8.8.8 or 1.1.1.1 and disable any VPN/TUN adapter',
        faqSlug: 'network-issues',
        data,
      })
    }

    if (!registry.ok) {
      return found({
        status: 'warn',
        message: `Freebuff is reachable, but ${TARGETS.registry} is not — installing and updating the CLI will fail.`,
        details: [
          ...details,
          `Freebuff responded in ${api.durationMs} ms (HTTP ${api.status ?? 'ok'}).`,
          registry.error
            ? `Registry error: ${registry.error}`
            : 'The registry returned an unexpected status.',
        ],
        fix: 'Check your firewall and DNS settings for registry.npmjs.org',
        faqSlug: 'crash-on-start--updating',
        data,
      })
    }

    if (proxy) {
      return found({
        status: 'warn',
        message: `Network is reachable, but traffic is routed through a proxy (${proxy.variable}).`,
        details: [
          `Freebuff responded in ${api.durationMs} ms (HTTP ${api.status ?? 'ok'}).`,
          ...details,
        ],
        fix: `Unset ${proxy.variable} if you are not deliberately using a proxy`,
        faqSlug: 'network-issues',
        data,
      })
    }

    return found({
      status: 'pass',
      message: `Reached ${TARGETS.api} in ${api.durationMs} ms and the npm registry is reachable.`,
      data,
    })
  },
}
