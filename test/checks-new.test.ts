import { readdirSync, readFileSync } from 'node:fs'
import type tls from 'node:tls'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

import { allSections } from '../src/faq/reference.js'

import {
  classifyCredentials,
  inspectCredentialPayload,
  readExpiry,
  type CredentialFacts,
} from '../src/checks/auth-session.js'
import {
  classifyCache,
  type CacheArtifact,
} from '../src/checks/cache-integrity.js'
import {
  classifyShadowing,
  duplicatePathEntries,
} from '../src/checks/command-shadowing.js'
import { classifyTriage, scanLogTail } from '../src/checks/error-triage.js'
import {
  classifyHostsFile,
  findPinnedHosts,
  hostsFilePath,
  parseHostsFile,
} from '../src/checks/hosts-pin.js'
import { classifyPathLength } from '../src/checks/path-length.js'
import {
  classifyPorts,
  parseLsofListeners,
  parseNetstatListeners,
  parseProcesses,
  parseSsListeners,
} from '../src/checks/port-availability.js'
import {
  classifyProxy,
  isHostExcluded,
  missingLoopbackExclusions,
  parseProxyTarget,
  readProxyEnvironment,
} from '../src/checks/proxy-trust.js'
import { classifySplitState } from '../src/checks/split-state.js'
import { classifyTemp, tempDirectory } from '../src/checks/temp-health.js'
import { classifyTlsChain, collectChain } from '../src/checks/tls-chain.js'
import { classifyWatcherLimits } from '../src/checks/watcher-limits.js'

const checksDir = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
  'src',
  'checks',
)

describe('faq links', () => {
  it('only ever points at FAQ sections that exist', () => {
    const slugs = new Set<string>()
    for (const file of readdirSync(checksDir)) {
      if (!file.endsWith('.ts')) continue
      const source = readFileSync(path.join(checksDir, file), 'utf8')
      for (const match of source.matchAll(/faqSlug:\s*'([^']+)'/g)) {
        if (match[1]) slugs.add(match[1])
      }
    }

    // A regression to a bare string would silently drop the FAQ pointer from
    // every result, so make sure the scan is still finding something.
    expect(slugs.size).toBeGreaterThan(5)

    const known = new Set(allSections().map((section) => section.slug))
    expect([...slugs].filter((slug) => !known.has(slug))).toEqual([])
  })
})

