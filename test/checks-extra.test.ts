import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'

import { classifyArchMatch, normalizeArch } from '../src/checks/arch-match.js'
import {
  classifyBinary,
  extractShimTargets,
  type BinaryObservation,
} from '../src/checks/binary-integrity.js'
import {
  classifyConfigIssues,
  cleanJson,
  findRenamedKeyPairs,
  parseConfig,
  schemaVersionOf,
} from '../src/checks/config-health.js'
import {
  classifySkew,
  inspectTlsEnvironment,
} from '../src/checks/clock-skew.js'
import {
  findVariableOrigin,
  inspectEnvironment,
  inspectNpmrc,
  isNpmjsRegistry,
  shellProfilePaths,
} from '../src/checks/env-hygiene.js'
import { classifyGitPrereqs } from '../src/checks/git-prereqs.js'
import { CHECKS } from '../src/checks/index.js'
import {
  classifyLimits,
  countNodeProcesses,
  parseFdLimit,
} from '../src/checks/resource-limits.js'
import {
  classifyLock,
  isProcessAlive,
  parseLockOwner,
} from '../src/checks/stale-lock.js'
import { classifyGrowth, measureProject } from '../src/checks/state-growth.js'

describe('normalizeArch', () => {
  it('collapses the platform spellings onto Node architecture names', () => {
    expect(normalizeArch('x86_64')).toBe('x64')
    expect(normalizeArch('AMD64')).toBe('x64')
    expect(normalizeArch('aarch64')).toBe('arm64')
    expect(normalizeArch('i686')).toBe('ia32')
    expect(normalizeArch('armv7l')).toBe('arm')
    expect(normalizeArch('riscv64')).toBe('riscv64')
    expect(normalizeArch('')).toBeNull()
    expect(normalizeArch(null)).toBeNull()
  })
})

describe('classifyArchMatch', () => {
  it('passes when the runtime and the machine agree', () => {
    const verdict = classifyArchMatch({
      processArch: 'x64',
      osArch: 'x86_64',
      translated: false,
    })
    expect(verdict.status).toBe('pass')
    expect(verdict.message).toMatch(/matches this machine/i)
  })

  it('warns about a Rosetta-translated runtime', () => {
    const verdict = classifyArchMatch({
      processArch: 'x64',
      osArch: 'arm64',
      translated: true,
    })
    expect(verdict.status).toBe('warn')
    expect(verdict.message).toMatch(/Rosetta/i)
  })

  it('still warns when the translation flag is unavailable', () => {
    const verdict = classifyArchMatch({
      processArch: 'x64',
      osArch: 'arm64',
      translated: null,
    })
    expect(verdict.status).toBe('warn')
  })

  it('warns about a 32-bit runtime on a 64-bit machine', () => {
    const verdict = classifyArchMatch({
      processArch: 'ia32',
      osArch: 'x86_64',
      translated: null,
    })
    expect(verdict.status).toBe('warn')
    expect(verdict.message).toMatch(/32-bit/i)
  })

  it('fails on an architecture that cannot execute here', () => {
    const verdict = classifyArchMatch({
      processArch: 'arm64',
      osArch: 'x64',
      translated: false,
    })
    expect(verdict.status).toBe('fail')
  })

  it('does not guess when the machine architecture is unknown', () => {
    const verdict = classifyArchMatch({
      processArch: 'x64',
      osArch: null,
      translated: null,
    })
    expect(verdict.status).toBe('pass')
    expect(verdict.message).toMatch(/could not be confirmed/i)
  })
})

