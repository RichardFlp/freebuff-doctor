#!/usr/bin/env node
import { Command, CommanderError } from 'commander'

import { CATEGORY_LABEL, checkDoc } from './checks/catalog.js'
import { checksByCategory, listChecks } from './checks/index.js'
import { runAskCommand } from './commands/ai.js'
import { runCheckCommand } from './commands/check.js'
import { runDiffCommand } from './commands/diff.js'
import { runEnvCommand } from './commands/env.js'
import { runExportCommand } from './commands/export.js'
import { runExplainCommand } from './commands/explain.js'
import { runFaqCommand } from './commands/faq.js'
import { runMenu } from './commands/menu.js'
import {
  DEFAULT_TIMEOUT_MS,
  parseOnly,
  parseTimeout,
  type GlobalOptions,
} from './commands/options.js'
import { runReportCommand } from './commands/report.js'
import { runWizard } from './commands/wizard.js'
import { hint, printFailure, write, writeErr } from './ui/output.js'
import { isCancellation } from './ui/prompts.js'
import { c, setColorEnabled, setVerbose } from './ui/theme.js'
import { padTo } from './util/width.js'
import { doctorVersion } from './util/version.js'

const EXAMPLES = `
Examples:
  $ fbdoc                        Launch the interactive menu
  $ fbdoc check                  Run every diagnostic
  $ fbdoc check --json           Machine-readable results, for CI
  $ fbdoc check --only dns,network   Run a subset of checks
  $ fbdoc check --quiet          Only what needs attention
  $ fbdoc explain config-health  What one check looks at, and why it matters
  $ fbdoc faq "cant connect"     Search the FAQ
  $ fbdoc wizard                 Guided troubleshooting
  $ fbdoc env                    Your setup, with paths and secrets redacted
  $ fbdoc report > report.md     Short redacted report for a help thread
  $ fbdoc export                 Detailed .md report saved to your Downloads folder
  $ fbdoc ask "why won't it start?"   Run the checks, then ask Groq's gpt-oss-20b
  $ fbdoc ask                    Same, but as an interactive chat
  $ fbdoc --no-self-update       Open the menu without checking for a new release
  $ fbdoc diff before.json after.json   Did the fix actually work?

Exit codes:
  0  no problems found (warnings still exit 0 unless --strict is used)
  1  at least one check failed, or the request could not be completed
`

function addCommonOptions(command: Command): Command {
  return command
    .option('--verbose', 'show stack traces and extra diagnostic detail')
    .option('--offline', 'skip every check that needs the network')
    .option(
      '--timeout <ms>',
      `per-network-operation timeout (default ${DEFAULT_TIMEOUT_MS})`,
    )
    .option('--strict', 'treat warnings as failures (exit code 1)')
    .option('--no-color', 'disable coloured output')
}

/** Only the menu path checks for a new release, so only it takes the flag. */
function addSelfUpdateOption(command: Command): Command {
  return command.option(
    '--no-self-update',
    'skip the update check when the interactive menu opens',
  )
}

/**
 * Merges options declared on the root command with those on the subcommand, so
 * both `fbdoc --verbose check` and `fbdoc check --verbose` behave the same.
 */
export function resolveOptions(
  root: Command,
  command?: Command,
): GlobalOptions & { color: boolean } {
  const local = command ? command.opts() : {}
  const global = root.opts()
  const pick = (key: string): unknown => local[key] ?? global[key]
  // `--no-x` options default to true, so `??` cannot merge them: false wins
  // wherever it was given, `fbdoc --no-self-update menu` included.
  const bothTrue = (key: string): boolean =>
    local[key] !== false && global[key] !== false

  return {
    verbose: Boolean(pick('verbose')),
    offline: Boolean(pick('offline')),
    timeoutMs: parseTimeout(pick('timeout')),
    json: Boolean(pick('json')),
    strict: Boolean(pick('strict')),
    all: Boolean(pick('all')),
    quiet: Boolean(pick('quiet')),
    color: pick('color') !== false,
    selfUpdate: bothTrue('selfUpdate'),
    ...(parseOnly(pick('only')) ? { only: parseOnly(pick('only')) } : {}),
  }
}

function applyGlobals(options: { verbose: boolean; color: boolean }): void {
  setVerbose(options.verbose)
  if (!options.color) setColorEnabled(false)
}