describe('proxy-trust', () => {
  it('parses a proxy with and without a scheme', () => {
    const bare = parseProxyTarget('proxy.corp.example:8080', 'HTTP_PROXY')
    expect(bare).toMatchObject({
      host: 'proxy.corp.example',
      port: 8080,
      protocol: 'http',
      display: 'http://proxy.corp.example:8080',
    })

    const withScheme = parseProxyTarget(
      'https://proxy.example:8443',
      'HTTPS_PROXY',
    )
    expect(withScheme).toMatchObject({ host: 'proxy.example', port: 8443 })
  })

  it('never echoes credentials from a proxy URL', () => {
    const target = parseProxyTarget(
      'http://user:secret@proxy.example:3128',
      'HTTPS_PROXY',
    )
    expect(target?.display).toBe('http://proxy.example:3128')
    expect(target?.display).not.toContain('secret')
  })

  it('rejects values that are not usable proxy addresses', () => {
    expect(parseProxyTarget('', 'HTTP_PROXY')).toBeNull()
    expect(parseProxyTarget('not a url', 'HTTP_PROXY')).toBeNull()
  })

  it('reads both spellings and remembers NO_PROXY', () => {
    const parsed = readProxyEnvironment({
      https_proxy: 'http://proxy.example:8080',
      no_proxy: 'localhost, .corp.example',
      NODE_USE_ENV_PROXY: '1',
    })
    expect(parsed.targets).toHaveLength(1)
    expect(parsed.targets[0]?.variable).toBe('https_proxy')
    expect(parsed.noProxy).toEqual(['localhost', '.corp.example'])
    expect(parsed.envProxyEnabled).toBe(true)
  })

  it('recognises NO_PROXY coverage including suffix and wildcard entries', () => {
    expect(isHostExcluded(['localhost'], 'localhost')).toBe(true)
    expect(isHostExcluded(['.corp.example'], 'api.corp.example')).toBe(true)
    expect(isHostExcluded(['*'], 'anything.example')).toBe(true)
    expect(isHostExcluded(['other.example'], 'freebuff.com')).toBe(false)
  })

  it('reports the loopback names NO_PROXY forgot', () => {
    expect(missingLoopbackExclusions(['localhost'])).toEqual([
      '127.0.0.1',
      '::1',
    ])
    expect(
      missingLoopbackExclusions(['localhost', '127.0.0.1', '::1']),
    ).toEqual([])
  })

  it('passes when no proxy is configured', () => {
    const verdict = classifyProxy({
      platform: 'linux',
      environment: readProxyEnvironment({}),
      probes: [],
      probed: true,
    })
    expect(verdict.status).toBe('pass')
  })

  it('fails when the configured proxy cannot be reached', () => {
    const environment = readProxyEnvironment({
      HTTPS_PROXY: 'http://proxy.example:8080',
    })
    const verdict = classifyProxy({
      platform: 'linux',
      environment,
      probes: [
        {
          display: 'http://proxy.example:8080',
          reachable: false,
          error: 'connection refused',
        },
      ],
      probed: true,
    })
    expect(verdict.status).toBe('fail')
    expect(verdict.message).toContain('connection refused')
  })

  it('warns when node will ignore a working proxy', () => {
    const environment = readProxyEnvironment({
      HTTPS_PROXY: 'http://proxy.example:8080',
      NO_PROXY: 'localhost,127.0.0.1,::1',
    })
    const verdict = classifyProxy({
      platform: 'linux',
      environment,
      probes: [
        {
          display: 'http://proxy.example:8080',
          reachable: true,
          error: null,
        },
      ],
      probed: true,
    })
    expect(verdict.status).toBe('warn')
    expect(verdict.details?.join(' ')).toContain('NODE_USE_ENV_PROXY')
  })

  it('prefers the loopback gap when NO_PROXY is incomplete', () => {
    const environment = readProxyEnvironment({
      HTTPS_PROXY: 'http://proxy.example:8080',
    })
    const verdict = classifyProxy({
      platform: 'linux',
      environment,
      probes: [
        { display: 'http://proxy.example:8080', reachable: true, error: null },
      ],
      probed: true,
    })
    expect(verdict.status).toBe('warn')
    expect(verdict.message).toContain('NO_PROXY')
  })
})

describe('tls-chain', () => {
  function cert(
    subject: string,
    issuer: string,
    next?: unknown,
    fingerprint = subject,
  ): unknown {
    return {
      subject: { CN: subject },
      issuer: { O: issuer },
      valid_from: 'Jan 1 00:00:00 2026 GMT',
      valid_to: 'Jan 1 00:00:00 2027 GMT',
      fingerprint256: fingerprint,
      issuerCertificate: next,
    }
  }

  it('walks a certificate chain leaf first', () => {
    const root = cert('Corp Root CA', 'Corp Root CA')
    const intermediate = cert('Corp Issuing CA', 'Corp Root CA', root)
    const leaf = cert('freebuff.com', 'Corp Issuing CA', intermediate)

    const chain = collectChain(leaf as unknown as tls.DetailedPeerCertificate)
    expect(chain.map((entry) => entry.subject)).toEqual([
      'freebuff.com',
      'Corp Issuing CA',
      'Corp Root CA',
    ])
  })

  it('stops when a certificate is its own issuer', () => {
    const root = cert('Root', 'Root')
    ;(root as { issuerCertificate?: unknown }).issuerCertificate = root
    const chain = collectChain(root as unknown as tls.DetailedPeerCertificate)
    expect(chain).toHaveLength(1)
  })

  it('warns when node rejects the chain', () => {
    const verdict = classifyTlsChain({
      authorized: false,
      authorizationError: 'UNABLE_TO_VERIFY_LEAF_SIGNATURE',
      protocol: 'TLSv1.3',
      chain: [
        {
          subject: 'freebuff.com',
          issuer: 'Corp CA',
          validFrom: 0,
          validTo: 0,
        },
      ],
      caVariables: [],
    })
    expect(verdict.status).toBe('warn')
    expect(verdict.fix).toContain('NODE_EXTRA_CA_CERTS')
  })

  it('passes when node accepts the chain', () => {
    const verdict = classifyTlsChain({
      authorized: true,
      authorizationError: null,
      protocol: 'TLSv1.3',
      chain: [
        {
          subject: 'freebuff.com',
          issuer: "Let's Encrypt",
          validFrom: 0,
          validTo: 0,
        },
      ],
      caVariables: [],
    })
    expect(verdict.status).toBe('pass')
    expect(verdict.message).toContain("Let's Encrypt")
  })
})