describe('extractShimTargets', () => {
  const binDir = path.join('C:', 'Users', 'me', 'AppData', 'Roaming', 'npm')

  it('reads the script an npm .cmd shim launches', () => {
    const shim = [
      '@ECHO off',
      'GOTO start',
      ':find_dp0',
      'SET dp0=%~dp0',
      'EXIT /b',
      ':start',
      'IF EXIST "%dp0%\\node.exe" (',
      '  SET "_prog=%dp0%\\node.exe"',
      ') ELSE (',
      '  SET "_prog=node"',
      ')',
      'endLocal & "%_prog%"  "%dp0%\\node_modules\\freebuff\\index.js" %*',
    ].join('\r\n')

    expect(extractShimTargets(shim, binDir)).toEqual([
      path.resolve(binDir, 'node_modules', 'freebuff', 'index.js'),
    ])
  })

  it('reads the PowerShell shim too, and ignores node itself', () => {
    const shim =
      '& "$basedir/node$exe"  "$basedir/node_modules/freebuff/index.js" $args'
    expect(extractShimTargets(shim, binDir)).toEqual([
      path.resolve(binDir, 'node_modules', 'freebuff', 'index.js'),
    ])
    expect(extractShimTargets('& "$basedir/node$exe" $args', binDir)).toEqual(
      [],
    )
  })
})

describe('classifyBinary', () => {
  const base: BinaryObservation = {
    path: '~/AppData/Roaming/npm/freebuff.cmd',
    size: 332,
    executable: true,
    dangling: false,
    quarantined: false,
    missingTargets: [],
    platform: 'win32',
  }

  it('passes for a complete, runnable install', () => {
    expect(classifyBinary(base).status).toBe('pass')
  })

  it('fails on an empty file or a dangling symlink', () => {
    expect(classifyBinary({ ...base, size: 0 }).status).toBe('fail')
    expect(classifyBinary({ ...base, dangling: true }).status).toBe('fail')
  })

  it('fails when the executable bit is missing, and says how to fix it', () => {
    const verdict = classifyBinary({
      ...base,
      executable: false,
      platform: 'linux',
    })
    expect(verdict.status).toBe('fail')
    expect(verdict.fix).toContain('chmod +x')
  })

  it('fails when the launcher points at a script that is gone', () => {
    const verdict = classifyBinary({
      ...base,
      missingTargets: ['~/AppData/Roaming/npm/node_modules/freebuff/index.js'],
    })
    expect(verdict.status).toBe('fail')
    expect(verdict.message).toContain('index.js')
  })

  it('warns about a macOS quarantine flag', () => {
    const verdict = classifyBinary({
      ...base,
      platform: 'darwin',
      quarantined: true,
    })
    expect(verdict.status).toBe('warn')
    expect(verdict.fix).toContain('xattr -d com.apple.quarantine')
  })
})

describe('parseConfig', () => {
  it('parses strict JSON', () => {
    expect(parseConfig('{"a":1}')).toEqual({ ok: true, value: { a: 1 } })
  })

  it('parses JSONC with comments and trailing commas', () => {
    const jsonc = [
      '{',
      '  // the theme',
      '  "theme": "dark", /* inline */',
      '  "recent": ["a", "b",],',
      '}',
    ].join('\n')
    expect(parseConfig(jsonc)).toEqual({
      ok: true,
      value: { theme: 'dark', recent: ['a', 'b'] },
    })
  })

  it('never strips comment markers inside strings', () => {
    expect(cleanJson('{"url":"https://freebuff.com//x"}')).toBe(
      '{"url":"https://freebuff.com//x"}',
    )
    expect(parseConfig('{"url":"https://freebuff.com//x"}')).toEqual({
      ok: true,
      value: { url: 'https://freebuff.com//x' },
    })
  })

  it('reports malformed and empty input', () => {
    expect(parseConfig('{"a":').ok).toBe(false)
    expect(parseConfig('').ok).toBe(false)
    expect(parseConfig('   ').ok).toBe(false)
  })
})

describe('schemaVersionOf', () => {
  it('reads the declared format version', () => {
    expect(schemaVersionOf({ schemaVersion: 2 })).toBe(2)
    expect(schemaVersionOf({ schema_version: '2.5' })).toBe(2.5)
    expect(schemaVersionOf({ formatVersion: 7, other: 1 })).toBe(7)
  })

  it('ignores unrelated version keys', () => {
    expect(schemaVersionOf({ version: '1.2.3' })).toBeNull()
    expect(schemaVersionOf({ schemaVersion: 'latest' })).toBeNull()
    expect(schemaVersionOf(null)).toBeNull()
    expect(schemaVersionOf(['a'])).toBeNull()
  })
})

