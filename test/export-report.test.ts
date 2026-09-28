import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'

import { checkDoc } from '../src/checks/catalog.js'
import type { CheckContext, CheckResult } from '../src/checks/types.js'
import { buildHelperReport } from '../src/report/helper.js'
import {
  downloadsCandidates,
  parseUserDirs,
  reportFileName,
  resolveDownloadsDir,
} from '../src/util/downloads.js'
import { collectSnapshot } from '../src/util/environment.js'
import { anonymizePath } from '../src/util/platform.js'

const HOME = '/home/tester'

function makeContext(overrides: Partial<CheckContext> = {}): CheckContext {
  return {
    paths: {
      home: HOME,
      configRoot: `${HOME}/.config`,
      cliState: `${HOME}/.config/manicode`,
      desktopState: `${HOME}/.config/freebuff-desktop`,
      legacyState: `${HOME}/.config/codebuff`,
      desktopInstalls: [],
    },
    platform: 'linux',
    arch: 'x64',
    env: {},
    cwd: `${HOME}/work`,
    nodeVersion: 'v24.13.0',
    home: HOME,
    timeoutMs: 8000,
    offline: false,
    ...overrides,
  }
}

function makeResults(): CheckResult[] {
  return [
    {
      id: 'node-runtime',
      title: 'Node.js and npm',
      status: 'pass',
      message: 'Node.js v24.13.0 with npm 11.6.2.',
      data: { npmVersion: '11.6.2' },
      durationMs: 12,
    },
    {
      id: 'global-install',
      title: 'Global Freebuff CLI install',
      status: 'warn',
      message: 'freebuff is behind the latest release.',
      details: ['installed: 0.0.118', 'latest: 0.1.2'],
      fix: 'npm i -g freebuff@latest',
      faqSlug: 'crash-on-start--updating',
      data: { version: '0.0.118' },
      durationMs: 900,
    },
    {
      id: 'dns',
      title: 'DNS resolution',
      status: 'fail',
      message: 'freebuff.com did not resolve from this network.',
      details: ['resolver: 192.168.1.1'],
      fix: 'Set your DNS servers to 1.1.1.1 and 8.8.8.8.',
      faqSlug: 'network-issues',
      durationMs: 1200,
    },
    {
      id: 'network',
      title: 'API reachability',
      status: 'skip',
      message: 'Skipped: --offline was requested.',
      durationMs: 0,
    },
  ]
}

describe('reportFileName', () => {
  it('stamps the date and time so exports never collide', () => {
    expect(reportFileName(new Date(2026, 8, 28, 15, 30, 12))).toBe(
      'freebuff-doctor-report-2026-09-28-153012.md',
    )
  })

  it('zero-pads every component', () => {
    expect(reportFileName(new Date(2026, 0, 5, 3, 4, 9))).toBe(
      'freebuff-doctor-report-2026-01-05-030409.md',
    )
  })
})

describe('parseUserDirs', () => {
  it('reads a quoted $HOME download directory', () => {
    expect(parseUserDirs('XDG_DOWNLOAD_DIR="$HOME/Downloads"', HOME)).toBe(
      path.join(HOME, 'Downloads'),
    )
  })

  it('reads an absolute download directory', () => {
    expect(parseUserDirs('XDG_DOWNLOAD_DIR="/mnt/data/downloads"', HOME)).toBe(
      '/mnt/data/downloads',
    )
  })

  it('expands a bare $HOME', () => {
    expect(parseUserDirs('XDG_DOWNLOAD_DIR="$HOME"', HOME)).toBe(HOME)
  })

  it('ignores comments, blanks and unrelated keys', () => {
    const content = [
      '# comment',
      '',
      'XDG_DESKTOP_DIR="$HOME/Desktop"',
      '   ',
      'XDG_DOWNLOAD_DIR="$HOME/dl"',
    ].join('\n')
    expect(parseUserDirs(content, HOME)).toBe(path.join(HOME, 'dl'))
  })

  it('returns null when the file names no download directory', () => {
    expect(parseUserDirs('ENABLE_UPDATE_CHECKER=yes', HOME)).toBeNull()
    expect(parseUserDirs('', HOME)).toBeNull()
  })
})