describe('hosts-pin', () => {
  it('resolves the hosts file per platform', () => {
    expect(hostsFilePath('linux')).toBe('/etc/hosts')
    expect(hostsFilePath('win32', { SystemRoot: 'D:\\Win' })).toBe(
      'D:\\Win\\System32\\drivers\\etc\\hosts',
    )
  })

  it('ignores comments and blank lines, and allows inline comments', () => {
    const entries = parseHostsFile(
      ['# a comment', '', '127.0.0.1  freebuff.com  # pinned once', '  '].join(
        '\n',
      ),
    )
    expect(entries).toHaveLength(1)
    expect(entries[0]).toMatchObject({
      lineNumber: 3,
      address: '127.0.0.1',
      hosts: ['freebuff.com'],
    })
  })

  it('finds only entries naming a watched host', () => {
    const entries = parseHostsFile(
      ['127.0.0.1 internal.example', '10.0.0.1 freebuff.com'].join('\n'),
    )
    const pinned = findPinnedHosts(entries)
    expect(pinned).toHaveLength(1)
    expect(pinned[0]?.matched).toEqual(['freebuff.com'])
  })

  it('passes quietly when there is no hosts file', () => {
    const verdict = classifyHostsFile({
      platform: 'linux',
      display: '/etc/hosts',
      exists: false,
      readable: false,
      entries: [],
    })
    expect(verdict.status).toBe('pass')
  })

  it('fails when a watched host is pointed at loopback', () => {
    const files = parseHostsFile('127.0.0.1 freebuff.com')
    const verdict = classifyHostsFile({
      platform: 'linux',
      display: '/etc/hosts',
      exists: true,
      readable: true,
      entries: files,
    })
    expect(verdict.status).toBe('fail')
    expect(verdict.fix).toContain('/etc/hosts')
  })

  it('warns when a watched host is pinned to a public address', () => {
    const verdict = classifyHostsFile({
      platform: 'linux',
      display: '/etc/hosts',
      exists: true,
      readable: true,
      entries: parseHostsFile('93.184.216.34 freebuff.com'),
    })
    expect(verdict.status).toBe('warn')
  })

  it('skips when the file cannot be read', () => {
    const verdict = classifyHostsFile({
      platform: 'linux',
      display: '/etc/hosts',
      exists: true,
      readable: false,
      entries: [],
    })
    expect(verdict.status).toBe('skip')
  })
})

describe('split-state', () => {
  const base = { display: '~/.config/manicode', newestMs: 1000 }

  it('warns when history is stranded in the legacy directory', () => {
    const verdict = classifySplitState([
      { role: 'cli', label: 'CLI', sessions: 12, ...base },
      {
        role: 'legacy',
        label: 'Legacy Codebuff',
        sessions: 3,
        display: '~/.config/codebuff',
        newestMs: 500,
      },
    ])
    expect(verdict.status).toBe('warn')
    expect(verdict.message).toContain('old Codebuff directory')
  })

  it('treats CLI and desktop stores as expected', () => {
    const verdict = classifySplitState([
      { role: 'cli', label: 'CLI', sessions: 4, ...base },
      {
        role: 'desktop',
        label: 'Desktop app',
        sessions: 2,
        display: '~/.config/freebuff-desktop',
        newestMs: 900,
      },
    ])
    expect(verdict.status).toBe('pass')
    expect(verdict.details?.join(' ')).toContain('by design')
  })

  it('passes when there is one store or none', () => {
    expect(
      classifySplitState([{ role: 'cli', label: 'CLI', sessions: 2, ...base }])
        .status,
    ).toBe('pass')
    expect(classifySplitState([]).status).toBe('pass')
  })
})

