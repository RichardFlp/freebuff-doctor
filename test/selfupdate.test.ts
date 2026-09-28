import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'

import {
  inspectCheckout,
  runSelfUpdate,
  type SelfUpdateDeps,
} from '../src/selfupdate/check.js'
import {
  readUpdateState,
  stateFile,
  writeUpdateState,
} from '../src/selfupdate/state.js'
import type { ExecOptions, ExecResult } from '../src/util/exec.js'
import { PACKAGE_NAME } from '../src/util/version.js'

function result(overrides: Partial<ExecResult> = {}): ExecResult {
  return {
    ok: true,
    code: 0,
    stdout: '',
    stderr: '',
    timedOut: false,
    ...overrides,
  }
}

interface Harness {
  commands: Array<{ command: string; args: string[]; options?: ExecOptions }>
  deps: Partial<SelfUpdateDeps>
  installed: string[]
}

/** Commands that would install something, i.e. the ones that change the machine. */
function installs(harness: Harness): Harness['commands'] {
  return harness.commands.filter((entry) =>
    /(^|[\\/])npm(\.cmd)?$/i.test(entry.command),
  )
}

/** Git commands that reach the network. */
function remoteGit(harness: Harness): Harness['commands'] {
  return harness.commands.filter((entry) =>
    ['ls-remote', 'fetch'].includes(entry.args[0] ?? ''),
  )
}

/** Records every command instead of running it, and scripts their answers. */
function harness(
  script: (command: string, args: string[]) => ExecResult,
  options: { latest?: string | null; state?: Partial<SelfUpdateDeps> } = {},
): Harness {
  const commands: Harness['commands'] = []
  const installed: string[] = []
  const deps: Partial<SelfUpdateDeps> = {
    fetchLatest: async () => options.latest ?? null,
    run: async (command: string, args: string[]) => {
      commands.push({ command, args })
      return script(command, args)
    },
    which: (command) => (command === 'npm' ? '/usr/local/bin/npm' : null),
    readState: () => ({}),
    writeState: (state) => {
      if (state.installedVersion) installed.push(state.installedVersion)
      return true
    },
    now: () => new Date('2026-09-28T12:00:00.000Z'),
    ...options.state,
  }
  return { commands, deps, installed }
}

/** A git repo that is clean, in sync, and answers without any network. */
function gitScript(
  answers: Record<string, string>,
): (command: string, args: string[]) => ExecResult {
  return (command, args) => {
    if (command !== 'git') return result()
    const key = args.join(' ')
    const stdout = answers[key]
    if (stdout === undefined) return result({ ok: false, code: 1 })
    return result({ stdout })
  }
}

