import net from 'node:net'

import {
  found,
  type CheckContext,
  type DiagnosticCheck,
  type ResultInit,
} from './types.js'

/** Loopback names that must never be sent through a proxy. */
export const LOOPBACK_HOSTS = ['localhost', '127.0.0.1', '::1', '0.0.0.0']

/** Variables that carry a proxy URL, in the order browsers and Node read them. */
const PROXY_VARIABLES = [
  ['HTTP_PROXY', 'http_proxy'],
  ['HTTPS_PROXY', 'https_proxy'],
  ['ALL_PROXY', 'all_proxy'],
] as const

export interface ProxyTarget {
  /** Which variable supplied this proxy. */
  variable: string
  host: string
  port: number
  protocol: string
  /** Credential-free spelling, safe to print. */
  display: string
}

export interface ProxyEnvironment {
  targets: ProxyTarget[]
  /** Variables that were set but could not be understood. */
  unparsable: Array<{ variable: string; value: string }>
  noProxy: string[]
  /** True when Node has been told to route its own requests through the proxy. */
  envProxyEnabled: boolean
}

function isEnabled(value: string | undefined): boolean {
  if (value === undefined) return false
  const normalized = value.trim().toLowerCase()
  return normalized !== '' && normalized !== '0' && normalized !== 'false'
}

/**
 * Parses a proxy URL. A bare `host:port` is accepted — Node and curl do the
 * same — but plain `URL` would read the host as a protocol, so a scheme is
 * added first. Credentials are stripped from the printable form.
 */
export function parseProxyTarget(
  raw: string,
  variable: string,
): ProxyTarget | null {
  const trimmed = raw.trim()
  if (!trimmed) return null
  const withScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(trimmed)
    ? trimmed
    : `http://${trimmed}`

  let parsed: URL
  try {
    parsed = new URL(withScheme)
  } catch {
    return null
  }

  const host = parsed.hostname.replace(/^\[|\]$/g, '')
  if (!host) return null
  const protocol = parsed.protocol.replace(':', '') || 'http'
  const port = parsed.port
    ? Number(parsed.port)
    : protocol === 'https'
      ? 443
      : protocol === 'socks5' || protocol === 'socks4'
        ? 1080
        : 80
  if (!Number.isInteger(port) || port <= 0 || port > 65_535) return null

  // Never echo `user:password@` into a report.
  const display = `${protocol}://${host}:${port}`
  return { variable, host, port, protocol, display }
}

/** Reads every proxy variable, accepting the upper- and lower-case spellings. */
export function readProxyEnvironment(env: NodeJS.ProcessEnv): ProxyEnvironment {
  const targets: ProxyTarget[] = []
  const unparsable: ProxyEnvironment['unparsable'] = []

  for (const names of PROXY_VARIABLES) {
    for (const name of names) {
      const value = env[name]?.trim()
      if (!value) continue
      const target = parseProxyTarget(value, name)
      if (target) targets.push(target)
      else unparsable.push({ variable: name, value })
      // Only the first spelling of a pair counts, like libcurl does.
      break
    }
  }

  const noProxyRaw = env.NO_PROXY?.trim() || env.no_proxy?.trim() || ''
  const noProxy = noProxyRaw
    .split(',')
    .map((entry) => entry.trim().toLowerCase())
    .filter(Boolean)

  return {
    targets,
    unparsable,
    noProxy,
    envProxyEnabled:
      isEnabled(env.NODE_USE_ENV_PROXY) ||
      /\B--use-env-proxy\b/.test(env.NODE_OPTIONS ?? ''),
  }
}

/** True when `host` is covered by a `NO_PROXY` entry. */
export function isHostExcluded(noProxy: string[], host: string): boolean {
  const value = host.trim().toLowerCase()
  if (!value) return false
  return noProxy.some((entry) => {
    if (entry === '*') return true
    const bare = entry.replace(/^\./, '')
    return value === bare || value.endsWith(`.${bare}`)
  })
}

/** Loopback names that a proxy would needlessly intercept. */
export function missingLoopbackExclusions(noProxy: string[]): string[] {
  return LOOPBACK_HOSTS.filter(
    (host) => host !== '0.0.0.0' && !isHostExcluded(noProxy, host),
  )
}

