import tls from 'node:tls'

import { describeNetworkError } from '../util/registry.js'
import {
  found,
  type CheckContext,
  type DiagnosticCheck,
  type ResultInit,
} from './types.js'

export const TLS_HOST = 'freebuff.com'
const TLS_PORT = 443

export interface CertificateSummary {
  subject: string
  issuer: string
  validFrom: number
  validTo: number
}

export interface ChainFacts {
  /** Node accepted the chain against its own trust store. */
  authorized: boolean
  /** `authorizationError` string when the chain was rejected. */
  authorizationError: string | null
  protocol: string | null
  /** Leaf first, root last. */
  chain: CertificateSummary[]
  /** Names of the TLS environment variables that are set. */
  caVariables: string[]
}

function describeName(value: string | string[] | undefined): string {
  if (Array.isArray(value)) return value[0] ?? ''
  return typeof value === 'string' ? value : ''
}

/** Reads the leaf-only certificate as a printable summary. */
function summarizePeer(peer: tls.PeerCertificate): CertificateSummary {
  return {
    subject: describeName(peer.subject?.CN) || describeName(peer.subject?.O),
    issuer: describeName(peer.issuer?.O) || describeName(peer.issuer?.CN),
    validFrom: Date.parse(peer.valid_from ?? '') || 0,
    validTo: Date.parse(peer.valid_to ?? '') || 0,
  }
}

/** Walks `issuerCertificate` up to the root, guarding against cycles. */
export function collectChain(
  peer: tls.PeerCertificate | tls.DetailedPeerCertificate,
): CertificateSummary[] {
  const chain: CertificateSummary[] = []
  const seen = new Set<string>()
  let current: tls.DetailedPeerCertificate | undefined =
    peer as tls.DetailedPeerCertificate

  while (current) {
    const fingerprint =
      typeof current.fingerprint256 === 'string' ? current.fingerprint256 : ''
    if (fingerprint && seen.has(fingerprint)) break
    if (fingerprint) seen.add(fingerprint)

    chain.push(summarizePeer(current))
    const next: tls.DetailedPeerCertificate | undefined =
      current.issuerCertificate
    if (!next) break
    // Node repeats the root as its own issuer; stop once we reach it.
    if (next.fingerprint256 === current.fingerprint256 || chain.length >= 6) {
      break
    }
    current = next
  }

  return chain
}

const CERTIFICATE_ERROR =
  /UNABLE_TO_VERIFY_LEAF_SIGNATURE|SELF_SIGNED_CERT_IN_CHAIN|CERT_HAS_EXPIRED|UNABLE_TO_GET_ISSUER_CERT|DEPTH_ZERO_SELF_SIGNED_CERT|CERT_SIGNATURE_FAILURE|ERR_TLS_CERT_ALTNAME_INVALID|CERT_UNTRUSTED|UNABLE_TO_GET_ISSUER_CERT_LOCALLY/i

/** A command that makes Node trust an extra PEM bundle on each platform. */
export function extraCaFix(platform: NodeJS.Platform): string {
  return platform === 'win32'
    ? "[Environment]::SetEnvironmentVariable('NODE_EXTRA_CA_CERTS', 'C:\\path\\to\\corporate-root.pem', 'User')"
    : 'export NODE_EXTRA_CA_CERTS=/path/to/corporate-root.pem'
}

/**
 * Pure verdict for a completed TLS handshake. The important insight is that
 * Node ships its own CA bundle and ignores the operating system store, so a
 * corporate root that satisfies your browser and `curl` still fails here.
 */