describe('runSelfUpdate', () => {
  it('reports a current install and stays quiet', async () => {
    const h = harness(gitScript({}), { latest: '0.6.0' })
    const report = await runSelfUpdate({ current: '0.6.0', deps: h.deps })
    expect(report.status).toBe('current')
    expect(report.action).toBe('none')
    expect(report.lines).toEqual([])
    // Nothing that could change the machine, and no network for git either.
    expect(installs(h)).toEqual([])
    expect(remoteGit(h)).toEqual([])
  })

  it('says what it found in verbose mode', async () => {
    const h = harness(gitScript({}), { latest: '0.6.0' })
    const report = await runSelfUpdate({
      current: '0.6.0',
      verbose: true,
      deps: h.deps,
    })
    expect(report.lines.join('\n')).toContain('up to date')
  })

  it('installs the published version with npm when it is behind', async () => {
    const h = harness(
      (command) =>
        /npm(\.cmd)?$/i.test(command)
          ? result({ stdout: 'added 1 package' })
          : result({ ok: false, code: 1 }),
      { latest: '0.7.0' },
    )

    const report = await runSelfUpdate({ current: '0.6.0', deps: h.deps })

    expect(report.status).toBe('updated')
    expect(report.action).toBe('installed')
    expect(report.latest).toBe('0.7.0')
    expect(installs(h)).toEqual([
      {
        command: '/usr/local/bin/npm',
        args: ['i', '-g', `${PACKAGE_NAME}@latest`],
      },
    ])
    expect(h.installed).toEqual(['0.7.0'])
    expect(report.lines.join('\n')).toContain(`Updated to 0.7.0`)
    expect(report.lines.join('\n')).toContain('Restart fbdoc')
  })

  it('reports a failed install instead of pretending it worked', async () => {
    const h = harness(
      () =>
        result({
          ok: false,
          code: 1,
          stderr: 'EACCES: permission denied, mkdir /usr/lib/node_modules',
        }),
      { latest: '0.7.0' },
    )

    const report = await runSelfUpdate({ current: '0.6.0', deps: h.deps })

    expect(report.status).toBe('failed')
    expect(report.action).toBe('failed')
    expect(h.installed).toEqual([])
    expect(report.lines.join('\n')).toContain('Could not update automatically')
    expect(report.lines.join('\n')).toContain('permission denied')
    expect(report.lines.join('\n')).toContain(`npm i -g ${PACKAGE_NAME}@latest`)
  })

  it('explains itself when npm is not on PATH', async () => {
    const h = harness(gitScript({}), { latest: '0.7.0' })
    h.deps.which = () => null

    const report = await runSelfUpdate({ current: '0.6.0', deps: h.deps })

    expect(report.status).toBe('failed')
    expect(installs(h)).toEqual([])
    expect(report.lines.join('\n')).toContain('npm is not on your PATH')
  })

  it('never installs the same version twice', async () => {
    // Running from a checkout: this copy is old, but npm already has the
    // current release, so there is nothing left to do.
    const h = harness(gitScript({}), {
      latest: '0.7.0',
      state: { readState: () => ({ installedVersion: '0.7.0' }) },
    })

    const report = await runSelfUpdate({ current: '0.6.0', deps: h.deps })

    expect(report.action).toBe('none')
    expect(installs(h)).toEqual([])
    expect(report.lines.join('\n')).toContain('already installed')
  })

  it('stays silent when the registry cannot be reached', async () => {
    const h = harness(gitScript({}), { latest: null })
    const report = await runSelfUpdate({ current: '0.6.0', deps: h.deps })
    expect(report.status).toBe('unknown')
    expect(report.lines).toEqual([])
    // Nothing may reach the network beyond the version lookup.
    expect(installs(h)).toEqual([])
    expect(remoteGit(h)).toEqual([])
  })

  it('touches nothing at all with --offline', async () => {
    const h = harness(gitScript({}), { latest: '9.9.9' })
    const report = await runSelfUpdate({
      current: '0.6.0',
      offline: true,
      deps: h.deps,
    })
    expect(report.status).toBe('offline')
    expect(report.latest).toBeNull()
    expect(h.commands).toEqual([])
  })

  it('respects --no-self-update', async () => {
    const h = harness(gitScript({}), { latest: '9.9.9' })
    const report = await runSelfUpdate({
      current: '0.6.0',
      enabled: false,
      deps: h.deps,
    })
    expect(report.status).toBe('offline')
    expect(h.commands).toEqual([])
  })
})

describe('inspectCheckout', () => {
  it('ignores a directory that is not a git checkout', async () => {
    const h = harness(gitScript({}))
    expect(await inspectCheckout('/tmp/nope', h.deps)).toBeNull()
  })

  it('reports zero commits behind when the checkout matches origin/main', async () => {
    const h = harness(
      gitScript({
        'rev-parse --is-inside-work-tree': 'true\n',
        'rev-parse HEAD': 'abc123\n',
        'status --porcelain': '',
        'ls-remote origin main': 'abc123\trefs/heads/main\n',
      }),
    )

    const checkout = await inspectCheckout('/repo', h.deps)
    expect(checkout).toEqual({ root: '/repo', behind: 0, dirty: false })
    // In sync: no fetch, because ls-remote already answered.
    expect(h.commands.some((c) => c.args.includes('fetch'))).toBe(false)
  })

  it('still says whether the tree is dirty when there is nothing to pull', async () => {
    const h = harness(
      gitScript({
        'rev-parse --is-inside-work-tree': 'true\n',
        'rev-parse HEAD': 'abc123\n',
        'status --porcelain': ' M src/cli.ts\n',
        'ls-remote origin main': 'abc123\trefs/heads/main\n',
      }),
    )
    expect(await inspectCheckout('/repo', h.deps)).toEqual({
      root: '/repo',
      behind: 0,
      dirty: true,
    })
  })

  it('counts the commits behind, and whether the tree is dirty', async () => {
    const h = harness(
      gitScript({
        'rev-parse --is-inside-work-tree': 'true\n',
        'rev-parse HEAD': 'abc123\n',
        'status --porcelain': ' M src/cli.ts\n?? new-file.ts\n',
        'ls-remote origin main': 'def456\trefs/heads/main\n',
        'fetch --quiet origin main': '',
        'rev-list --count HEAD..origin/main': '3\n',
      }),
    )

    const checkout = await inspectCheckout('/repo', h.deps)
    expect(checkout).toEqual({ root: '/repo', behind: 3, dirty: true })
  })

  it('gives up quietly when the remote cannot be read', async () => {
    const h = harness(
      gitScript({
        'rev-parse --is-inside-work-tree': 'true\n',
        'rev-parse HEAD': 'abc123\n',
      }),
    )
    expect(await inspectCheckout('/repo', h.deps)).toBeNull()
  })

  it('never pulls, commits or checks anything out', async () => {
    const h = harness(
      gitScript({
        'rev-parse --is-inside-work-tree': 'true\n',
        'rev-parse HEAD': 'abc123\n',
        'status --porcelain': '',
        'ls-remote origin main': 'def456\trefs/heads/main\n',
        'fetch --quiet origin main': '',
        'rev-list --count HEAD..origin/main': '2\n',
      }),
    )
    await inspectCheckout('/repo', h.deps)

    for (const { args } of h.commands) {
      for (const forbidden of [
        'pull',
        'checkout',
        'reset',
        'commit',
        'merge',
        'stash',
        'clean',
        'rebase',
      ]) {
        expect(args).not.toContain(forbidden)
      }
    }
    // A fetch only updates remote refs; it cannot touch the working tree.
    expect(h.commands.map((c) => c.args[0])).toEqual([
      'rev-parse',
      'rev-parse',
      'status',
      'ls-remote',
      'fetch',
      'rev-list',
    ])
  })
})