describe('error-triage', () => {
  it('finds and counts actionable signatures, hard failures first', () => {
    const scan = scanLogTail(
      [
        'Connected fine',
        'Error: connect ECONNRESET',
        'Error: ENOSPC: no space left on device',
        'Error: ENOSPC: no space left on device',
      ].join('\n'),
    )
    expect(scan.hits[0]?.label).toBe('disk full')
    expect(scan.hits[0]?.count).toBe(2)
    expect(scan.hits[1]?.label).toBe('connection reset')
  })

  it('ignores ordinary log chatter', () => {
    expect(scanLogTail('starting up\nall good').hits).toHaveLength(0)
  })

  it('fails on a hard failure logged within the last day', () => {
    const verdict = classifyTriage({
      nothingToScan: false,
      files: [
        {
          display: '~/.config/manicode/output.log',
          ageHours: 2,
          hits: [
            {
              label: 'disk full',
              severity: 'hard',
              count: 1,
              excerpt: 'ENOSPC',
              advice: 'Free up space.',
            },
          ],
        },
      ],
    })
    expect(verdict.status).toBe('fail')
    expect(verdict.message).toContain('disk full')
  })

  it('only warns when the failure is old or soft', () => {
    const soft = classifyTriage({
      nothingToScan: false,
      files: [
        {
          display: 'log',
          ageHours: 3,
          hits: [
            {
              label: 'connection reset',
              severity: 'soft',
              count: 4,
              excerpt: 'ECONNRESET',
              advice: 'Check the VPN.',
            },
          ],
        },
      ],
    })
    expect(soft.status).toBe('warn')

    const old = classifyTriage({
      nothingToScan: false,
      files: [
        {
          display: 'log',
          ageHours: 24 * 10,
          hits: [
            {
              label: 'disk full',
              severity: 'hard',
              count: 1,
              excerpt: 'ENOSPC',
              advice: 'Free up space.',
            },
          ],
        },
      ],
    })
    expect(old.status).toBe('warn')
    expect(old.message).toContain('days ago')
  })

  it('passes when there is nothing to scan', () => {
    expect(classifyTriage({ files: [], nothingToScan: true }).status).toBe(
      'pass',
    )
  })
})

describe('cache-integrity', () => {
  function artifact(kind: CacheArtifact['kind'], bytes = 1024): CacheArtifact {
    return {
      kind,
      path: `C:\\state\\${kind === 'stale-engine' ? 'freebuff.exe.old.17' : 'engine.part'}`,
      display: kind === 'stale-engine' ? 'freebuff.exe.old.17' : 'engine.part',
      bytes,
      ageMs: 3_600_000,
    }
  }

  it('passes when there is no debris', () => {
    const verdict = classifyCache({
      platform: 'win32',
      scanned: ['~/.config/manicode'],
      artifacts: [],
      enginePresent: true,
    })
    expect(verdict.status).toBe('pass')
    expect(verdict.message).toContain('intact')
  })

  it('warns about superseded engine copies with the space they hold', () => {
    const verdict = classifyCache({
      platform: 'win32',
      scanned: [],
      artifacts: [artifact('stale-engine', 123_587_072)],
      enginePresent: true,
    })
    expect(verdict.status).toBe('warn')
    expect(verdict.message).toContain('118 MB')
    expect(verdict.fix).toContain('*.old.*')
  })

  it('prefers interrupted downloads over stale copies', () => {
    const verdict = classifyCache({
      platform: 'linux',
      scanned: [],
      artifacts: [artifact('partial-download'), artifact('stale-engine')],
      enginePresent: true,
    })
    expect(verdict.status).toBe('warn')
    expect(verdict.message).toContain('interrupted download')
    expect(verdict.fix).toContain('rm ')
  })
})

