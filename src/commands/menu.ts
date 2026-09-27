import { c, isInteractive } from '../ui/theme.js'
import { write, writeErr } from '../ui/output.js'
import { choose } from '../ui/prompts.js'
import { describePlatform } from '../util/platform.js'
import { doctorVersion } from '../util/version.js'
import { runCheckCommand } from './check.js'
import { promptFaqSearch } from './faq.js'
import { runReportCommand } from './report.js'
import { runWizard } from './wizard.js'
import type { GlobalOptions } from './options.js'

type MenuChoice = 'check' | 'faq' | 'wizard' | 'report' | 'quit'

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

  printBanner()

  for (;;) {
    const choice = await choose<MenuChoice>({
      message: 'What would you like to do?',
      choices: [
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
          name: 'Export a support report',
          value: 'report',
          description:
            'Redacted report you can paste into a Discord help thread',
        },
        { name: 'Quit', value: 'quit' },
      ],
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
      case 'report':
        await runReportCommand(options)
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