export interface ProxyObservation {
  platform: NodeJS.Platform
  environment: ProxyEnvironment
  /** TCP reachability per `display`; empty when the probe was skipped. */
  probes: Array<{ display: string; reachable: boolean; error: string | null }>
  probed: boolean
}

/** A variable name a user can type to remove the proxy, per platform. */
export function proxyClearFix(platform: NodeJS.Platform): string {
  return platform === 'win32'
    ? 'Remove-Item Env:HTTPS_PROXY, Env:HTTP_PROXY, Env:ALL_PROXY'
    : 'unset HTTPS_PROXY HTTP_PROXY ALL_PROXY'
}

/**
 * Pure verdict for proxy configuration. A proxy that is configured but
 * unreachable breaks every request, and it is the single most common cause of
 * "Freebuff can't connect" inside a company network.
 */
export function classifyProxy(observation: ProxyObservation): ResultInit {
  const { environment, probes, probed, platform } = observation
  const { targets, unparsable, noProxy, envProxyEnabled } = environment

  const data = {
    targets: targets.map((target) => ({
      variable: target.variable,
      proxy: target.display,
      protocol: target.protocol,
    })),
    noProxy,
    envProxyEnabled,
    unparsable: unparsable.map((entry) => entry.variable),
  }

  if (targets.length === 0 && unparsable.length === 0) {
    const direct: string[] = []
    if (noProxy.length > 0) {
      direct.push(`NO_PROXY is set to: ${noProxy.join(', ')}`)
    }
    if (envProxyEnabled) {
      direct.push(
        'NODE_USE_ENV_PROXY is enabled, but there is no proxy to use.',
      )
    }
    return {
      status: 'pass',
      message:
        'No proxy is configured, so Freebuff connects to the network directly.',
      ...(direct.length > 0 ? { details: direct } : {}),
      data,
    }
  }

  if (targets.length === 0) {
    const first = unparsable[0]
    return {
      status: 'warn',
      message: `${first?.variable ?? 'A proxy variable'} is set to something that is not a usable proxy address, so requests may fail or silently bypass it.`,
      details: [
        `Value: ${first?.value ?? ''}`,
        'Expected a form like http://proxy.example.com:8080.',
      ],
      fix: proxyClearFix(platform),
      faqSlug: 'network-issues',
      data,
    }
  }

  const unreachable = probes.find((probe) => !probe.reachable)
  const primary = targets.find(
    (target) =>
      target.variable === 'HTTPS_PROXY' || target.variable === 'https_proxy',
  )
  const shown =
    probes.length > 0
      ? probes
      : targets.map((target) => ({
          display: target.display,
          reachable: true,
          error: null,
        }))

  if (probed && unreachable) {
    return {
      status: 'fail',
      message: `The proxy at ${unreachable.display} cannot be reached (${unreachable.error ?? 'no response'}), so every request Freebuff sends is blocked.`,
      details: [
        ...shown.map(
          (probe) =>
            `${probe.display}: ${probe.reachable ? 'reachable' : (probe.error ?? 'unreachable')}`,
        ),
        'If you are no longer on that network (office VPN, corporate proxy), remove the variables and restart your terminal.',
      ],
      fix: proxyClearFix(platform),
      faqSlug: 'network-issues',
      data,
    }
  }

  const missingLoopback = missingLoopbackExclusions(noProxy)
  if (missingLoopback.length > 0) {
    return {
      status: 'warn',
      message: `A proxy is configured but NO_PROXY does not exclude ${missingLoopback.join(', ')}, so local requests are sent to the proxy too.`,
      details: [
        `Proxy: ${primary?.display ?? targets[0]?.display ?? 'configured'}`,
        `NO_PROXY is currently: ${noProxy.length > 0 ? noProxy.join(', ') : '(unset)'}`,
        'Excluding loopback fixes local connection failures without touching your corporate setup.',
      ],
      fix:
        platform === 'win32'
          ? "[Environment]::SetEnvironmentVariable('NO_PROXY', \"$env:NO_PROXY,localhost,127.0.0.1\", 'User')"
          : 'export NO_PROXY="localhost,127.0.0.1,::1,$NO_PROXY"',
      faqSlug: 'network-issues',
      data,
    }
  }

  if (!envProxyEnabled) {
    return {
      status: 'warn',
      message: `A proxy is configured (${primary?.display ?? targets[0]?.display ?? ''}) but Node is not set to use it, so Freebuff's own requests may bypass the proxy entirely.`,
      details: [
        ...shown.map(
          (probe) =>
            `${probe.display}: ${probe.reachable ? 'reachable' : (probe.error ?? 'unreachable')}`,
        ),
        "Node's built-in fetch ignores HTTP_PROXY/HTTPS_PROXY unless env-proxy support is switched on (Node 24 and newer: NODE_USE_ENV_PROXY=1).",
        'Turn it on when your network requires the proxy; leave it off if the proxy only serves your browser.',
      ],
      fix:
        platform === 'win32'
          ? "[Environment]::SetEnvironmentVariable('NODE_USE_ENV_PROXY', '1', 'User')"
          : 'export NODE_USE_ENV_PROXY=1',
      faqSlug: 'network-issues',
      data,
    }
  }

  return {
    status: 'pass',
    message: `Proxy configuration looks usable (${primary?.display ?? targets[0]?.display ?? 'configured'}).`,
    details: [
      ...shown.map(
        (probe) =>
          `${probe.display}: ${probe.reachable ? 'reachable' : 'not probed'}`,
      ),
      ...(noProxy.length > 0 ? [`NO_PROXY: ${noProxy.join(', ')}`] : []),
      'Requests are routed through the proxy because NODE_USE_ENV_PROXY is enabled.',
    ],
    data,
  }
}

