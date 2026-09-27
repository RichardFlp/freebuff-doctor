import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'

import { classifyCrashLog, readTail } from '../src/checks/crash-log.js'
import { classifyAddress, classifyDns } from '../src/checks/dns.js'
import { detectProxy } from '../src/checks/network.js'
import {
  analyzeNodeInstalls,
  classifyNodeManager,
} from '../src/checks/node-conflicts.js'
import { summarize, type CheckResult } from '../src/checks/types.js'
import { readDiskUsage, WARN_FREE_BYTES } from '../src/checks/storage.js'
import { exitCodeFor } from '../src/commands/check.js'
import {
  defaultOptions,
  parseOnly,
  parseTimeout,
} from '../src/commands/options.js'
import { formatBytes } from '../src/util/fs-scan.js'
import { redact, redactWithStats } from '../src/util/redact.js'
import {
  compareVersions,
  isOutdated,
  parseVersion,
} from '../src/util/semver.js'
import { slugifyHeading } from '../src/faq/loader.js'

function makeResult(
  partial: Partial<CheckResult> & { id: string; status: CheckResult['status'] },
): CheckResult {
  return {
    title: partial.id,
    message: 'message',
    durationMs: 1,
    ...partial,
  }
}

describe('classifyAddress', () => {
  it('flags addresses that should never answer for a public hostname', () => {
    expect(classifyAddress('10.0.0.5')).toBe('private')
    expect(classifyAddress('192.168.1.1')).toBe('private')
    expect(classifyAddress('172.20.10.1')).toBe('private')
    expect(classifyAddress('127.0.0.1')).toBe('loopback')
    expect(classifyAddress('169.254.10.1')).toBe('link-local')
    expect(classifyAddress('100.100.1.1')).toBe('cgnat')
    expect(classifyAddress('0.0.0.0')).toBe('reserved')
    expect(classifyAddress('not-an-ip')).toBe('invalid')
  })

  it('treats real public addresses as public', () => {
    expect(classifyAddress('8.8.8.8')).toBe('public')
    expect(classifyAddress('216.24.57.1')).toBe('public')
    expect(classifyAddress('2606:4700::1111')).toBe('public')
  })

  it('handles IPv6 special cases', () => {
    expect(classifyAddress('::1')).toBe('loopback')
    expect(classifyAddress('fd00::1')).toBe('private')
    expect(classifyAddress('fe80::1')).toBe('link-local')
    expect(classifyAddress('::ffff:93.184.216.34')).toBe('public')
    expect(classifyAddress('::ffff:127.0.0.1')).toBe('loopback')
  })
})

describe('classifyDns', () => {
  const base = {
    host: 'freebuff.com',
    systemAddresses: [] as string[],
    systemError: null,
    publicAddresses: [] as string[],
    publicError: null,
  }

  it('passes when both resolvers agree on a public address', () => {
    const verdict = classifyDns({
      ...base,
      systemAddresses: ['1.1.1.1'],
      publicAddresses: ['1.1.1.1'],
    })
    expect(verdict.status).toBe('pass')
  })

  it('fails when the answer is hijacked to a private range', () => {
    const verdict = classifyDns({
      ...base,
      systemAddresses: ['192.168.1.50'],
      publicAddresses: ['216.24.57.1'],
    })
    expect(verdict.status).toBe('fail')
    expect(verdict.message).toMatch(/private/i)
  })

  it('warns when the local resolver disagrees with public DNS', () => {
    const verdict = classifyDns({
      ...base,
      systemAddresses: ['93.184.216.34'],
      publicAddresses: ['216.24.57.1'],
    })
    expect(verdict.status).toBe('warn')
    expect(verdict.message).toMatch(/different answer/i)
  })

  it('fails when only public DNS can resolve the host', () => {
    const verdict = classifyDns({
      ...base,
      systemError: 'no records found',
      publicAddresses: ['216.24.57.1'],
    })
    expect(verdict.status).toBe('fail')
    expect(verdict.details.join(' ')).toContain('216.24.57.1')
  })

  it('fails when nothing resolves the host', () => {
    const verdict = classifyDns({
      ...base,
      systemError: 'timed out',
      publicError: 'timed out',
    })
    expect(verdict.status).toBe('fail')
  })

  it('warns about carrier-grade NAT addresses', () => {
    const verdict = classifyDns({
      ...base,
      systemAddresses: ['100.72.3.4'],
      publicAddresses: ['100.72.3.4'],
    })
    expect(verdict.status).toBe('warn')
    expect(verdict.message).toMatch(/NAT/i)
  })
})