describe('findRenamedKeyPairs', () => {
  it('spots two spellings of the same setting', () => {
    expect(findRenamedKeyPairs(['apiKey', 'api_key'])).toEqual([
      ['apiKey', 'api_key'],
    ])
    expect(findRenamedKeyPairs(['userName', 'user_name', 'theme'])).toEqual([
      ['userName', 'user_name'],
    ])
  })

  it('reports each pair once and ignores single spellings', () => {
    expect(findRenamedKeyPairs(['api_key', 'apiKey'])).toHaveLength(1)
    expect(findRenamedKeyPairs(['theme', 'language'])).toEqual([])
  })
})

describe('classifyConfigIssues', () => {
  const issue = {
    kind: 'malformed' as const,
    path: '/home/me/.config/manicode/settings.json',
    display: '~/.config/manicode/settings.json',
  }

  it('passes when nothing is wrong', () => {
    expect(classifyConfigIssues([], 'linux').status).toBe('pass')
  })

  it('fails on a malformed file and offers a quarantine command', () => {
    const verdict = classifyConfigIssues([issue], 'linux')
    expect(verdict.status).toBe('fail')
    expect(verdict.fix).toContain('mv')
    expect(verdict.faqSlug).toBe('crash-on-start--updating')
  })

  it('warns about a truncated file instead of failing', () => {
    const verdict = classifyConfigIssues([{ ...issue, kind: 'empty' }], 'linux')
    expect(verdict.status).toBe('warn')
  })

  it('fails when a config was written by a newer Freebuff', () => {
    const verdict = classifyConfigIssues(
      [{ ...issue, kind: 'schema-newer', detail: 'schema 3' }],
      'linux',
    )
    expect(verdict.status).toBe('fail')
    expect(verdict.fix).toContain('npm i -g freebuff@latest')
  })

  it('puts only the secondary findings in the details', () => {
    const verdict = classifyConfigIssues(
      [issue, { ...issue, kind: 'leftover', display: '~/settings.json.bak' }],
      'linux',
    )
    expect(verdict.message).not.toContain('settings.json.bak')
    expect(verdict.details?.join(' ')).toContain('settings.json.bak')
  })
})

describe('parseLockOwner', () => {
  it('handles the shapes lock files use', () => {
    expect(parseLockOwner('12345')).toEqual({ pid: 12345, hostname: null })
    expect(parseLockOwner('pid=42')).toEqual({ pid: 42, hostname: null })
    expect(parseLockOwner('{"pid": 4312, "started": 1}')).toEqual({
      pid: 4312,
      hostname: null,
    })
    expect(parseLockOwner('my-host-4321')).toEqual({
      pid: 4321,
      hostname: 'my-host',
    })
  })

  it('reports no owner for unreadable content', () => {
    expect(parseLockOwner('')).toEqual({ pid: null, hostname: null })
    expect(parseLockOwner('locked by whoever')).toEqual({
      pid: null,
      hostname: null,
    })
  })
})

describe('isProcessAlive', () => {
  it('sees the current process and rejects an impossible pid', () => {
    expect(isProcessAlive(process.pid)).toBe(true)
    expect(isProcessAlive(2147483646)).toBe(false)
    expect(isProcessAlive(0)).toBe(false)
    expect(isProcessAlive(-1)).toBe(false)
  })
})

describe('classifyLock', () => {
  const base = { hostname: 'this-machine' }

  it('fails on a lock whose owner is gone', () => {
    const verdict = classifyLock({
      ...base,
      owner: { pid: 4321, hostname: null },
      alive: false,
      ageHours: 1,
    })
    expect(verdict.status).toBe('fail')
    expect(verdict.stale).toBe(true)
  })

  it('warns when another process still holds the lock', () => {
    const verdict = classifyLock({
      ...base,
      owner: { pid: 4321, hostname: null },
      alive: true,
      ageHours: 0.2,
    })
    expect(verdict.status).toBe('warn')
    expect(verdict.stale).toBe(false)
  })

  it('fails on a lock written by a different machine', () => {
    const verdict = classifyLock({
      ...base,
      owner: { pid: 99, hostname: 'someone-elses-laptop' },
      alive: false,
      ageHours: 20,
    })
    expect(verdict.status).toBe('fail')
    expect(verdict.message).toMatch(/different machine/i)
  })

  it('fails on an old lock that names no process', () => {
    const verdict = classifyLock({
      ...base,
      owner: { pid: null, hostname: null },
      alive: null,
      ageHours: 30,
    })
    expect(verdict.status).toBe('fail')
    expect(verdict.stale).toBe(true)
  })

  it('only warns about a fresh lock file', () => {
    const verdict = classifyLock({
      ...base,
      owner: { pid: null, hostname: null },
      alive: null,
      ageHours: 0.1,
    })
    expect(verdict.status).toBe('warn')
  })
})