describe('downloadsCandidates', () => {
  it('prefers the configured XDG download directory on Linux', () => {
    const configRoot = mkdtempSync(path.join(tmpdir(), 'fbdoc-xdg-'))
    const home = mkdtempSync(path.join(tmpdir(), 'fbdoc-home-'))
    mkdirSync(path.join(configRoot, 'xdg-extra'), { recursive: true })
    writeFileSync(
      path.join(configRoot, 'user-dirs.dirs'),
      'XDG_DOWNLOAD_DIR="$HOME/xdg-extra"\n',
    )

    const candidates = downloadsCandidates(
      home,
      { XDG_CONFIG_HOME: configRoot } as NodeJS.ProcessEnv,
      'linux',
    )
    expect(candidates[0]).toBe(path.join(home, 'xdg-extra'))
    expect(candidates).toContain(path.join(home, 'Downloads'))
  })

  it('uses the profile Downloads folder on Windows and macOS', () => {
    for (const platform of ['win32', 'darwin'] as NodeJS.Platform[]) {
      const candidates = downloadsCandidates(HOME, {}, platform)
      expect(candidates[0]).toBe(path.join(HOME, 'Downloads'))
    }
  })

  it('always ends with the home and working directories as fallbacks', () => {
    const candidates = downloadsCandidates(HOME, {}, 'linux')
    expect(candidates).toContain(HOME)
    expect(candidates).toContain(process.cwd())
  })
})

describe('resolveDownloadsDir', () => {
  it('picks an existing Downloads folder', () => {
    const home = mkdtempSync(path.join(tmpdir(), 'fbdoc-home-'))
    mkdirSync(path.join(home, 'Downloads'))
    const resolution = resolveDownloadsDir(home, {}, 'linux')
    expect(resolution.dir).toBe(path.join(home, 'Downloads'))
    expect(resolution.writable).toBe(true)
  })

  it('falls back to the home directory when Downloads is missing', () => {
    const home = mkdtempSync(path.join(tmpdir(), 'fbdoc-home-'))
    const resolution = resolveDownloadsDir(home, {}, 'linux')
    expect(resolution.dir).toBe(home)
    expect(resolution.writable).toBe(true)
    expect(resolution.considered).toContain(path.join(home, 'Downloads'))
  })
})

describe('anonymizePath', () => {
  it('replaces the plain, forward-slash and JSON-escaped spellings of home', () => {
    const home = 'C:\\Users\\Tester'
    expect(anonymizePath('C:\\Users\\Tester\\x', home, 'win32')).toBe('~\\x')
    expect(anonymizePath('C:/Users/Tester/x', home, 'win32')).toBe('~/x')
    expect(anonymizePath('C:\\\\Users\\\\Tester\\\\x', home, 'win32')).toBe(
      '~\\\\x',
    )
  })
})

