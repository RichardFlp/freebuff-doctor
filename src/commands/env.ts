import { exec, whichOne } from '../util/exec.js'
import {
  collectSnapshot,
  type EnvironmentSnapshot,
} from '../util/environment.js'
import { heading, hint, write } from '../ui/output.js'
import { c, GLYPH } from '../ui/theme.js'

// Re-exported so the command's public surface is unchanged after the move.
export { collectSnapshot }
export type { EnvironmentSnapshot }

/** `fbdoc env` — the setup facts, with paths anonymized and secrets redacted. */
export async function runEnvCommand(options: {
  json: boolean
}): Promise<number> {
  // On Windows `npm` is a `.cmd` shim, so resolve it first rather than assuming
  // the bare name is spawnable — the same approach the install check uses.
  const npmBin = whichOne('npm')
  const npmResult = npmBin
    ? await exec(npmBin, ['--version'], { timeoutMs: 8000 })
    : null
  const snapshot: EnvironmentSnapshot = collectSnapshot(process.env, {
    home: process.env.USERPROFILE || process.env.HOME || '',
    npmVersion: npmResult?.ok ? npmResult.stdout.trim() : null,
  })

  if (options.json) {
    write(JSON.stringify(snapshot, null, 2))
    return 0
  }

  heading('Environment')
  write('')
  const facts: Array<[string, string]> = [
    ['Doctor', snapshot.doctor],
    ['Node', snapshot.node],
    ['npm', snapshot.npm ?? 'not found'],
    ['Platform', snapshot.platform],
    ['Working in', snapshot.cwd],
    ['Shell', snapshot.shell ?? 'unknown'],
  ]
  for (const [label, value] of facts) {
    write(`  ${c().dim(label.padEnd(11))}${value}`)
  }

  write('')
  write(
    `  ${c().bold('PATH')} ${c().dim(`${snapshot.pathEntries.length} entries, in search order`)}`,
  )
  for (const entry of snapshot.pathEntries) {
    const marker = entry.duplicate
      ? c().yellow(` ${GLYPH.bullet} duplicate`)
      : ''
    write(
      `    ${c().dim(String(entry.index).padStart(2))}. ${entry.value}${marker}`,
    )
  }

  write('')
  write(`  ${c().bold('Variables that affect Freebuff')}`)
  if (snapshot.variables.length === 0) {
    write(
      c().dim('    None of the variables that usually cause trouble are set.'),
    )
  } else {
    for (const variable of snapshot.variables) {
      write(`    ${c().cyan(variable.name)}=${variable.value}`)
    }
  }

  write('')
  hint('Secrets are redacted and your home directory is replaced with ~.')
  hint('For pass/fail findings instead of raw facts, run `fbdoc check`.')
  return 0
}