describe('classifySkew', () => {
  const now = Date.UTC(2026, 0, 2, 12)

  it('passes when the clocks agree', () => {
    expect(classifySkew(now + 1200, now).status).toBe('pass')
  })

  it('warns past five minutes and fails past an hour', () => {
    expect(classifySkew(now + 10 * 60_000, now).status).toBe('warn')
    expect(classifySkew(now + 2 * 3_600_000, now).status).toBe('fail')
  })

  it('says which way the clock is wrong', () => {
    expect(classifySkew(now - 10 * 60_000, now).message).toMatch(/behind/)
    expect(classifySkew(now + 10 * 60_000, now).message).toMatch(/ahead of/)
  })

  it('reports the signed skew', () => {
    expect(classifySkew(now + 60_000, now).skewMs).toBe(60_000)
  })
})

describe('inspectTlsEnvironment', () => {
  it('flags disabled certificate validation', () => {
    const issues = inspectTlsEnvironment(
      { NODE_TLS_REJECT_UNAUTHORIZED: '0' },
      () => true,
    )
    expect(issues).toHaveLength(1)
    expect(issues[0]?.variable).toBe('NODE_TLS_REJECT_UNAUTHORIZED')
    expect(issues[0]?.fix).toContain('unset')
  })

  it('flags a CA bundle path that no longer exists', () => {
    const issues = inspectTlsEnvironment(
      { NODE_EXTRA_CA_CERTS: '/certs/corp.pem' },
      () => false,
    )
    expect(issues[0]?.message).toMatch(/does not exist/)
  })

  it('notes a trust store that was replaced', () => {
    const issues = inspectTlsEnvironment(
      { SSL_CERT_FILE: '/certs/ca.pem' },
      () => true,
    )
    expect(issues[0]?.variable).toBe('SSL_CERT_FILE')
    expect(issues[0]?.message).toMatch(/trust store/)
  })

  it('stays quiet on a clean environment', () => {
    expect(inspectTlsEnvironment({}, () => true)).toEqual([])
  })
})

describe('inspectEnvironment', () => {
  it('flags a legacy OpenSSL provider', () => {
    const issues = inspectEnvironment(
      { NODE_OPTIONS: '--openssl-legacy-provider' },
      'linux',
    )
    expect(issues).toHaveLength(1)
    expect(issues[0]?.message).toMatch(/openssl-legacy-provider/)
  })

  it('flags absurd and tiny heap caps', () => {
    expect(
      inspectEnvironment(
        { NODE_OPTIONS: '--max-old-space-size=65536' },
        'linux',
      )[0]?.message,
    ).toMatch(/65536|64 GB/)
    expect(
      inspectEnvironment(
        { NODE_OPTIONS: '--max-old-space-size=128' },
        'linux',
      )[0]?.message,
    ).toMatch(/128 MB/)
  })

  it('flags a loader that does not exist', () => {
    const issues = inspectEnvironment(
      { NODE_OPTIONS: '--require ./setup.js' },
      'linux',
      () => false,
      '/work',
    )
    expect(issues[0]?.message).toMatch(/setup\.js/)
  })

  it('flags module-path, prefix, Electron and registry overrides', () => {
    const issues = inspectEnvironment(
      {
        NODE_PATH: '/opt/node_modules',
        NPM_CONFIG_PREFIX: '/opt/npm',
        ELECTRON_RUN_AS_NODE: '1',
        npm_config_registry: 'https://npm.corp.example/',
      },
      'linux',
    )
    expect(issues.map((issue) => issue.variable).sort()).toEqual([
      'ELECTRON_RUN_AS_NODE',
      'NODE_PATH',
      'NPM_CONFIG_PREFIX',
      'npm_config_registry',
    ])
  })

  it('accepts npm\u2019s own registry and a clean environment', () => {
    expect(
      inspectEnvironment(
        { npm_config_registry: 'https://registry.npmjs.org/' },
        'linux',
      ),
    ).toEqual([])
    expect(inspectEnvironment({}, 'linux')).toEqual([])
  })

  it('uses a Windows-shaped fix on Windows', () => {
    const issues = inspectEnvironment({ NODE_PATH: 'C:\\n' }, 'win32')
    expect(issues[0]?.fix).toContain('SetEnvironmentVariable')
  })
})

