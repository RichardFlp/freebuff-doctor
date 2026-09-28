import { spawnSync } from 'node:child_process'
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
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
      'export',
      'ask',
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

  it('offers --no-self-update, and never updates in a pipe', () => {
    expect(run(['--help']).stdout).toContain('--no-self-update')
    expect(run(['menu', '--help']).stdout).toContain('--no-self-update')

    // Without a terminal the menu runs the diagnostics instead, so a script or
    // CI job must never see an update check or a global install.
    const piped = run(['menu', '--offline', '--no-self-update'])
    expect(piped.status).toBe(0)
    expect(piped.stderr).toContain('No interactive terminal detected')
    // The diagnostics themselves say "available" (free space, updates that may
    // exist), so match the update notice's own wording instead.
    const notice = /is available \(you are on|Updated to |behind origin\/main/
    expect(piped.stdout).not.toMatch(notice)
    expect(piped.stderr).not.toMatch(notice)
  })

  it('lists the diagnostic checks', () => {
    const result = run(['checks'])
    expect(result.status).toBe(0)
    expect(result.stdout).toContain('node-runtime')
    expect(result.stdout).toContain('config-health')
    expect(result.stdout).toContain('state-growth')
    expect(result.stdout).toContain('proxy-trust')
    expect(result.stdout).toContain('30 diagnostic checks')
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
    expect(payload.checks).toHaveLength(30)
    expect(payload.summary.total).toBe(30)

    const counted =
      payload.summary.pass +
      payload.summary.warn +
      payload.summary.fail +
      payload.summary.skip
    expect(counted).toBe(30)
    expect(payload.ok).toBe(payload.summary.fail === 0)
    expect(result.status).toBe(payload.summary.fail > 0 ? 1 : 0)

    // --offline must not touch the network. clock-skew still audits the local
    // TLS environment, so it only reports skip when nothing is wrong there.
    const dns = payload.checks.find((check) => check.id === 'dns')
    const network = payload.checks.find((check) => check.id === 'network')
    expect(dns?.status).toBe('skip')
    expect(network?.status).toBe('skip')
    expect(['skip', 'warn']).toContain(
      payload.checks.find((check) => check.id === 'clock-skew')?.status,
    )
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

  it('never leaks the home directory through JSON-escaped paths', () => {
    // JSON doubles every backslash, so a plain substring check on the raw text
    // can miss a leak: collapse separator runs and compare that instead.
    const home = process.env.USERPROFILE ?? process.env.HOME ?? ''
    if (!home || home.includes('[redacted')) return
    const needle = home.replace(/\\/g, '/').replace(/\/+/g, '/').toLowerCase()
    const result = run(['export', '--offline', '--stdout'])
    const normalized = result.stdout
      .replace(/\\/g, '/')
      .replace(/\/+/g, '/')
      .toLowerCase()
    expect(normalized).not.toContain(needle)
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

  it('prints the detailed helper report with --stdout', () => {
    const result = run(['export', '--offline', '--stdout'])
    expect(result.status).toBe(0)
    expect(result.stdout).toContain('# Freebuff Doctor — detailed report')
    expect(result.stdout).toContain('## Every check')
    expect(result.stdout).toContain('## Findings in detail')
    expect(result.stdout).toContain('## Machine-readable results')
    // stdout must be the document and nothing else.
    expect(result.stdout).not.toContain('Exported a detailed report')
  })

  it('exports a detailed report to a folder of your choosing', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'fbdoc-export-'))
    const result = run(['export', '--offline', '--dir', dir])
    expect(result.status).toBe(0)
    expect(result.stderr).toContain('Exported a detailed report')

    const written = readdirSync(dir).filter((name) => name.endsWith('.md'))
    expect(written).toHaveLength(1)
    expect(written[0]).toMatch(
      /^freebuff-doctor-report-\d{4}-\d{2}-\d{2}-\d{6}\.md$/,
    )

    const report = readFileSync(path.join(dir, written[0] ?? ''), 'utf8')
    expect(report).toContain('# Freebuff Doctor — detailed report')
    expect(report).toContain('node-runtime')
    // The user's home directory must never appear verbatim, in any spelling.
    const home = process.env.USERPROFILE ?? process.env.HOME ?? ''
    if (home && !home.includes('[redacted')) {
      const normalized = report
        .replace(/\\/g, '/')
        .replace(/\/+/g, '/')
        .toLowerCase()
      expect(normalized).not.toContain(
        home.replace(/\\/g, '/').replace(/\/+/g, '/').toLowerCase(),
      )
    }
  })

  it('explains a folder it cannot create instead of crashing', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'fbdoc-export-'))
    const blocker = path.join(dir, 'file-not-a-folder')
    writeFileSync(blocker, 'this is a file')
    const result = run([
      'export',
      '--offline',
      '--dir',
      path.join(blocker, 'in'),
    ])
    expect(result.status).toBe(1)
    expect(result.stderr).toContain('fbdoc export --dir')
  })

  it('asks for a question when it has no terminal to prompt on', () => {
    const result = run(['ask'])
    expect(result.status).toBe(1)
    expect(result.stderr).toContain('needs a question')
    expect(result.stderr).toContain('fbdoc ask "')
  })

  it('refuses to pretend the assistant works offline', () => {
    const result = run(['ask', 'why is freebuff broken?', '--offline'])
    expect(result.status).toBe(1)
    expect(result.stderr).toMatch(/needs the network/i)
    expect(result.stderr).toMatch(/--offline/)
  })

  it('explains how to connect a key when none is configured', () => {
    // A throwaway config root and no GROQ_API_KEY: the run must stop before
    // any request, so this stays a test with no network in it.
    const configRoot = mkdtempSync(path.join(tmpdir(), 'fbdoc-ai-'))
    const result = run(['ask', 'why is freebuff broken?', '--no-checks'], {
      XDG_CONFIG_HOME: configRoot,
      GROQ_API_KEY: '',
    })
    expect(result.status).toBe(1)
    expect(result.stderr).toContain('No Groq API key found')
    expect(result.stderr).toContain('GROQ_API_KEY')
    expect(result.stderr).toContain('console.groq.com/keys')
    expect(result.stdout).not.toContain('Freebuff assistant')
  })

  it('lists every check as JSON with its category', () => {
    const result = run(['checks', '--json'])
    expect(result.status).toBe(0)
    const payload = JSON.parse(result.stdout) as {
      total: number
      checks: Array<{ id: string; category: string | null; summary: string }>
    }
    expect(payload.total).toBe(30)
    expect(payload.checks).toHaveLength(30)
    expect(payload.checks.every((check) => check.category !== null)).toBe(true)
    expect(payload.checks.every((check) => check.summary.length > 0)).toBe(true)
  })

  it('explains a single check', () => {
    const result = run(['explain', 'dns'])
    expect(result.status).toBe(0)
    expect(result.stdout).toContain('DNS resolution')
    expect(result.stdout).toContain('What it looks at')
    expect(result.stdout).toContain('fbdoc check --only dns')
  })

  it('lists every check when explain is given no id', () => {
    const result = run(['explain'])
    expect(result.status).toBe(0)
    expect(result.stdout).toContain('proxy-trust')
    expect(result.stdout).toContain('Network')
  })

  it('fails politely on an unknown check id', () => {
    const result = run(['explain', 'definitely-not-a-check'])
    expect(result.status).toBe(1)
    expect(result.stderr).toMatch(/No check is called/)
  })

  it('prints an environment snapshot with redacted paths', () => {
    const result = run(['env'])
    expect(result.status).toBe(0)
    expect(result.stdout).toContain('PATH')
    expect(result.stdout).toContain('Node')

    const home = process.env.USERPROFILE ?? process.env.HOME ?? ''
    if (home) {
      const normalized = result.stdout
        .replace(/\\/g, '/')
        .replace(/\/+/g, '/')
        .toLowerCase()
      expect(normalized).not.toContain(
        home.replace(/\\/g, '/').replace(/\/+/g, '/').toLowerCase(),
      )
    }
  })

  it('prints the environment snapshot as JSON', () => {
    const result = run(['env', '--json'])
    expect(result.status).toBe(0)
    const payload = JSON.parse(result.stdout) as {
      node: string
      pathEntries: Array<{ index: number; duplicate: boolean }>
    }
    expect(payload.node).toMatch(/^v\d+/)
    expect(Array.isArray(payload.pathEntries)).toBe(true)
  })

  it('compares two saved reports', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'fbdoc-diff-'))
    const before = path.join(dir, 'before.json')
    const after = path.join(dir, 'after.json')
    const dns = {
      id: 'dns',
      title: 'DNS resolution',
      message: 'resolution failed',
    }
    type SavedCheck = typeof dns & { status: string }
    const report = (checks: SavedCheck[]): string => JSON.stringify({ checks })

    // fail → pass is a fix, and a fix alone is not a failure.
    writeFileSync(before, report([{ ...dns, status: 'fail' }]))
    writeFileSync(after, report([{ ...dns, status: 'pass' }]))
    const fixed = run(['diff', before, after])
    expect(fixed.status).toBe(0)
    expect(fixed.stdout).toContain('fixed')
    expect(fixed.stdout).toContain('DNS resolution')

    // pass → fail is a regression, so the comparison exits 1 for CI to gate on.
    const regressed = run(['diff', after, before])
    expect(regressed.status).toBe(1)
    expect(regressed.stdout).toContain('new problem')

    // A file that is not a report is rejected with a usable message.
    const notAReport = path.join(dir, 'not-a-report.json')
    writeFileSync(notAReport, '{}')
    const invalid = run(['diff', before, notAReport])
    expect(invalid.status).toBe(1)
    expect(invalid.stderr).toMatch(/no checks array/)
  })
})