export function classifyTlsChain(facts: ChainFacts): ResultInit {
  const { authorized, authorizationError, protocol, chain, caVariables } = facts
  const leaf = chain[0]
  const root = chain[chain.length - 1]

  const details: string[] = []
  if (leaf) {
    details.push(
      `Certificate for ${leaf.subject || TLS_HOST}, issued by ${leaf.issuer || 'an unnamed authority'}.`,
    )
  }
  if (root && root !== leaf) {
    details.push(
      `Chain of ${chain.length} certificates ending at ${root.subject || root.issuer || 'unknown'}.`,
    )
  }
  if (protocol) details.push(`Negotiated ${protocol}.`)
  if (caVariables.length > 0) {
    details.push(
      `Additional trust settings are active: ${caVariables.join(', ')}.`,
    )
  }

  const rejected =
    !authorized ||
    (authorizationError !== null && CERTIFICATE_ERROR.test(authorizationError))

  if (rejected) {
    const reason = authorizationError ?? 'certificate verification failed'
    return {
      status: 'warn',
      message: `Node rejected the certificate chain for ${TLS_HOST} (${reason}) — this is what a corporate TLS-inspection proxy looks like from inside the app.`,
      details: [
        ...details,
        'Node uses its own bundled CA list and ignores the Windows/macOS trust store, so a root that your browser trusts can still fail here.',
        'Export the inspecting root as PEM and point NODE_EXTRA_CA_CERTS at it, or run the update over a network without inspection.',
      ],
      fix: extraCaFix(process.platform),
      faqSlug: 'network-issues',
      data: {
        host: TLS_HOST,
        authorized,
        authorizationError,
        protocol,
        chain,
      },
    }
  }

  if (!leaf) {
    return {
      status: 'pass',
      message: `${TLS_HOST} accepted the connection but reported no certificate details.`,
      data: { host: TLS_HOST, authorized, protocol },
    }
  }

  return {
    status: 'pass',
    message: `${TLS_HOST} presented a certificate chain Node trusts${
      leaf.issuer ? ` (issued by ${leaf.issuer})` : ''
    }.`,
    details: [
      ...details,
      'Certificate verification is working end to end from Node, so an intercepted connection is not the cause of a problem here.',
    ],
    data: {
      host: TLS_HOST,
      authorized,
      protocol,
      issuer: leaf.issuer,
      chain: chain.map((entry) => entry.subject),
    },
  }
}

interface HandshakeOutcome {
  facts: ChainFacts | null
  error: string | null
  certificateError: boolean
}

/**
 * Opens a TLS connection and reads the chain. Verification is disabled on the
 * socket on purpose: an unauthorised chain still delivers the full certificate
 * list, and `authorized`/`authorizationError` then tell us exactly what Node
 * thought of it. No application data is sent, and the socket is destroyed.
 */
function handshake(host: string, timeoutMs: number): Promise<HandshakeOutcome> {
  return new Promise((resolve) => {
    let settled = false
    const finish = (outcome: HandshakeOutcome): void => {
      if (settled) return
      settled = true
      socket.destroy()
      resolve(outcome)
    }

    const socket = tls.connect({
      host,
      port: TLS_PORT,
      servername: host,
      rejectUnauthorized: false,
    })

    socket.setTimeout(timeoutMs, () =>
      finish({ facts: null, error: 'timed out', certificateError: false }),
    )

    socket.once('secureConnect', () => {
      const peer = socket.getPeerCertificate(
        true,
      ) as tls.DetailedPeerCertificate
      const caVariables = ['NODE_EXTRA_CA_CERTS', 'SSL_CERT_FILE'].filter(
        (name) => Boolean(process.env[name]?.trim()),
      )
      // `authorizationError` is typed as an Error but is a string in practice.
      const rawAuthError: unknown = socket.authorizationError
      finish({
        facts: {
          authorized: socket.authorized,
          authorizationError:
            typeof rawAuthError === 'string'
              ? rawAuthError
              : rawAuthError
                ? String(rawAuthError)
                : null,
          protocol: socket.getProtocol(),
          chain: peer && Object.keys(peer).length > 0 ? collectChain(peer) : [],
          caVariables,
        },
        error: null,
        certificateError: false,
      })
    })

    socket.once('error', (error: NodeJS.ErrnoException) => {
      finish({
        facts: null,
        error: describeNetworkError(error),
        certificateError: CERTIFICATE_ERROR.test(error.code ?? ''),
      })
    })
  })
}

/** Inspects the live certificate chain to Freebuff to spot TLS interception. */
export const tlsChainCheck: DiagnosticCheck = {
  id: 'tls-chain',
  title: 'TLS certificate chain',
  async run(context: CheckContext) {
    if (context.offline) {
      return found({
        status: 'skip',
        message: 'Skipped because --offline was requested.',
      })
    }

    const timeoutMs = Math.min(Math.max(context.timeoutMs, 2000), 12_000)
    const outcome = await handshake(TLS_HOST, timeoutMs)

    if (outcome.facts) {
      return found(classifyTlsChain(outcome.facts))
    }

    if (outcome.certificateError) {
      return found(
        classifyTlsChain({
          authorized: false,
          authorizationError: outcome.error,
          protocol: null,
          chain: [],
          caVariables: [],
        }),
      )
    }

    return found({
      status: 'pass',
      message: `No TLS handshake with ${TLS_HOST} could be completed (${outcome.error ?? 'unknown error'}), so the certificate chain was not inspected.`,
      details: ['The network and DNS checks cover reachability itself.'],
      data: { host: TLS_HOST, error: outcome.error },
    })
  },
}