describe('isNpmjsRegistry', () => {
  it('recognises npm\u2019s registry in any spelling', () => {
    expect(isNpmjsRegistry('https://registry.npmjs.org/')).toBe(true)
    expect(isNpmjsRegistry('http://registry.npmjs.org')).toBe(true)
    expect(isNpmjsRegistry('')).toBe(true)
    expect(isNpmjsRegistry('https://npm.pkg.github.com/')).toBe(false)
  })
})

describe('inspectNpmrc', () => {
  it('flags a registry override with its line number', () => {
    const issues = inspectNpmrc(
      ['# comment', 'registry=https://npm.pkg.github.com/'].join('\n'),
      'user',
    )
    expect(issues).toHaveLength(1)
    expect(issues[0]?.message).toContain('line 2')
  })

  it('flags a token in a project .npmrc only', () => {
    const text = '//registry.npmjs.org/:_authToken=abc123'
    expect(inspectNpmrc(text, 'project')).toHaveLength(1)
    expect(inspectNpmrc(text, 'user')).toHaveLength(0)
  })

  it('ignores a plain npm registry line', () => {
    expect(
      inspectNpmrc('registry=https://registry.npmjs.org/', 'user'),
    ).toEqual([])
  })
})

describe('findVariableOrigin', () => {
  it('points at the profile and line that sets a variable', () => {
    const origin = findVariableOrigin('NODE_OPTIONS', [
      { path: '/home/me/.bashrc', text: '# nothing here' },
      {
        path: '/home/me/.zshrc',
        text: 'export PATH=$PATH:/x\nexport NODE_OPTIONS=--max-old-space-size=1024',
      },
    ])
    expect(origin).toBe('/home/me/.zshrc:2')
  })

  it('returns null when no profile sets it', () => {
    expect(
      findVariableOrigin('NODE_PATH', [{ path: '/home/me/.zshrc', text: 'x' }]),
    ).toBeNull()
  })

  it('recognises PowerShell and cmd assignments', () => {
    expect(
      findVariableOrigin('NODE_PATH', [
        { path: 'profile.ps1', text: '$env:NODE_PATH = "C:\\n"' },
      ]),
    ).toBe('profile.ps1:1')
    expect(
      findVariableOrigin('NODE_PATH', [
        { path: 'autoexec.bat', text: 'set NODE_PATH=C:\\n' },
      ]),
    ).toBe('autoexec.bat:1')
  })
})

describe('shellProfilePaths', () => {
  it('looks at the right files per platform', () => {
    const windows = shellProfilePaths('C:\\Users\\me', 'win32').join(' ')
    expect(windows).toContain('Microsoft.PowerShell_profile.ps1')
    // Git Bash users on Windows keep using these.
    expect(windows).toContain('.zshrc')
    expect(windows).toContain('.bashrc')
    expect(shellProfilePaths('/home/me', 'linux').join(' ')).toContain('.zshrc')
  })
})

