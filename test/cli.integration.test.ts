import { spawnSync } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const cli = path.join(root, 'dist', 'cli.js')
const manifest = JSON.parse(
  readFileSync(path.join(root, 'package.json'), 'utf8'),
) as {
  version: string
}

interface RunResult {
  stdout: string
  stderr: string
  status: number
}

function run(args: string[], env: NodeJS.ProcessEnv = {}): RunResult {
  const result = spawnSync(process.execPath, [cli, ...args], {
    encoding: 'utf8',
    timeout: 120_000,
    cwd: root,
    env: { ...process.env, NO_COLOR: '1', CI: '1', ...env },
  })
  return {
    stdout: result.stdout ?? '',
    stderr: result.stderr ?? '',
    status: result.status ?? -1,
  }
}

// The integration tests exercise the real binary, so they need `npm run build`
// to have produced dist/. They are skipped (not failed) on a bare `npm test`.
describe.skipIf(!existsSync(cli))('fbdoc CLI', () => {
  it('reports its version', () => {
    const result = run(['--version'])
    expect(result.status).toBe(0)
    expect(result.stdout.trim()).toBe(manifest.version)
  })

  it('reports the version through the short flag too', () => {
    expect(run(['-v']).stdout.trim()).toBe(manifest.version)
  })

  it('prints help listing every command and the exit codes', () => {
    const result = run(['--help'])
    expect(result.status).toBe(0)
    for (const command of [
      'check',
      'faq',
      'wizard',
      'report',
      'menu',
      'checks',
    ]) {
      expect(result.stdout).toContain(command)
    }
    expect(result.stdout).toContain('Exit codes')
  })

  it('fails politely on an unknown command', () => {
    const result = run(['definitely-not-a-command'])
    expect(result.status).toBe(1)
    expect(result.stderr).toMatch(/fbdoc --help/)
    expect(result.stderr).not.toMatch(/\bat .*\.js:\d+/)
  })

  it('lists the diagnostic checks', () => {
    const result = run(['checks'])
    expect(result.status).toBe(0)
    expect(result.stdout).toContain('node-runtime')
    expect(result.stdout.trim().split('\n')).toHaveLength(9)
  })

  it('emits parseable JSON that matches the exit code contract', () => {
    const result = run(['check', '--json', '--offline'])
    const payload = JSON.parse(result.stdout) as {
      ok: boolean
      summary: {
        total: number
        pass: number
        warn: number
        fail: number
        skip: number
      }
      meta: { doctor: string; offline: boolean }
      nextAction: { message: string } | null
      checks: Array<{ id: string; status: string; offline?: boolean }>
    }

    expect(payload.meta.doctor).toBe(manifest.version)
    expect(payload.meta.offline).toBe(true)
    expect(payload.checks).toHaveLength(9)
    expect(payload.summary.total).toBe(9)

    const counted =
      payload.summary.pass +
      payload.summary.warn +
      payload.summary.fail +
      payload.summary.skip
    expect(counted).toBe(9)
    expect(payload.ok).toBe(payload.summary.fail === 0)
    expect(result.status).toBe(payload.summary.fail > 0 ? 1 : 0)

    // --offline must not touch the network.
    const dns = payload.checks.find((check) => check.id === 'dns')
    const network = payload.checks.find((check) => check.id === 'network')
    expect(dns?.status).toBe('skip')
    expect(network?.status).toBe('skip')
  })

  it('finds the right FAQ section from a loose phrase', () => {
    const result = run(['faq', 'cant connect'])
    expect(result.status).toBe(0)
    expect(result.stdout).toContain('Network Issues')
    expect(result.stdout).toContain('8.8.8.8')
  })

  it('exits 1 when nothing matches the FAQ query', () => {
    const result = run(['faq', 'zzzqqqxxyy'])
    expect(result.status).toBe(1)
    expect(result.stdout).toMatch(/No FAQ section matched/i)
  })

  it('lists every FAQ section', () => {
    const result = run(['faq', '--list'])
    expect(result.status).toBe(0)
    expect(result.stdout).toContain('Network Issues')
    expect(result.stdout).toContain('Privacy')
  })

  it('returns FAQ matches as JSON', () => {
    const result = run(['faq', 'freebucks', '--json'])
    const payload = JSON.parse(result.stdout) as {
      matches: Array<{ slug: string }>
    }
    expect(payload.matches.length).toBeGreaterThan(1)
    expect(payload.matches[0]?.slug).toMatch(/^freebucks-/)
  })

  it('respects NO_COLOR and never emits escape codes when piped', () => {
    const result = run(['check', '--offline'])
    expect(result.stdout).not.toContain('\u001b[')
    expect(result.stderr).not.toContain('\u001b[')
  })

  it('honours the --only filter', () => {
    const result = run([
      'check',
      '--json',
      '--offline',
      '--only',
      'node-runtime,storage',
    ])
    const payload = JSON.parse(result.stdout) as {
      checks: Array<{ id: string }>
    }
    expect(payload.checks.map((check) => check.id)).toEqual([
      'node-runtime',
      'storage',
    ])
  })

  it('produces a redacted, Discord-ready support report', () => {
    const result = run(['report', '--offline'])
    expect(result.status).toBe(0)
    expect(result.stdout).toContain('**Freebuff Doctor report**')
    expect(result.stdout).toContain('**Findings**')
    expect(result.stdout).toContain('freebuff-doctor')
    // The user's home directory must never appear verbatim.
    const home = process.env.USERPROFILE ?? process.env.HOME ?? ''
    if (home && !home.includes('[redacted')) {
      const normalized = result.stdout.replace(/\\/g, '/').toLowerCase()
      expect(normalized).not.toContain(home.replace(/\\/g, '/').toLowerCase())
    }
  })

  it('writes the report to a file with --output', () => {
    const target = path.join(root, '.fbdoc-integration-report.md')
    try {
      const result = run(['report', '--offline', '--output', target])
      expect(result.status).toBe(0)
      expect(existsSync(target)).toBe(true)
      expect(readFileSync(target, 'utf8')).toContain(
        '**Freebuff Doctor report**',
      )
    } finally {
      if (existsSync(target)) {
        spawnSync(process.execPath, [
          '-e',
          `require('fs').unlinkSync(${JSON.stringify(target)})`,
        ])
      }
    }
  })
})