function describeSocketError(error: NodeJS.ErrnoException): string {
  switch (error.code) {
    case 'ECONNREFUSED':
      return 'connection refused'
    case 'ENOTFOUND':
    case 'EAI_AGAIN':
      return 'the proxy host could not be resolved'
    case 'EHOSTUNREACH':
    case 'ENETUNREACH':
      return 'the host is unreachable from this network'
    case 'ETIMEDOUT':
      return 'timed out'
    default:
      return error.code ?? 'no response'
  }
}

/** Opens a TCP connection to the proxy so we can tell "down" from "misconfigured". */
function probeTcp(
  host: string,
  port: number,
  timeoutMs: number,
): Promise<{ reachable: boolean; error: string | null }> {
  return new Promise((resolve) => {
    let settled = false
    const socket = net.connect({ host, port })
    const finish = (reachable: boolean, error: string | null): void => {
      if (settled) return
      settled = true
      socket.destroy()
      resolve({ reachable, error })
    }

    socket.setTimeout(timeoutMs, () => finish(false, 'timed out'))
    socket.once('connect', () => finish(true, null))
    socket.once('error', (error: NodeJS.ErrnoException) =>
      finish(false, describeSocketError(error)),
    )
  })
}

/** Audits proxy variables and checks that a configured proxy actually answers. */
export const proxyTrustCheck: DiagnosticCheck = {
  id: 'proxy-trust',
  title: 'Proxy configuration',
  async run(context: CheckContext) {
    const environment = readProxyEnvironment(context.env)
    const timeoutMs = Math.min(Math.max(context.timeoutMs, 2000), 10_000)

    if (context.offline) {
      const audit = classifyProxy({
        platform: context.platform,
        environment,
        probes: [],
        probed: false,
      })
      if (audit.status === 'pass') {
        return found({
          status: 'skip',
          message:
            'Skipped because --offline was requested, and no proxy problem was visible in the environment.',
        })
      }
      return found({
        ...audit,
        data: { ...(audit.data ?? {}), offline: true },
      })
    }

    const probes: ProxyObservation['probes'] = []
    for (const target of environment.targets) {
      const result = await probeTcp(target.host, target.port, timeoutMs)
      probes.push({ display: target.display, ...result })
    }

    const verdict = classifyProxy({
      platform: context.platform,
      environment,
      probes,
      probed: true,
    })
    return found({
      ...verdict,
      data: { ...(verdict.data ?? {}), probes },
    })
  },
}