describe('detectProxy', () => {
  it('finds the common proxy variables', () => {
    expect(detectProxy({ HTTPS_PROXY: 'http://127.0.0.1:8080' })).toEqual({
      variable: 'HTTPS_PROXY',
      value: 'http://127.0.0.1:8080',
    })
    expect(
      detectProxy({ https_proxy: 'http://127.0.0.1:8080' })?.variable,
    ).toBe('https_proxy')
    expect(detectProxy({})).toBeNull()
    expect(detectProxy({ HTTPS_PROXY: '   ' })).toBeNull()
  })
})

describe('classifyNodeManager', () => {
  it('identifies install managers from resolved paths', () => {
    expect(
      classifyNodeManager('/Users/me/.nvm/versions/node/v22.1.0/bin/node'),
    ).toBe('nvm')
    expect(
      classifyNodeManager('/opt/homebrew/Cellar/node/22.1.0/bin/node'),
    ).toBe('homebrew')
    expect(
      classifyNodeManager(
        '/home/me/.local/share/fnm/node-versions/v22/bin/node',
      ),
    ).toBe('fnm')
    expect(classifyNodeManager('/home/me/.volta/bin/node')).toBe('volta')
    expect(classifyNodeManager('C:\\Program Files\\nodejs\\node.EXE')).toBe(
      'system',
    )
    expect(
      classifyNodeManager(
        'C:\\Users\\me\\AppData\\Roaming\\nvm\\v22.1.0\\node.exe',
      ),
    ).toBe('nvm')
    expect(
      classifyNodeManager(
        'C:\\Users\\me\\AppData\\Local\\OpenAI\\Codex\\bin\\node.EXE',
      ),
    ).toBe('bundled')
    expect(classifyNodeManager('/weird/place/node')).toBe('unknown')
  })
})

describe('analyzeNodeInstalls', () => {
  it('reports no conflict for a single install', () => {
    const analysis = analyzeNodeInstalls(['/usr/bin/node'])
    expect(analysis.conflict).toBe(false)
    expect(analysis.managers).toEqual(['system'])
  })

  it('flags the Homebrew plus nvm combination from the FAQ', () => {
    const analysis = analyzeNodeInstalls([
      '/opt/homebrew/Cellar/node/22.1.0/bin/node',
      '/Users/me/.nvm/versions/node/v20.11.0/bin/node',
    ])
    expect(analysis.conflict).toBe(true)
    expect(analysis.managers).toEqual(['nvm', 'homebrew'])
  })

  it('does not treat an app-bundled runtime as a competing install', () => {
    const analysis = analyzeNodeInstalls([
      'C:\\Program Files\\nodejs\\node.exe',
      'C:\\Users\\me\\AppData\\Local\\OpenAI\\Codex\\bin\\node.exe',
    ])
    expect(analysis.conflict).toBe(false)
    expect(analysis.extras).toHaveLength(1)
    expect(analysis.extras[0]?.manager).toBe('bundled')
  })

  it('de-duplicates repeated paths', () => {
    const analysis = analyzeNodeInstalls(['/usr/bin/node', '/usr/bin/node'])
    expect(analysis.byManager.get('system')).toEqual(['/usr/bin/node'])
  })
})