/** Builds the command tree. */
export function buildProgram(): Command {
  const program = new Command()

  program
    .name('fbdoc')
    .description(
      'Diagnose and fix common Freebuff problems from your terminal.',
    )
    .version(
      doctorVersion(),
      '-v, --version',
      'print the freebuff-doctor version',
    )
    .exitOverride()
    .showHelpAfterError('(run `fbdoc --help` to see all available commands)')
    .addHelpText('after', EXAMPLES)

  addSelfUpdateOption(addCommonOptions(program))

  program.action(async () => {
    const options = resolveOptions(program)
    applyGlobals(options)
    process.exitCode = await runMenu(options)
  })

  const check = program
    .command('check')
    .description(
      'Run the diagnostic suite and report pass/warn/fail for each check',
    )
    .option('--json', 'print a JSON report instead of formatted output')
    .option(
      '--only <ids>',
      'comma-separated check ids to run (see `fbdoc checks`)',
    )
    .option('--all', 'print every check result, including the ones that passed')
    .option('--quiet', 'print only the checks that need attention')
  addCommonOptions(check).action(async () => {
    const options = resolveOptions(program, check)
    applyGlobals(options)
    process.exitCode = await runCheckCommand(options)
  })

  const explain = program
    .command('explain [id]')
    .description(
      'Explain what a check looks at and why it matters (no id lists them all)',
    )
    .option('--json', 'print the explanation as JSON')
  addCommonOptions(explain).action(async (id: string | undefined) => {
    const options = resolveOptions(program, explain)
    applyGlobals(options)
    process.exitCode = await runExplainCommand(id, { json: options.json })
  })

  const diff = program
    .command('diff <before> <after>')
    .description(
      'Compare two saved `fbdoc check --json` reports to see what a fix changed',
    )
    .option('--json', 'print the comparison as JSON')
  addCommonOptions(diff).action(async (before: string, after: string) => {
    const options = resolveOptions(program, diff)
    applyGlobals(options)
    process.exitCode = await runDiffCommand(before, after, {
      json: options.json,
    })
  })

  const env = program
    .command('env')
    .description(
      'Print your setup (runtime, PATH, relevant variables) with secrets redacted',
    )
    .option('--json', 'print the snapshot as JSON')
  addCommonOptions(env).action(async () => {
    const options = resolveOptions(program, env)
    applyGlobals(options)
    process.exitCode = await runEnvCommand({ json: options.json })
  })

  const faq = program
    .command('faq [query]')
    .description(
      'Search the bundled FAQ (fuzzy: typos and partial phrasing still match)',
    )
    .option('--json', 'print matches as JSON')
    .option('--list', 'list every FAQ section and exit')
    .option('--limit <n>', 'maximum number of matches to show', '5')
  addCommonOptions(faq).action(async (query: string | undefined) => {
    const options = resolveOptions(program, faq)
    applyGlobals(options)
    const limit = Number.parseInt(String(faq.opts().limit ?? '5'), 10)
    process.exitCode = await runFaqCommand(query, {
      ...options,
      ...(Number.isFinite(limit) ? { limit: Math.max(1, limit) } : {}),
      list: Boolean(faq.opts().list),
    })
  })

  const wizard = program
    .command('wizard')
    .description(
      'Guided troubleshooting: answer a few questions to find the right FAQ section',
    )
  addCommonOptions(wizard).action(async () => {
    const options = resolveOptions(program, wizard)
    applyGlobals(options)
    await runWizard(options, { offerNext: true })
    process.exitCode = 0
  })

  const report = program
    .command('report')
    .description(
      'Generate a redacted Markdown support report, ready to paste into Discord',
    )
    .option('--output <file>', 'write the report to a file instead of stdout')
  addCommonOptions(report).action(async () => {
    const options = resolveOptions(program, report)
    applyGlobals(options)
    const output = report.opts().output as string | undefined
    process.exitCode = await runReportCommand({
      ...options,
      ...(output ? { output } : {}),
    })
  })

  const exportCommand = program
    .command('export')
    .description(
      'Write a detailed, redacted report to your Downloads folder for Freebuff helpers',
    )
    .option('--dir <folder>', 'write into this folder instead of Downloads')
    .option('--stdout', 'print the report instead of writing a file')
  addCommonOptions(exportCommand).action(async () => {
    const options = resolveOptions(program, exportCommand)
    applyGlobals(options)
    const opts = exportCommand.opts()
    process.exitCode = await runExportCommand({
      ...options,
      ...(typeof opts.dir === 'string' ? { dir: opts.dir } : {}),
      stdout: Boolean(opts.stdout),
    })
  })

  const ask = program
    .command('ask [question]')
    .description(
      'Run the diagnostics, then ask the AI assistant (Groq, gpt-oss-20b) how to fix what it found',
    )
    .option('--only <ids>', 'comma-separated check ids to run first')
    .option(
      '--no-checks',
      'skip the diagnostics and answer from the question alone',
    )
  addCommonOptions(ask).action(async (question: string | undefined) => {
    const options = resolveOptions(program, ask)
    applyGlobals(options)
    process.exitCode = await runAskCommand(question, {
      ...options,
      diagnostics: ask.opts().checks !== false,
    })
  })

  const menu = program
    .command('menu')
    .description(
      'Launch the interactive menu (same as running fbdoc with no arguments)',
    )
  addSelfUpdateOption(addCommonOptions(menu)).action(async () => {
    const options = resolveOptions(program, menu)
    applyGlobals(options)
    process.exitCode = await runMenu(options)
  })

  program
    .command('checks')
    .description('List every diagnostic check, grouped by what it covers')
    .option('--json', 'print the check list as JSON')
    .action((options: { json?: boolean }) => {
      const rows = listChecks()

      if (options.json) {
        write(
          JSON.stringify(
            {
              total: rows.length,
              checks: rows.map((row) => ({
                id: row.id,
                title: row.title,
                category: checkDoc(row.id)?.category ?? null,
                summary: checkDoc(row.id)?.summary ?? null,
                network: checkDoc(row.id)?.network ?? false,
              })),
            },
            null,
            2,
          ),
        )
        return
      }

      const width = Math.max(...rows.map((row) => row.id.length))
      write(`${c().bold(`${rows.length} diagnostic checks`)}`)
      write('')
      for (const group of checksByCategory()) {
        write(`  ${c().bold(CATEGORY_LABEL[group.category])}`)
        for (const { check: entry, doc } of group.checks) {
          write(
            `    ${c().cyan(padTo(entry.id, width))}  ${c().dim(doc?.summary ?? entry.title)}`,
          )
        }
        write('')
      }
      hint(
        'Explain one with `fbdoc explain <id>`, or run just it with `fbdoc check --only <id>`.',
      )
    })

  return program
}