describe('buildHelperReport', () => {
  const results = makeResults()
  const report = buildHelperReport({
    results,
    context: makeContext(),
    generatedAt: new Date(2026, 8, 28, 15, 30, 12),
    logs: [
      {
        label: '~/.config/manicode/orchestrator-stderr.log (last 2 lines)',
        lines: [
          'engine started `` ```triple',
          'mail me at someone@example.com',
        ],
      },
    ],
    environment: collectSnapshot(
      {
        PATH: [`${HOME}/bin`, `${HOME}/bin`, '/usr/bin'].join(path.delimiter),
        NODE_OPTIONS: '--max-old-space-size=4096',
      } as NodeJS.ProcessEnv,
      { home: HOME, npmVersion: '11.6.2' },
    ),
  })

  it('opens with a title that explains what to do with the file', () => {
    expect(report.startsWith('# Freebuff Doctor — detailed report')).toBe(true)
    expect(report).toContain('Hand this file to a Freebuff helper')
  })

  it('carries every section a helper needs', () => {
    for (const heading of [
      '## At a glance',
      '## Start here',
      '## Findings in detail',
      '## Every check',
      '## Environment',
      '## Recent engine log lines',
      '## What I have already tried',
      '## Questions a helper will ask',
      '## How to share this',
      '## Machine-readable results',
      '## Redaction summary',
    ]) {
      expect(report).toContain(heading)
    }
  })

  it('summarises the run and states the verdict', () => {
    expect(report).toContain('4 run · 1 passed · 1 warning(s) · 1 failed')
    expect(report).toContain('❌ **1 check failed — start there.**')
    expect(report).toContain('| Node | v24.13.0 (npm 11.6.2) |')
  })

  it('lists every check in a table, worst first', () => {
    const table = report.split('## Every check')[1] ?? ''
    for (const result of results) {
      expect(table).toContain(`\`${result.id}\``)
    }
    const order = ['dns', 'global-install', 'network', 'node-runtime'].map(
      (id) => table.indexOf(`\`${id}\``),
    )
    expect(order.every((index) => index >= 0)).toBe(true)
    expect(order).toEqual([...order].sort((a, b) => a - b))
  })

  it('expands each problem with its fix, FAQ and raw data', () => {
    expect(report).toContain('### ❌ DNS resolution')
    expect(report).toContain('- **Check:** `dns` · Network')
    expect(report).toContain('- resolver: 192.168.1.1')
    expect(report).toContain('- **Suggested fix:** `Set your DNS servers')
    expect(report).toContain(
      'https://github.com/RichardFlp/freebuff-doctor/blob/main/faq.md#network-issues',
    )
    expect(report).toContain('**Raw data**')
  })

  it('explains what the check looks at, straight from the catalogue', () => {
    const doc = checkDoc('dns')
    expect(doc).not.toBeNull()
    expect(report).toContain(doc?.looks[0] ?? '')
    expect(report).toContain(doc?.why ?? '')
  })

  it('names what was not checked instead of hiding it', () => {
    expect(report).toContain('### Not checked')
    expect(report).toContain(
      '- API reachability (`network`) — Skipped: --offline was requested.',
    )
  })

  it('includes the environment snapshot', () => {
    expect(report).toContain('### Variables that affect Freebuff')
    expect(report).toContain('NODE_OPTIONS')
    expect(report).toContain('--max-old-space-size=4096')
    expect(report).toContain('### PATH, in search order (3 entries)')
    expect(report).toContain('<- duplicate')
  })

  it('renders the log tail without breaking its own code fence', () => {
    expect(report).toContain('engine started `` ``triple')
    expect(report).not.toContain('```triple')
    expect(report).toContain('[redacted email]')
  })

  it('redacts secrets and anonymizes the home directory everywhere', () => {
    const withSecret = buildHelperReport({
      results: [
        {
          id: 'auth-session',
          title: 'Saved login',
          status: 'warn',
          message: 'stored credential npm_abcdefghij0123456789abcdefghij',
          durationMs: 5,
        },
      ],
      context: makeContext(),
      extra: [['Reported by', 'tester@example.com']],
    })
    expect(withSecret).toContain('[redacted token]')
    expect(withSecret).toContain('[redacted email]')
    expect(withSecret).not.toContain('abcdefghij0123456789')
    expect(withSecret).toContain('**Home directory:** replaced with `~`')
    expect(withSecret).not.toContain(HOME)
  })

  it('anonymizes home paths inside the machine-readable JSON', () => {
    // JSON doubles every backslash, which used to slip past the redactor and
    // leak the whole home directory from the `data` payloads.
    const home = 'C:\\Users\\Tester'
    const context = makeContext()
    const withPaths = buildHelperReport({
      results: [
        {
          id: 'cache-integrity',
          title: 'Cached engine and downloads',
          status: 'warn',
          message: 'An earlier engine is still cached.',
          fix: `del "${home}\\.config\\manicode\\*.old.*"`,
          data: { cacheDir: `${home}\\.config\\manicode` },
          durationMs: 4,
        },
      ],
      context: makeContext({
        home,
        platform: 'win32',
        paths: {
          ...context.paths,
          home,
          cliState: `${home}\\.config\\manicode`,
        },
      }),
      logs: [],
    })
    expect(withPaths).not.toContain('Tester')
    expect(withPaths).not.toContain('Users')
    expect(withPaths).toContain('~')
  })

  it('escapes pipes so the Markdown table cannot be torn apart', () => {
    const piped = buildHelperReport({
      results: [
        {
          id: 'config-health',
          title: 'Settings',
          status: 'fail',
          message: 'key "a|b" is invalid',
          durationMs: 3,
        },
      ],
      context: makeContext(),
      logs: [],
    })
    expect(piped).toContain('key "a\\|b" is invalid |')
    // The unescaped form would end the cell early and split the row in two.
    expect(piped).not.toMatch(/\| key "a\|b" is invalid \| 3ms \|/)
  })

  it('says so plainly when nothing is wrong', () => {
    const clean = buildHelperReport({
      results: [
        {
          id: 'dns',
          title: 'DNS resolution',
          status: 'pass',
          message: 'freebuff.com resolved normally.',
          durationMs: 4,
        },
      ],
      context: makeContext(),
      logs: [],
    })
    expect(clean).toContain('Nothing needs fixing — every check passed.')
    expect(clean).toContain('✅ **No problems found. Every check passed.**')
    expect(clean).toContain('_No engine log file was found')
    expect(clean).toContain('**Values replaced:** none')
  })

  it('reports on state directories that really exist', () => {
    const real = mkdtempSync(path.join(tmpdir(), 'fbdoc-state-'))
    const context = makeContext()
    const reportWithState = buildHelperReport({
      results: [],
      context: makeContext({
        paths: { ...context.paths, cliState: real },
      }),
      logs: [],
    })
    expect(reportWithState).toContain('| present |')
    expect(reportWithState).toContain('| not present |')
  })

  it('ends with the redaction note', () => {
    expect(report.trimEnd().endsWith('_')).toBe(true)
    expect(report).toContain('freebuff-doctor')
  })
})
