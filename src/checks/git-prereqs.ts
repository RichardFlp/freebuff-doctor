import { exec } from '../util/exec.js'
import {
  found,
  type CheckContext,
  type DiagnosticCheck,
  type ResultInit,
} from './types.js'

export interface GitObservation {
  platform: NodeJS.Platform
  /** `git version 2.47.0`-style string, or null when git is unavailable. */
  gitVersion: string | null
  userName: string | null
  userEmail: string | null
  /** `core.longpaths`; only meaningful on Windows. */
  longPaths: string | null
  /** `core.autocrlf`. */
  autoCrlf: string | null
  /** Repository root when the working directory is inside one. */
  repoPath: string | null
  /** Git refused to touch the repository because another user owns it. */
  dubiousOwnership: boolean
}

interface GitProblem {
  severity: 'fail' | 'warn'
  message: string
  fix?: string
}

/** One command that installs git on this platform. */
export function installGitFix(platform: NodeJS.Platform): string {
  if (platform === 'win32') return 'winget install --id Git.Git -e'
  if (platform === 'darwin') return 'brew install git'
  return 'sudo apt install git'
}

/**
 * Pure verdict for git and its global config. Without git the agent cannot
 * create commits at all, and without an identity every commit fails at the last
 * step — which looks like a Freebuff bug rather than a missing setting.
 */
export function classifyGitPrereqs(observation: GitObservation): ResultInit {
  const problems: GitProblem[] = []

  if (!observation.gitVersion) {
    problems.push({
      severity: 'fail',
      message:
        'git is not installed (or not on PATH), so Freebuff cannot create commits or review diffs.',
      fix: installGitFix(observation.platform),
    })
  } else {
    if (!observation.userName) {
      problems.push({
        severity: 'warn',
        message:
          'git has no global user.name, so every commit Freebuff makes fails.',
        fix: 'git config --global user.name "Your Name"',
      })
    }
    if (!observation.userEmail) {
      problems.push({
        severity: 'warn',
        message:
          'git has no global user.email, so every commit Freebuff makes fails.',
        fix: 'git config --global user.email "you@example.com"',
      })
    }
    if (observation.platform === 'win32' && observation.longPaths !== 'true') {
      problems.push({
        severity: 'warn',
        message:
          'git is not set up for long paths, so files nested deeper than 260 characters cannot be checked out or committed on Windows.',
        fix: 'git config --global core.longpaths true',
      })
    }
    if (observation.platform === 'win32' && observation.autoCrlf === 'input') {
      problems.push({
        severity: 'warn',
        message:
          'core.autocrlf is set to "input" on Windows, which rewrites line endings in ways this machine is not expecting.',
        fix: 'git config --global core.autocrlf true',
      })
    }
    if (observation.platform !== 'win32' && observation.autoCrlf === 'true') {
      problems.push({
        severity: 'warn',
        message:
          'core.autocrlf is set to "true" on a non-Windows machine, so every file gains carriage returns on checkout.',
        fix: 'git config --global core.autocrlf input',
      })
    }
    if (observation.dubiousOwnership) {
      problems.push({
        severity: 'warn',
        message: `git refuses to read ${observation.repoPath ?? 'the current repository'} because another user owns the files.`,
        fix: `git config --global --add safe.directory "${observation.repoPath ?? '.'}"`,
      })
    }
  }

  const failing = problems.filter((problem) => problem.severity === 'fail')
  const primary = failing[0] ?? problems[0]

  if (!primary) {
    return {
      status: 'pass',
      message: `${observation.gitVersion ?? 'git'} is ready to commit.`,
      details: [
        `Commits will be authored as ${observation.userName ?? 'unknown'} <${observation.userEmail ?? 'unknown'}>.`,
        observation.repoPath
          ? `Working directory is inside a git repository: ${observation.repoPath}`
          : 'The working directory is not inside a git repository.',
      ],
    }
  }

  const details = [
    ...(observation.gitVersion ? [observation.gitVersion] : []),
    ...problems
      .filter((problem) => problem !== primary)
      .map((problem) => problem.message),
  ]

  return {
    status: failing.length > 0 ? 'fail' : 'warn',
    message: primary.message,
    details,
    ...(primary.fix ? { fix: primary.fix } : {}),
    faqSlug: 'troubleshooting-official',
  }
}

async function readGlobalConfig(
  key: string,
  cwd: string,
  timeoutMs: number,
): Promise<string | null> {
  const result = await exec('git', ['config', '--global', '--get', key], {
    cwd,
    timeoutMs,
  })
  const value = result.stdout.trim().split(/\r?\n/)[0]?.trim()
  return result.ok && value ? value : null
}

/**
 * Checks git itself and the global configuration Freebuff's commit workflow
 * depends on: an author identity, long-path support on Windows, and sane line
 * endings.
 */
export const gitPrereqsCheck: DiagnosticCheck = {
  id: 'git-prereqs',
  title: 'Git availability and config',
  async run(context: CheckContext) {
    const timeoutMs = Math.min(Math.max(context.timeoutMs, 3000), 15_000)
    const version = await exec('git', ['--version'], {
      cwd: context.cwd,
      timeoutMs,
    })
    const gitVersion = version.ok
      ? version.stdout.trim() || version.stderr.trim()
      : null

    const observation: GitObservation = {
      platform: context.platform,
      gitVersion,
      userName: null,
      userEmail: null,
      longPaths: null,
      autoCrlf: null,
      repoPath: null,
      dubiousOwnership: false,
    }

    if (gitVersion) {
      observation.userName = await readGlobalConfig(
        'user.name',
        context.cwd,
        timeoutMs,
      )
      observation.userEmail = await readGlobalConfig(
        'user.email',
        context.cwd,
        timeoutMs,
      )
      observation.autoCrlf = await readGlobalConfig(
        'core.autocrlf',
        context.cwd,
        timeoutMs,
      )
      if (context.platform === 'win32') {
        observation.longPaths = await readGlobalConfig(
          'core.longpaths',
          context.cwd,
          timeoutMs,
        )
      }

      // One `rev-parse` doubles as the repo probe and the ownership probe: git
      // reports the dubious-ownership refusal on stderr here.
      const top = await exec('git', ['rev-parse', '--show-toplevel'], {
        cwd: context.cwd,
        timeoutMs,
      })
      observation.repoPath = top.ok ? top.stdout.trim() : null
      observation.dubiousOwnership =
        /dubious ownership|safe\.directory/i.test(top.stderr) ||
        /dubious ownership|safe\.directory/i.test(version.stderr)
    }

    const verdict = classifyGitPrereqs(observation)
    return found({
      ...verdict,
      data: {
        gitVersion: observation.gitVersion,
        userName: observation.userName,
        userEmail: observation.userEmail,
        autoCrlf: observation.autoCrlf,
        longPaths: observation.longPaths,
        repoPath: observation.repoPath,
        dubiousOwnership: observation.dubiousOwnership,
      },
    })
  },
}