describe('classifyGitPrereqs', () => {
  const base = {
    platform: 'linux' as NodeJS.Platform,
    gitVersion: 'git version 2.47.0',
    userName: 'Richard',
    userEmail: 'richard@example.com',
    longPaths: null,
    autoCrlf: null,
    repoPath: '/work/project',
    dubiousOwnership: false,
  }

  it('passes for a healthy git setup', () => {
    const verdict = classifyGitPrereqs(base)
    expect(verdict.status).toBe('pass')
    expect(verdict.details?.join(' ')).toContain('Richard')
  })

  it('fails when git is missing', () => {
    const verdict = classifyGitPrereqs({
      ...base,
      gitVersion: null,
      userName: null,
      userEmail: null,
    })
    expect(verdict.status).toBe('fail')
    expect(verdict.fix).toBe('sudo apt install git')
  })

  it('warns per missing identity field', () => {
    const verdict = classifyGitPrereqs({ ...base, userEmail: null })
    expect(verdict.status).toBe('warn')
    expect(verdict.fix).toContain('user.email')
  })

  it('warns about Windows long paths', () => {
    const verdict = classifyGitPrereqs({
      ...base,
      platform: 'win32',
      longPaths: null,
    })
    expect(verdict.fix).toBe('git config --global core.longpaths true')
  })

  it('warns about a line-ending mismatch on either platform', () => {
    expect(classifyGitPrereqs({ ...base, autoCrlf: 'true' }).fix).toContain(
      'core.autocrlf input',
    )
    expect(
      classifyGitPrereqs({
        ...base,
        platform: 'win32',
        longPaths: 'true',
        autoCrlf: 'input',
      }).fix,
    ).toContain('core.autocrlf true')
  })

  it('warns when git refuses a repository for ownership reasons', () => {
    const verdict = classifyGitPrereqs({ ...base, dubiousOwnership: true })
    expect(verdict.status).toBe('warn')
    expect(verdict.fix).toContain('safe.directory')
  })
})

describe('parseFdLimit', () => {
  it('reads a numeric limit and rejects everything else', () => {
    expect(parseFdLimit('1024\n')).toBe(1024)
    expect(parseFdLimit('  256  ')).toBe(256)
    expect(parseFdLimit('unlimited')).toBeNull()
    expect(parseFdLimit('')).toBeNull()
  })
})

describe('countNodeProcesses', () => {
  it('counts Node-family processes on POSIX', () => {
    expect(
      countNodeProcesses(
        ['node', 'node', '/usr/local/bin/bun', 'zsh', 'codebuff'].join('\n'),
        'linux',
      ),
    ).toBe(4)
  })

  it('counts node.exe rows from tasklist', () => {
    const csv = [
      '"node.exe","1234","Console","1","10,000 K"',
      '"node.exe","5678","Console","1","9,000 K"',
    ].join('\r\n')
    expect(countNodeProcesses(csv, 'win32')).toBe(2)
    expect(
      countNodeProcesses(
        'INFO: No tasks are running which match the specified criteria.',
        'win32',
      ),
    ).toBe(0)
  })

  it('reports zero for empty output', () => {
    expect(countNodeProcesses('', 'linux')).toBe(0)
  })
})

describe('classifyLimits', () => {
  const base = {
    platform: 'linux' as NodeJS.Platform,
    fdLimit: 1024,
    freeBytes: 8 * 1024 ** 3,
    totalBytes: 16 * 1024 ** 3,
    nodeProcesses: 3,
    recentOom: false,
    oomAgeHours: null,
  }

  it('passes with plenty of headroom', () => {
    const verdict = classifyLimits(base)
    expect(verdict.status).toBe('pass')
    expect(verdict.message).toMatch(/8 GB free of 16 GB/)
  })

  it('fails when memory pressure meets a recorded out-of-memory crash', () => {
    const verdict = classifyLimits({
      ...base,
      freeBytes: 200 * 1024 ** 2,
      recentOom: true,
      oomAgeHours: 2,
    })
    expect(verdict.status).toBe('fail')
    expect(verdict.message).toMatch(/out of memory/i)
  })

  it('only warns about low free RAM without crash evidence', () => {
    const verdict = classifyLimits({ ...base, freeBytes: 300 * 1024 ** 2 })
    expect(verdict.status).toBe('warn')
    expect(verdict.message).toMatch(/RAM/)
  })

  it('fails on a file-descriptor limit that cannot hold a run', () => {
    const verdict = classifyLimits({ ...base, fdLimit: 32 })
    expect(verdict.status).toBe('fail')
    expect(verdict.fix).toContain('ulimit -n')
  })

  it('warns near the file-descriptor ceiling', () => {
    expect(classifyLimits({ ...base, fdLimit: 100 }).status).toBe('warn')
  })

  it('warns about a small machine and about stray processes', () => {
    expect(
      classifyLimits({ ...base, totalBytes: 2 * 1024 ** 3 }).message,
    ).toMatch(/2 GB/)
    expect(classifyLimits({ ...base, nodeProcesses: 60 }).message).toMatch(
      /60 Node processes/,
    )
  })
})