async function main(): Promise<number> {
  const verboseRequested = process.argv.includes('--verbose')
  const program = buildProgram()

  try {
    await program.parseAsync(process.argv)
    // `process.exitCode` may hold a string; only a number is a valid return here.
    return typeof process.exitCode === 'number' ? process.exitCode : 0
  } catch (error) {
    if (error instanceof CommanderError) {
      // --help and --version are not failures.
      if (
        error.code === 'commander.helpDisplayed' ||
        error.code === 'commander.version' ||
        error.code === 'commander.help'
      ) {
        return 0
      }
      printFailure(error.message, {
        verbose: verboseRequested,
        hint: 'Run `fbdoc --help` to see the available commands.',
      })
      return typeof error.exitCode === 'number' && error.exitCode !== 0
        ? error.exitCode
        : 1
    }

    if (isCancellation(error)) {
      writeErr('')
      writeErr(c().dim('Cancelled.'))
      return 130
    }

    printFailure(error, {
      verbose: verboseRequested,
      hint: 'If this keeps happening, run `fbdoc report` and share it in the Freebuff Discord.',
    })
    return 1
  }
}

// A closed pipe (`fbdoc faq --list | head`) is not an error.
for (const stream of [process.stdout, process.stderr]) {
  stream.on('error', (error: NodeJS.ErrnoException) => {
    if (error.code === 'EPIPE') process.exit(0)
  })
}

process.on('uncaughtException', (error) => {
  printFailure(error, {
    verbose: process.argv.includes('--verbose'),
    hint: 'Please report this at https://github.com/RichardFlp/freebuff-doctor/issues',
  })
  process.exit(1)
})

process.on('unhandledRejection', (reason) => {
  printFailure(reason, {
    verbose: process.argv.includes('--verbose'),
    hint: 'Please report this at https://github.com/RichardFlp/freebuff-doctor/issues',
  })
  process.exit(1)
})

main()
  .then((code) => {
    process.exitCode = code
  })
  .catch((error: unknown) => {
    printFailure(error, { verbose: process.argv.includes('--verbose') })
    process.exitCode = 1
  })
