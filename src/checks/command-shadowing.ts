import path from 'node:path'

import { whichAll } from '../util/exec.js'
import { anonymizePath } from '../util/platform.js'
import {
  found,
  type CheckContext,
  type DiagnosticCheck,
  type ResultInit,
} from './types.js'

/** Commands whose shadowing changes what actually runs. */
export const SHADOWED_COMMANDS = ['freebuff', 'codebuff'] as const

/** PATH entries that appear more than once, in the order they are first seen. */
export function duplicatePathEntries(
  pathValue: string,
  platform: NodeJS.Platform,
): string[] {
  const seen = new Set<string>()
  const duplicates: string[] = []
  // Split on the delimiter belonging to the platform being inspected, not the
  // one this process happens to be running on, so the logic stays testable.
  const delimiter = platform === 'win32' ? ';' : ':'

  for (const raw of pathValue.split(delimiter)) {
    const entry = raw.trim().replace(/^"(.*)"$/, '$1')
    if (!entry) continue
    const normalized =
      platform === 'win32'
        ? entry.replace(/[\\/]+$/, '').toLowerCase()
        : entry.replace(/\/+$/, '')
    if (seen.has(normalized)) {
      if (!duplicates.includes(entry)) duplicates.push(entry)
      continue
    }
    seen.add(normalized)
  }

  return duplicates
}

export interface ShadowingObservation {
  platform: NodeJS.Platform
  command: string
  /** Every distinct executable on PATH, in PATH order. */
  matches: string[]
  duplicatePathEntries: string[]
}

/**
 * Pure verdict for a shadowed command.
 *
 * `whichAll` already collapses several PATH entries that resolve to the same
 * file, so more than one match means genuinely different installs — the case
 * where updating "the" CLI refreshes a copy the shell never runs.
 */
export function classifyShadowing(
  observation: ShadowingObservation,
): ResultInit {
  const { command, matches, duplicatePathEntries: duplicates } = observation

  if (matches.length <= 1 && duplicates.length === 0) {
    return {
      status: 'pass',
      message:
        matches.length === 1
          ? `Only one \`${command}\` command is on your PATH.`
          : `No \`${command}\` command was found on your PATH, so nothing can be shadowed.`,
      data: { matches, duplicatePathEntries: duplicates },
    }
  }

  if (matches.length > 1) {
    return {
      status: 'warn',
      message: `${matches.length} different \`${command}\` commands are on your PATH, so the first one wins and updates to the others change nothing you can run.`,
      details: [
        ...matches.map(
          (match, index) => `${index === 0 ? 'Runs' : 'Shadowed'}: ${match}`,
        ),
        `The shell always runs the first entry, so update or remove that one.`,
        ...(duplicates.length > 0
          ? [
              `Your PATH also lists ${duplicates.length} director${duplicates.length === 1 ? 'y' : 'ies'} twice: ${duplicates.join(', ')}`,
            ]
          : []),
      ],
      faqSlug: 'troubleshooting-official',
      data: { matches, duplicatePathEntries: duplicates },
    }
  }

  const first = duplicates[0] ?? ''
  return {
    status: 'warn',
    message: `Your PATH lists the same ${duplicates.length} director${duplicates.length === 1 ? 'y' : 'ies'} more than once (starting with ${first}), which slows down every command lookup and hides stale tools.`,
    details: [
      ...duplicates.map((entry) => `Repeated PATH entry: ${entry}`),
      'Removing the repeats keeps command resolution predictable.',
    ],
    faqSlug: 'troubleshooting-official',
    data: { matches, duplicatePathEntries: duplicates },
  }
}

/** Reports duplicate `freebuff`/`codebuff` commands and repeated PATH entries. */
export const commandShadowingCheck: DiagnosticCheck = {
  id: 'command-shadowing',
  title: 'Shadowed commands and PATH',
  async run(context: CheckContext) {
    const pathValue = context.env.PATH ?? context.env.Path ?? ''
    const duplicates = duplicatePathEntries(pathValue, context.platform)

    const perCommand = SHADOWED_COMMANDS.map((command) => ({
      command,
      matches: whichAll(command, { pathValue, platform: context.platform }).map(
        (match) => anonymizePath(match, context.home, context.platform),
      ),
    }))

    const worst = perCommand
      .slice()
      .sort((a, b) => b.matches.length - a.matches.length)[0]

    const verdict = classifyShadowing({
      platform: context.platform,
      command: worst?.command ?? 'freebuff',
      matches: worst?.matches ?? [],
      duplicatePathEntries: duplicates,
    })

    const other = perCommand.filter((entry) => entry.command !== worst?.command)

    return found({
      ...verdict,
      ...(other.some((entry) => entry.matches.length > 1)
        ? {
            details: [
              ...(verdict.details ?? []),
              ...other
                .filter((entry) => entry.matches.length > 1)
                .map(
                  (entry) =>
                    `${entry.matches.length} \`${entry.command}\` commands are also on your PATH.`,
                ),
            ],
          }
        : {}),
      data: {
        commands: perCommand,
        pathEntries: pathValue
          .split(path.delimiter)
          .filter((entry) => entry.trim() !== '').length,
        duplicatePathEntries: duplicates,
      },
    })
  },
}