describe('classifyCrashLog', () => {
  const now = Date.UTC(2026, 0, 2, 12)
  const hour = 3_600_000

  it('surfaces a recent fatal error with excerpts', () => {
    const verdict = classifyCrashLog(
      [
        'info: starting up',
        'FATAL ERROR: JavaScript heap out of memory',
        'info: bye',
      ].join('\n'),
      now - 2 * hour,
      now,
    )
    expect(verdict.fatal).toBe(true)
    expect(verdict.recent).toBe(true)
    expect(verdict.labels).toContain('fatal error')
    expect(verdict.excerpts).toHaveLength(1)
  })

  it('does not alarm about an old crash', () => {
    const verdict = classifyCrashLog(
      'FATAL ERROR: boom',
      now - 30 * 24 * hour,
      now,
    )
    expect(verdict.fatal).toBe(true)
    expect(verdict.recent).toBe(false)
    expect(verdict.ageHours).toBeGreaterThan(700)
  })

  it('ignores ordinary chatter', () => {
    const verdict = classifyCrashLog(
      ['info: connected', 'warn: slow response', 'info: done'].join('\n'),
      now,
      now,
    )
    expect(verdict.fatal).toBe(false)
    expect(verdict.excerpts).toEqual([])
  })

  it('recognises unhandled rejections and disk-full errors', () => {
    expect(
      classifyCrashLog('Unhandled rejection: ENOENT', now, now).fatal,
    ).toBe(true)
    expect(
      classifyCrashLog('Error: ENOSPC: no space left on device', now, now)
        .fatal,
    ).toBe(true)
  })
})

describe('readTail', () => {
  it('reads only the end of a large file', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'fbdoc-'))
    const file = path.join(dir, 'orchestrator-stderr.log')
    const body = `${'x'.repeat(5000)}\nFIRST\n${'y'.repeat(5000)}\nLAST\n`
    writeFileSync(file, body)
    const tail = readTail(file, 100)
    expect(tail).toContain('LAST')
    expect(tail).not.toContain('FIRST')
    expect(tail.length).toBeLessThanOrEqual(100)
  })

  it('returns an empty string for a missing file', () => {
    expect(readTail(path.join(tmpdir(), 'fbdoc-does-not-exist.log'))).toBe('')
  })
})

describe('storage helpers', () => {
  it('reads disk usage for the current directory', () => {
    const usage = readDiskUsage(process.cwd())
    expect(usage).not.toBeNull()
    expect(usage?.freeBytes).toBeGreaterThan(0)
    expect(usage?.totalBytes).toBeGreaterThanOrEqual(usage?.freeBytes ?? 0)
  })

  it('formats byte counts for humans', () => {
    expect(formatBytes(0)).toBe('0 B')
    expect(formatBytes(1536)).toBe('1.5 KB')
    expect(formatBytes(WARN_FREE_BYTES)).toBe('2 GB')
    expect(formatBytes(-1)).toBe('unknown')
  })
})

describe('summarize', () => {
  it('counts statuses and reports ok when nothing failed', () => {
    const summary = summarize([
      makeResult({ id: 'a', status: 'pass' }),
      makeResult({ id: 'b', status: 'warn' }),
      makeResult({ id: 'c', status: 'skip' }),
    ])
    expect(summary).toMatchObject({
      total: 3,
      pass: 1,
      warn: 1,
      fail: 0,
      skip: 1,
      ok: true,
    })
  })

  it('prefers a failure over a warning for the next action', () => {
    const summary = summarize([
      makeResult({
        id: 'a',
        status: 'warn',
        title: 'Warning',
        fix: 'npm i -g freebuff',
      }),
      makeResult({ id: 'b', status: 'fail', title: 'Failure' }),
    ])
    expect(summary.ok).toBe(false)
    expect(summary.nextAction?.message).toContain('Failure')
  })

  it('has no next action when everything passes', () => {
    expect(
      summarize([makeResult({ id: 'a', status: 'pass' })]).nextAction,
    ).toBeNull()
  })
})

describe('exitCodeFor', () => {
  it('exits 0 for passes and warnings', () => {
    expect(exitCodeFor([makeResult({ id: 'a', status: 'pass' })], false)).toBe(
      0,
    )
    expect(exitCodeFor([makeResult({ id: 'a', status: 'warn' })], false)).toBe(
      0,
    )
  })

  it('exits 1 on a failure, and on a warning when --strict is set', () => {
    expect(exitCodeFor([makeResult({ id: 'a', status: 'fail' })], false)).toBe(
      1,
    )
    expect(exitCodeFor([makeResult({ id: 'a', status: 'warn' })], true)).toBe(1)
    expect(exitCodeFor([makeResult({ id: 'a', status: 'skip' })], true)).toBe(0)
  })
})

