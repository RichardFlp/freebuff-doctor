import dns from 'node:dns'

import {
  found,
  type CheckContext,
  type CheckStatus,
  type DiagnosticCheck,
} from './types.js'

export const PRIMARY_HOST = 'freebuff.com'

/** DNS servers the FAQ tells users to switch to. */
const PUBLIC_RESOLVERS = ['8.8.8.8', '1.1.1.1']

export type AddressClass =
  | 'public'
  | 'private'
  | 'loopback'
  | 'link-local'
  | 'cgnat'
  | 'reserved'
  | 'invalid'

function classifyIpv4(octets: number[]): AddressClass {
  const [a, b] = octets as [number, number]
  if (a === 0) return 'reserved'
  if (a === 10) return 'private'
  if (a === 127) return 'loopback'
  if (a === 169 && b === 254) return 'link-local'
  if (a === 172 && b >= 16 && b <= 31) return 'private'
  if (a === 192 && b === 168) return 'private'
  if (a === 100 && b >= 64 && b <= 127) return 'cgnat'
  if (a >= 224) return 'reserved'
  return 'public'
}

/**
 * Classifies an IP address by how trustworthy it is as an answer for a public
 * hostname: anything non-public points at a VPN, proxy or local DNS hijack.
 */
export function classifyAddress(address: string): AddressClass {
  const value = address.trim().toLowerCase()
  if (!value) return 'invalid'

  if (value.includes(':')) {
    if (value === '::1' || value === '::') return 'loopback'
    // IPv4-mapped IPv6, e.g. ::ffff:93.184.216.34
    const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(value)
    if (mapped?.[1]) return classifyAddress(mapped[1])
    if (
      value.startsWith('fe8') ||
      value.startsWith('fe9') ||
      value.startsWith('fea') ||
      value.startsWith('feb')
    ) {
      return 'link-local'
    }
    if (/^f[cd]/.test(value)) return 'private'
    if (value.startsWith('ff')) return 'reserved'
    return 'public'
  }

  const parts = value.split('.')
  if (parts.length !== 4) return 'invalid'
  const octets = parts.map((part) => Number(part))
  if (
    octets.some((octet) => !Number.isInteger(octet) || octet < 0 || octet > 255)
  )
    return 'invalid'
  return classifyIpv4(octets)
}

export interface DnsObservation {
  host: string
  systemAddresses: string[]
  systemError: string | null
  publicAddresses: string[]
  publicError: string | null
}

export interface DnsVerdict {
  status: CheckStatus
  message: string
  details: string[]
}

/**
 * Pure decision logic for the DNS check. Kept separate from the network calls so
 * the awkward cases (hijacked DNS, a resolver that refuses to answer) can be
 * tested directly.
 */
export function classifyDns(observation: DnsObservation): DnsVerdict {
  const { host, systemAddresses, systemError, publicAddresses, publicError } =
    observation
  const details: string[] = []

  if (publicAddresses.length > 0) {
    details.push(
      `Public DNS (${PUBLIC_RESOLVERS[0]}) returns: ${publicAddresses.join(', ')}`,
    )
  } else if (publicError) {
    details.push(
      `A DNS query to ${PUBLIC_RESOLVERS[0]} failed (${publicError}) — outbound UDP/53 may be blocked.`,
    )
  }

  if (systemAddresses.length === 0) {
    if (publicAddresses.length > 0) {
      return {
        status: 'fail',
        message: `Your resolver could not resolve ${host}, but public DNS can — a filtered or misconfigured DNS server is blocking it.`,
        details,
      }
    }
    return {
      status: 'fail',
      message: `Could not resolve ${host} at all${systemError ? ` (${systemError})` : ''}.`,
      details,
    }
  }

  details.unshift(`Your resolver returns: ${systemAddresses.join(', ')}`)

  const classes = systemAddresses.map(classifyAddress)
  const nonPublic = classes.filter((value) => value !== 'public')
  // CGNAT is normal on mobile and many ISPs, so it is a caution rather than a
  // hijack; an answer pointing at a private or loopback address is not normal.
  const hijack = nonPublic.filter((value) => value !== 'cgnat')

  if (nonPublic.length === classes.length && hijack.length > 0) {
    return {
      status: 'fail',
      message: `${host} resolves to a ${describeClass(hijack[0] ?? 'private')} address — a VPN/TUN adapter, proxy or local DNS hijack is intercepting your traffic.`,
      details,
    }
  }

  if (nonPublic.length === classes.length) {
    return {
      status: 'warn',
      message: `${host} resolves through a carrier-grade NAT address shared with other customers — some dynamic IPs on this range get flagged.`,
      details,
    }
  }

  if (publicAddresses.length > 0) {
    const overlap = systemAddresses.some((address) =>
      publicAddresses.includes(address),
    )
    if (!overlap) {
      return {
        status: 'warn',
        message: `Your DNS gives a different answer for ${host} than ${PUBLIC_RESOLVERS[0]} — filtering or a hijacked resolver is likely.`,
        details,
      }
    }
  }

  return {
    status: 'pass',
    message: `${host} resolves normally.`,
    details,
  }
}