describe('auth-session', () => {
  it('reads epoch seconds, milliseconds and ISO strings', () => {
    expect(readExpiry(1_800_000_000)).toBe(1_800_000_000_000)
    expect(readExpiry(1_800_000_000_000)).toBe(1_800_000_000_000)
    expect(readExpiry('2030-01-01T00:00:00.000Z')).toBe(
      Date.parse('2030-01-01T00:00:00.000Z'),
    )
    expect(readExpiry('nonsense')).toBeNull()
    expect(readExpiry(null)).toBeNull()
  })

  it('finds a nested token and an expiry without reading values out', () => {
    const inspected = inspectCredentialPayload({
      account: { email: 'a@b.example' },
      tokens: { accessToken: 'abcdefghijklmnop', expires_at: 1_800_000_000 },
    })
    expect(inspected.hasToken).toBe(true)
    expect(inspected.expiresAt).toBe(1_800_000_000_000)
    expect(inspected.keys).toEqual(['account', 'tokens'])
  })

  it('recognises the real credential shape, with the token one level down', () => {
    // Matches what Freebuff actually writes: { default: { authToken, ... } }.
    const inspected = inspectCredentialPayload({
      default: {
        id: 'abc',
        name: 'someone',
        email: 'someone@example.com',
        authToken: 'abcdefghijklmnopqrstuvwxyz',
        fingerprintId: 'fp',
        fingerprintHash: 'hash',
      },
    })
    expect(inspected.hasToken).toBe(true)
    expect(inspected.keys).toEqual(['default'])
  })

  it('does not treat fingerprints as tokens', () => {
    const inspected = inspectCredentialPayload({
      default: { fingerprintId: 'abc123', fingerprintHash: 'def456' },
    })
    expect(inspected.hasToken).toBe(false)
  })

  it('passes when no credential file exists', () => {
    expect(classifyCredentials(null).status).toBe('pass')
  })

  function facts(overrides: Partial<CredentialFacts> = {}): CredentialFacts {
    return {
      platform: 'linux',
      display: '~/.config/manicode/credentials.json',
      bytes: 364,
      ageMs: 3_600_000,
      readable: true,
      mode: 0o600,
      parsed: true,
      hasToken: true,
      expiresAt: null,
      keys: ['token'],
      ...overrides,
    }
  }

  it('fails on unparseable credentials', () => {
    const verdict = classifyCredentials(facts({ parsed: false }))
    expect(verdict.status).toBe('fail')
    expect(verdict.fix).toContain('rm ')
  })

  it('warns when the saved login expired', () => {
    const verdict = classifyCredentials(
      facts({ expiresAt: Date.now() - 86_400_000 }),
    )
    expect(verdict.status).toBe('warn')
    expect(verdict.message).toContain('expired')
  })

  it('warns when a credential file holds no token', () => {
    expect(classifyCredentials(facts({ hasToken: false })).status).toBe('warn')
  })

  it('warns when other accounts can read the file', () => {
    const verdict = classifyCredentials(facts({ mode: 0o644 }))
    expect(verdict.status).toBe('warn')
    expect(verdict.fix).toContain('chmod 600')
  })

  it('passes for a healthy credential file', () => {
    const verdict = classifyCredentials(
      facts({ expiresAt: Date.now() + 86_400_000 }),
    )
    expect(verdict.status).toBe('pass')
    expect(verdict.message).toContain('valid until')
  })
})

describe('command-shadowing', () => {
  it('finds repeated PATH entries, case-insensitively on Windows', () => {
    expect(
      duplicatePathEntries('/usr/bin:/usr/local/bin:/usr/bin', 'linux'),
    ).toEqual(['/usr/bin'])
    expect(duplicatePathEntries('C:\\Bin;C:\\bin;C:\\Tools', 'win32')).toEqual([
      'C:\\bin',
    ])
  })

  it('passes when a single command is on PATH', () => {
    const verdict = classifyShadowing({
      platform: 'linux',
      command: 'freebuff',
      matches: ['/usr/local/bin/freebuff'],
      duplicatePathEntries: [],
    })
    expect(verdict.status).toBe('pass')
  })

  it('warns and marks which copy actually runs', () => {
    const verdict = classifyShadowing({
      platform: 'linux',
      command: 'freebuff',
      matches: ['/usr/local/bin/freebuff', '/home/u/.nvm/bin/freebuff'],
      duplicatePathEntries: [],
    })
    expect(verdict.status).toBe('warn')
    expect(verdict.details?.[0]).toContain('Runs')
    expect(verdict.details?.[1]).toContain('Shadowed')
  })

  it('warns about duplicate PATH entries on their own', () => {
    const verdict = classifyShadowing({
      platform: 'linux',
      command: 'freebuff',
      matches: [],
      duplicatePathEntries: ['/usr/bin'],
    })
    expect(verdict.status).toBe('warn')
    expect(verdict.message).toContain('/usr/bin')
  })
})