describe('option parsing', () => {
  it('clamps --timeout', () => {
    expect(parseTimeout('5000')).toBe(5000)
    expect(parseTimeout('10')).toBe(1000)
    expect(parseTimeout('999999')).toBe(60_000)
    expect(parseTimeout('nonsense')).toBe(8000)
    expect(parseTimeout(undefined)).toBe(8000)
  })

  it('parses --only', () => {
    expect(parseOnly('dns,network')).toEqual(['dns', 'network'])
    expect(parseOnly(' dns , network ')).toEqual(['dns', 'network'])
    expect(parseOnly('')).toBeUndefined()
    expect(parseOnly(undefined)).toBeUndefined()
  })

  it('builds sane defaults', () => {
    const options = defaultOptions()
    expect(options).toMatchObject({
      verbose: false,
      offline: false,
      json: false,
      strict: false,
    })
    expect(options.timeoutMs).toBe(8000)
  })
})

describe('redaction', () => {
  it('removes tokens, keys and emails', () => {
    const input = [
      'email me at someone@example.com',
      'token sk-abcdefghijklmnopqrstuvwxyz0123',
      'npm token //registry.npmjs.org/:_authToken=npm_abcdefghijklmnopqrst',
      'Authorization: Bearer abcdefghijklmnopqrstuvwx',
      'apiKey = "AIzaSyA1234567890abcdefghijklmnopqrstu"',
      'ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZ012345',
    ].join('\n')
    const output = redact(input)
    expect(output).toContain('[redacted email]')
    expect(output).not.toContain('someone@example.com')
    expect(output).not.toContain('sk-abcdefghijklmnopqrstuvwxyz0123')
    expect(output).not.toContain('npm_abcdefghijklmnopqrst')
    expect(output).not.toContain('abcdefghijklmnopqrstuvwx')
    expect(output).not.toContain('ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZ012345')
  })

  it('leaves ordinary diagnostic text alone', () => {
    const input = [
      'Node.js v24.13.0 with npm 11.6.2.',
      'freebuff 0.0.118 is behind the latest release (0.1.2).',
      'Reached https://freebuff.com/ in 690 ms and the npm registry is reachable.',
      'Only one Node.js install was found on PATH (a system installer).',
    ].join('\n')
    expect(redact(input)).toBe(input)
  })

  it('reports what it changed', () => {
    const result = redactWithStats('mail me at a@b.co', '/home/nobody')
    expect(result.redactions).toBe(1)
    expect(result.text).toContain('[redacted email]')

    const untouched = redactWithStats('all good', '/home/nobody')
    expect(untouched.redactions).toBe(0)
    expect(untouched.anonymized).toBe(false)
  })
})

describe('semver helpers', () => {
  it('parses and compares versions', () => {
    expect(parseVersion('v1.2.3')).toMatchObject({
      major: 1,
      minor: 2,
      patch: 3,
    })
    expect(parseVersion('nonsense')).toBeNull()
    expect(compareVersions('1.0.0', '1.0.1')).toBe(-1)
    expect(compareVersions('2.0.0', '1.9.9')).toBe(1)
    expect(compareVersions('1.0.0', '1.0.0')).toBe(0)
    expect(compareVersions('1.0.0-beta.1', '1.0.0')).toBe(-1)
  })

  it('detects outdated installs', () => {
    expect(isOutdated('0.0.118', '0.1.2')).toBe(true)
    expect(isOutdated('0.1.2', '0.1.2')).toBe(false)
    expect(isOutdated('0.2.0', '0.1.2')).toBe(false)
    expect(isOutdated('unknown', '0.1.2')).toBe(false)
  })
})

describe('slugifyHeading', () => {
  it('produces GitHub-compatible anchors', () => {
    expect(slugifyHeading('Network Issues')).toBe('network-issues')
    expect(slugifyHeading('Known Bugs & Status Notes')).toBe(
      'known-bugs--status-notes',
    )
  })
})