describe('classifyGrowth', () => {
  const project = {
    name: 'demo',
    path: '/home/me/.config/manicode/projects/demo',
    bytes: 120 * 1024 ** 2,
    files: 12,
  }

  it('passes when there is nothing to weigh or nothing large', () => {
    expect(
      classifyGrowth({
        platform: 'linux',
        totalBytes: 0,
        projects: [],
        largestFile: null,
      }).status,
    ).toBe('pass')

    const verdict = classifyGrowth({
      platform: 'linux',
      totalBytes: 400 * 1024 ** 2,
      projects: [project],
      largestFile: {
        path: '/x/log.jsonl',
        display: '~/log.jsonl',
        bytes: 90 * 1024 ** 2,
      },
    })
    expect(verdict.status).toBe('pass')
    expect(verdict.message).toMatch(/400 MB/)
  })

  it('warns about a single runaway log and offers an archive command', () => {
    const verdict = classifyGrowth({
      platform: 'linux',
      totalBytes: 900 * 1024 ** 2,
      projects: [project],
      largestFile: {
        path: '/x/huge.jsonl',
        display: '~/huge.jsonl',
        bytes: 700 * 1024 ** 2,
      },
    })
    expect(verdict.status).toBe('warn')
    expect(verdict.fix).toContain('mv')
    expect(verdict.message).toMatch(/runaway/)
  })

  it('warns about one very large project and about a large total', () => {
    expect(
      classifyGrowth({
        platform: 'linux',
        totalBytes: 3 * 1024 ** 3,
        projects: [{ ...project, bytes: 3 * 1024 ** 3 }],
        largestFile: null,
      }).message,
    ).toMatch(/demo/)

    expect(
      classifyGrowth({
        platform: 'linux',
        totalBytes: 6 * 1024 ** 3,
        projects: [project],
        largestFile: null,
      }).message,
    ).toMatch(/6 GB/)
  })
})

describe('measureProject', () => {
  it('weighs session files and ignores everything else', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'fbdoc-growth-'))
    mkdirSync(path.join(dir, 'chats', 'session'), { recursive: true })
    writeFileSync(path.join(dir, 'chats', 'session', 'log.jsonl'), 'aaaa')
    writeFileSync(path.join(dir, 'desktop-v2.db'), 'bb')
    writeFileSync(path.join(dir, 'notes.txt'), 'x'.repeat(500))

    const measured = measureProject(dir)
    expect(measured.bytes).toBe(6)
    expect(measured.files).toBe(2)
    expect(measured.largest.bytes).toBe(4)
    expect(measured.largest.path.endsWith('log.jsonl')).toBe(true)
  })

  it('reports nothing for a project with no session data', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'fbdoc-growth-empty-'))
    expect(measureProject(dir)).toEqual({
      bytes: 0,
      files: 0,
      largest: { path: '', bytes: 0 },
    })
  })
})

describe('check registry', () => {
  it('registers every check under a unique, kebab-case id', () => {
    const ids = CHECKS.map((check) => check.id)
    expect(new Set(ids).size).toBe(ids.length)
    for (const id of ids) expect(id).toMatch(/^[a-z0-9-]+$/)
    expect(ids).toEqual([
      'node-runtime',
      'arch-match',
      'global-install',
      'binary-integrity',
      'install-paths',
      'config-health',
      'stale-lock',
      'dns',
      'network',
      'clock-skew',
      'env-hygiene',
      'node-conflicts',
      'git-prereqs',
      'session-logs',
      'crash-log',
      'state-growth',
      'storage',
      'resource-limits',
    ])
  })
})