describe('watcher-limits', () => {
  it('says nothing needs tuning on Windows', () => {
    const verdict = classifyWatcherLimits({
      platform: 'win32',
      maxUserWatches: null,
      maxUserInstances: null,
      maxFiles: null,
      maxFilesPerProc: null,
    })
    expect(verdict.status).toBe('pass')
    expect(verdict.message).toContain('no per-user file-watch limit')
  })

  it('warns about a low Linux watch limit with the sysctl to raise it', () => {
    const verdict = classifyWatcherLimits({
      platform: 'linux',
      maxUserWatches: 8192,
      maxUserInstances: 128,
      maxFiles: null,
      maxFilesPerProc: null,
    })
    expect(verdict.status).toBe('warn')
    expect(verdict.fix).toContain('fs.inotify.max_user_watches')
  })

  it('passes a healthy Linux limit and skips an unreadable one', () => {
    expect(
      classifyWatcherLimits({
        platform: 'linux',
        maxUserWatches: 524_288,
        maxUserInstances: 1024,
        maxFiles: null,
        maxFilesPerProc: null,
      }).status,
    ).toBe('pass')

    expect(
      classifyWatcherLimits({
        platform: 'linux',
        maxUserWatches: null,
        maxUserInstances: null,
        maxFiles: null,
        maxFilesPerProc: null,
      }).status,
    ).toBe('skip')
  })

  it('warns about a low macOS file limit', () => {
    const verdict = classifyWatcherLimits({
      platform: 'darwin',
      maxUserWatches: null,
      maxUserInstances: null,
      maxFiles: 256,
      maxFilesPerProc: 256,
    })
    expect(verdict.status).toBe('warn')
    expect(verdict.fix).toContain('kern.maxfiles')
  })
})

describe('temp-health', () => {
  it('prefers TMPDIR, then TEMP, then TMP', () => {
    expect(tempDirectory({ TMPDIR: '/a', TEMP: '/b' })).toBe('/a')
    expect(tempDirectory({ TEMP: '/b' })).toBe('/b')
    expect(tempDirectory({ TMP: '/c' })).toBe('/c')
    expect(tempDirectory({}).length).toBeGreaterThan(0)
  })

  function facts(overrides = {}) {
    return {
      platform: 'linux' as NodeJS.Platform,
      display: '/tmp',
      exists: true,
      writable: true,
      freeBytes: 40 * 1024 ** 3,
      entryCount: 10,
      staleCount: 0,
      staleBytes: 0,
      capped: false,
      ...overrides,
    }
  }

  it('fails when the directory is missing or unwritable', () => {
    expect(classifyTemp(facts({ exists: false })).status).toBe('fail')
    expect(classifyTemp(facts({ writable: false })).status).toBe('fail')
  })

  it('fails when there is no room, and warns when space is tight', () => {
    expect(classifyTemp(facts({ freeBytes: 100 * 1024 ** 2 })).status).toBe(
      'fail',
    )
    expect(classifyTemp(facts({ freeBytes: 2 * 1024 ** 3 })).status).toBe(
      'warn',
    )
  })

  it('warns about a clogged temp directory', () => {
    const verdict = classifyTemp(
      facts({ staleCount: 9000, staleBytes: 6 * 1024 ** 3 }),
    )
    expect(verdict.status).toBe('warn')
    expect(verdict.fix).toContain('rm -rf')
  })

  it('passes a healthy temp directory', () => {
    expect(classifyTemp(facts()).status).toBe('pass')
  })
})

