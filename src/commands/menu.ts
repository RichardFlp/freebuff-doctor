import { c, isInteractive } from '../ui/theme.js'
import { write, writeErr } from '../ui/output.js'
import { choose, type Choice } from '../ui/prompts.js'
import { printUpdateReport, runSelfUpdate } from '../selfupdate/check.js'
import { describePlatform } from '../util/platform.js'
import { doctorVersion } from '../util/version.js'
import { runAiCommand } from './ai.js'
import { runCheckCommand } from './check.js'
import { runExportCommand } from './export.js'
import { promptFaqSearch } from './faq.js'
import { runReportCommand } from './report.js'
import { runWizard } from './wizard.js'
import type { GlobalOptions } from './options.js'

export type MenuChoice =
  'check' | 'faq' | 'wizard' | 'ai' | 'export' | 'report' | 'quit'

/** The order the menu is drawn in, and the help text under each row. */
export const MENU_CHOICES: Array<Choice<MenuChoice>> = [
  {
    name: 'Run diagnostics',
    value: 'check',
    description: 'Run every check and show what needs fixing',
  },
  {
    name: 'Search the FAQ',
    value: 'faq',
    description: 'Find an answer in the bundled FAQ',
  },
  {
    name: 'Troubleshooting wizard',
    value: 'wizard',
    description: 'Answer a few questions to get the right FAQ section',
  },
  {
    name: 'Connect Groq API for AI assistance',
    value: 'ai',
    description:
      'Run the diagnostics, then chat with gpt-oss-20b about what to fix',
  },
  {
    name: 'Export a report for Freebuff helpers',
    value: 'export',
    description:
      'Detailed .md file saved to your Downloads folder, ready for helpers, mods or support',
  },
  {
    name: 'Quick report (paste into Discord)',
    value: 'report',
    description:
      'Short redacted report printed here, under Discord\u2019s message limit',
  },
  { name: 'Quit', value: 'quit' },
]

/** Small, information-first banner — no ASCII art. */
export function printBanner(): void {
  write(`${c().bold('Freebuff Doctor')} ${c().dim(doctorVersion())}`)
  write(c().dim(`${describePlatform()} · Node ${process.version}`))
  write('')
}

/**
 * The interactive entry point: a menu that loops until the user quits, so a
 * support conversation can run several commands without re-typing `fbdoc`.
 */
export async function runMenu(options: GlobalOptions): Promise<number> {
  if (!isInteractive()) {
    // Piped or CI: do something useful rather than failing on a prompt.
    writeErr(
      c().dim(
        'No interactive terminal detected — running the diagnostics instead.',
      ),
    )
    return runCheckCommand(options)
  }

  // Keep the npm-installed copy current. Only ever on an interactive menu: a
  // piped or CI `fbdoc` runs the diagnostics, and installing packages on a
  // script's behalf would be a surprise.
  printUpdateReport(
    await runSelfUpdate({
      offline: options.offline,
      verbose: options.verbose,
      enabled: options.selfUpdate !== false,
    }),
  )

  printBanner()

  for (;;) {
    const choice = await choose<MenuChoice>({
      message: 'What would you like to do?',
      choices: MENU_CHOICES,
    })

    if (choice === null || choice === 'quit') {
      write(c().dim('Bye.'))
      return 0
    }

    switch (choice) {
      case 'check':
        await runCheckCommand(options)
        break
      case 'faq':
        await promptFaqSearch(options)
        break
      case 'wizard':
        // The menu's "anything else?" prompt already covers what comes next.
        await runWizard(options, { offerNext: false })
        break
      case 'ai':
        await runAiCommand(options)
        break
      case 'report':
        await runReportCommand(options)
        break
      case 'export':
        await runExportCommand(options)
        break
    }

    const next = await choose<'menu' | 'quit'>({
      message: 'Anything else?',
      choices: [
        { name: 'Back to the menu', value: 'menu' },
        { name: 'Quit', value: 'quit' },
      ],
    })
    if (next === null || next === 'quit') {
      write(c().dim('Bye.'))
      return 0
    }
    write('')
  }
}