describe('the checkout notice', () => {
  it('mentions the checkout when it is behind, and does not offer to pull', async () => {
    const h = harness(
      gitScript({
        'rev-parse --is-inside-work-tree': 'true\n',
        'rev-parse HEAD': 'abc123\n',
        'status --porcelain': '',
        'ls-remote origin main': 'def456\trefs/heads/main\n',
        'fetch --quiet origin main': '',
        'rev-list --count HEAD..origin/main': '2\n',
      }),
      { latest: '0.6.0' },
    )

    const report = await runSelfUpdate({
      current: '0.6.0',
      root: '/repo',
      deps: h.deps,
    })
    const notice = report.lines.join('\n')
    expect(notice).toContain('2 commits behind origin/main')
    expect(notice).toContain('updates itself through npm')
    expect(report.checkout?.behind).toBe(2)
  })

  it('will not so much as suggest touching a dirty checkout', async () => {
    const h = harness(
      gitScript({
        'rev-parse --is-inside-work-tree': 'true\n',
        'rev-parse HEAD': 'abc123\n',
        'status --porcelain': ' M src/ai/render.ts\n',
        'ls-remote origin main': 'def456\trefs/heads/main\n',
        'fetch --quiet origin main': '',
        'rev-list --count HEAD..origin/main': '1\n',
      }),
      { latest: '0.6.0' },
    )

    const report = await runSelfUpdate({
      current: '0.6.0',
      root: '/repo',
      deps: h.deps,
    })
    const notice = report.lines.join('\n')
    expect(notice).toContain('uncommitted changes')
    expect(notice).toContain('leaving it alone')
    expect(notice).not.toContain('git pull')
  })
})

describe('update state', () => {
  it('round-trips what it installed', () => {
    const configRoot = mkdtempSync(path.join(tmpdir(), 'fbdoc-state-'))
    const env = { XDG_CONFIG_HOME: configRoot } as NodeJS.ProcessEnv

    expect(readUpdateState({ env })).toEqual({})
    expect(
      writeUpdateState(
        { installedVersion: '0.6.0', installedAt: '2026-09-28T12:00:00.000Z' },
        { env },
      ),
    ).toBe(true)
    expect(readUpdateState({ env })).toEqual({
      installedVersion: '0.6.0',
      installedAt: '2026-09-28T12:00:00.000Z',
    })
    expect(stateFile('/home/tester', env)).toBe(
      path.join(configRoot, 'freebuff-doctor', 'state.json'),
    )
  })

  it('survives a corrupt file rather than crashing the menu', () => {
    const configRoot = mkdtempSync(path.join(tmpdir(), 'fbdoc-state-'))
    const env = { XDG_CONFIG_HOME: configRoot } as NodeJS.ProcessEnv
    const file = stateFile('/home/tester', env)
    mkdirSync(path.dirname(file), { recursive: true })
    writeFileSync(file, '{ not json')
    expect(readUpdateState({ env })).toEqual({})
  })

  it('records nothing sensitive', () => {
    const configRoot = mkdtempSync(path.join(tmpdir(), 'fbdoc-state-'))
    const env = { XDG_CONFIG_HOME: configRoot } as NodeJS.ProcessEnv
    writeUpdateState({ installedVersion: '0.6.0' }, { env })
    expect(readFileSync(stateFile('/home/tester', env), 'utf8')).toBe(
      '{\n  "installedVersion": "0.6.0"\n}\n',
    )
  })
})