describe('path-length', () => {
  const base = { scanned: 10, capped: false }

  it('is a no-op off Windows', () => {
    const verdict = classifyPathLength({
      platform: 'linux',
      ...base,
      longest: { display: '/a', length: 400 },
      overFail: [],
      overWarn: [],
    })
    expect(verdict.status).toBe('pass')
    expect(verdict.message).toContain('does not impose')
  })

  it('fails when a path is at the Windows limit', () => {
    const verdict = classifyPathLength({
      platform: 'win32',
      ...base,
      longest: { display: 'C:\\long', length: 275 },
      overFail: ['C:\\long'],
      overWarn: [],
    })
    expect(verdict.status).toBe('fail')
    expect(verdict.fix).toContain('core.longpaths')
  })

  it('warns when paths only approach the limit', () => {
    const verdict = classifyPathLength({
      platform: 'win32',
      ...base,
      longest: { display: 'C:\\near', length: 210 },
      overFail: [],
      overWarn: ['C:\\near'],
    })
    expect(verdict.status).toBe('warn')
  })

  it('passes when every path is short', () => {
    const verdict = classifyPathLength({
      platform: 'win32',
      ...base,
      longest: { display: 'C:\\short', length: 40 },
      overFail: [],
      overWarn: [],
    })
    expect(verdict.status).toBe('pass')
  })
})

describe('port-availability', () => {
  it('parses Windows netstat listening lines only', () => {
    const listeners = parseNetstatListeners(
      [
        '  TCP    0.0.0.0:135    0.0.0.0:0    LISTENING    1024',
        '  TCP    [::]:3000      [::]:0       LISTENING    4321',
        '  TCP    127.0.0.1:5555 127.0.0.1:9  ESTABLISHED  999',
      ].join('\n'),
    )
    expect(listeners).toEqual([
      { port: 135, address: '0.0.0.0', pid: 1024 },
      { port: 3000, address: '[::]', pid: 4321 },
    ])
  })

  it('parses ss and lsof listener output', () => {
    expect(
      parseSsListeners(
        'LISTEN 0 511 0.0.0.0:3000 0.0.0.0:* users:(("freebuff",pid=77,fd=20))',
      ),
    ).toEqual([{ port: 3000, address: '', pid: 77 }])

    expect(
      parseLsofListeners(
        [
          'COMMAND PID USER FD TYPE NAME',
          'freebuff 88 u 20u IPv4 TCP *:5173 (LISTEN)',
        ].join('\n'),
      ),
    ).toEqual([{ port: 5173, address: '*:5173', pid: 88 }])
  })

  it('parses process lists on both platforms', () => {
    expect(
      parseProcesses('"freebuff.exe","4242","Console","1","100 K"', 'win32'),
    ).toEqual([{ pid: 4242, name: 'freebuff.exe' }])
    expect(parseProcesses('  91 /usr/bin/freebuff\n', 'linux')).toEqual([
      { pid: 91, name: '/usr/bin/freebuff' },
    ])
  })

  it('passes when Freebuff is not running', () => {
    const verdict = classifyPorts({
      platform: 'linux',
      processes: [{ pid: 1, name: 'systemd' }],
      listeners: [],
      listenersKnown: true,
    })
    expect(verdict.status).toBe('pass')
  })

  it('warns when two Freebuff processes are listening at once', () => {
    const verdict = classifyPorts({
      platform: 'linux',
      processes: [
        { pid: 100, name: 'freebuff' },
        { pid: 200, name: 'freebuff' },
      ],
      listeners: [
        { port: 3000, address: '', pid: 100 },
        { port: 3001, address: '', pid: 200 },
      ],
      listenersKnown: true,
    })
    expect(verdict.status).toBe('warn')
    expect(verdict.message).toContain('3000, 3001')
    expect(verdict.fix).toContain('kill -9 200')
  })

  it('passes a single listening instance', () => {
    const verdict = classifyPorts({
      platform: 'linux',
      processes: [{ pid: 100, name: 'freebuff' }],
      listeners: [{ port: 3000, address: '', pid: 100 }],
      listenersKnown: true,
    })
    expect(verdict.status).toBe('pass')
    expect(verdict.message).toContain('3000')
  })

  it('notes when the socket table was unavailable', () => {
    const verdict = classifyPorts({
      platform: 'darwin',
      processes: [{ pid: 100, name: 'freebuff' }],
      listeners: [],
      listenersKnown: false,
    })
    expect(verdict.status).toBe('pass')
    expect(verdict.message).toContain('could not be read')
  })
})