function describeClass(value: AddressClass): string {
  switch (value) {
    case 'loopback':
      return 'loopback'
    case 'link-local':
      return 'link-local'
    case 'cgnat':
      return 'carrier-grade NAT'
    case 'reserved':
      return 'reserved'
    case 'invalid':
      return 'malformed'
    default:
      return 'private'
  }
}

function reasonFor(error: unknown): string {
  const code = (error as { code?: string })?.code
  if (code === 'ENOTFOUND' || code === 'ENODATA') return 'no records found'
  if (code === 'ETIMEOUT' || code === 'ETIMEDOUT') return 'timed out'
  if (code === 'ECONNREFUSED') return 'connection refused'
  if (code === 'ESERVFAIL') return 'server failure'
  return code ?? (error instanceof Error ? error.message : String(error))
}

async function resolveWithSystem(
  host: string,
  timeoutMs: number,
): Promise<string[]> {
  const lookup = dns.promises.lookup(host, { all: true, verbatim: true })
  const timeout = new Promise<never>((_resolve, reject) =>
    setTimeout(() => reject(new Error('ETIMEOUT')), timeoutMs).unref(),
  )
  const records = await Promise.race([lookup, timeout])
  return records.map((record) => record.address)
}

async function resolveWithPublicDns(
  host: string,
  timeoutMs: number,
): Promise<string[]> {
  const resolver = new dns.promises.Resolver({ timeout: timeoutMs, tries: 1 })
  resolver.setServers(PUBLIC_RESOLVERS)
  const settled = await Promise.allSettled([
    resolver.resolve4(host),
    resolver.resolve6(host),
  ])
  const addresses: string[] = []
  for (const result of settled) {
    if (result.status === 'fulfilled') addresses.push(...result.value)
  }
  if (addresses.length === 0) {
    const first = settled.find((result) => result.status === 'rejected')
    throw new Error(
      first && first.status === 'rejected'
        ? reasonFor(first.reason)
        : 'no records found',
    )
  }
  return addresses
}

/** Resolves Freebuff's domain and looks for evidence of interception. */
export const dnsCheck: DiagnosticCheck = {
  id: 'dns',
  title: 'DNS resolution',
  async run(context: CheckContext) {
    if (context.offline) {
      return found({
        status: 'skip',
        message: 'Skipped because --offline was requested.',
      })
    }

    const timeoutMs = Math.min(Math.max(context.timeoutMs, 2000), 15_000)

    let systemAddresses: string[] = []
    let systemError: string | null = null
    try {
      systemAddresses = await resolveWithSystem(PRIMARY_HOST, timeoutMs)
    } catch (error) {
      systemError = reasonFor(error)
    }

    let publicAddresses: string[] = []
    let publicError: string | null = null
    try {
      publicAddresses = await resolveWithPublicDns(PRIMARY_HOST, timeoutMs)
    } catch (error) {
      publicError = reasonFor(error)
    }

    const verdict = classifyDns({
      host: PRIMARY_HOST,
      systemAddresses,
      systemError,
      publicAddresses,
      publicError,
    })

    const needsFaq = verdict.status !== 'pass'
    return found({
      status: verdict.status,
      message: verdict.message,
      details: verdict.details,
      ...(needsFaq
        ? {
            fix: 'Change your DNS to 8.8.8.8 (Google) or 1.1.1.1 (Cloudflare)',
            faqSlug: 'network-issues',
          }
        : {}),
      data: {
        host: PRIMARY_HOST,
        systemAddresses,
        publicAddresses,
        systemError,
        publicError,
      },
    })
  },
}
