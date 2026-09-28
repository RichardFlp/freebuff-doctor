import { faqReference } from '../faq/reference.js'
import { printFaqSection, write } from '../ui/output.js'
import { choose, confirm } from '../ui/prompts.js'
import { c, GLYPH } from '../ui/theme.js'
import { runCheckCommand } from './check.js'
import { resolveSections } from './faq.js'
import type { GlobalOptions } from './options.js'

export type WizardAction =
  | { type: 'goto'; node: string }
  | { type: 'showFaq'; slugs: string[] }
  | { type: 'diagnose'; only?: string[] }

export interface WizardChoice {
  label: string
  description?: string
  action: WizardAction
}

export interface WizardNode {
  id: string
  question: string
  choices: WizardChoice[]
}

export const WIZARD_START = 'root'

/**
 * A small decision tree: each answer narrows the problem to the FAQ section(s)
 * that actually cover it, or hands off to the relevant diagnostics.
 */
export const WIZARD_NODES: Record<string, WizardNode> = {
  root: {
    id: 'root',
    question: 'What kind of problem are you having?',
    choices: [
      {
        label: 'Network or connection',
        description:
          'Timeouts, "can\'t use Freebuff on this network", DNS, VPN or proxy trouble',
        action: { type: 'goto', node: 'network' },
      },
      {
        label: 'Crashing, not starting, or updating',
        description: 'Won’t launch, update loop, crashes mid-session',
        action: { type: 'goto', node: 'crash' },
      },
      {
        label: 'Freebucks or billing',
        description: 'Daily limits, wallet balance, plans, refunds',
        action: { type: 'goto', node: 'billing' },
      },
      {
        label: 'Lost session, history or context',
        description:
          'A conversation disappeared or an interrupted prompt needs recovery',
        action: { type: 'goto', node: 'session' },
      },
      {
        label: 'Installing, PATH or version',
        description:
          '“command not found”, permission errors, which version is installed',
        action: { type: 'goto', node: 'install' },
      },
      {
        label: 'Cloud, GitHub, deploy or MCP',
        description: 'Project URLs, deploys, custom domains, custom connectors',
        action: { type: 'goto', node: 'integrations' },
      },
      {
        label: 'Not sure — just run the diagnostics',
        description: 'Run every check and report what looks wrong',
        action: { type: 'diagnose' },
      },
    ],
  },

  network: {
    id: 'network',
    question: 'What happens exactly?',
    choices: [
      {
        label: 'It says it can’t use Freebuff on this network',
        description: 'Or requests simply time out',
        action: { type: 'showFaq', slugs: ['network-issues'] },
      },
      {
        label: 'Nothing loads / looks like a DNS problem',
        action: { type: 'showFaq', slugs: ['network-issues'] },
      },
      {
        label: 'I use a VPN, proxy or TUN adapter',
        action: { type: 'showFaq', slugs: ['network-issues'] },
      },
      {
        label: 'I was banned and think it was a false positive',
        action: {
          type: 'showFaq',
          slugs: ['bans--false-positives', 'network-issues'],
        },
      },
      {
        label: 'Run just the network checks',
        action: {
          type: 'diagnose',
          only: [
            'dns',
            'network',
            'proxy-trust',
            'tls-chain',
            'hosts-pin',
            'clock-skew',
            'env-hygiene',
          ],
        },
      },
    ],
  },

  crash: {
    id: 'crash',
    question: 'How does it fail?',
    choices: [
      {
        label: 'It won’t open at all',
        action: { type: 'showFaq', slugs: ['crash-on-start--updating'] },
      },
      {
        label: 'It keeps updating itself in a loop',
        description: 'Usually two competing Node installs',
        action: {
          type: 'showFaq',
          slugs: ['troubleshooting-official', 'crash-on-start--updating'],
        },
      },
      {
        label: 'It crashes during a session',
        action: {
          type: 'showFaq',
          slugs: ['session--context-recovery', 'known-bugs--status-notes'],
        },
      },
      {
        label: 'I get “request body over 16777216 bytes”',
        action: { type: 'showFaq', slugs: ['known-bugs--status-notes'] },
      },
      {
        label: 'The CLI can’t be found after installing',
        action: {
          type: 'showFaq',
          slugs: ['troubleshooting-official', 'quick-start'],
        },
      },
      {
        label: 'Run just the startup checks',
        action: {
          type: 'diagnose',
          only: [
            'node-runtime',
            'arch-match',
            'global-install',
            'command-shadowing',
            'binary-integrity',
            'cache-integrity',
            'config-health',
            'auth-session',
            'stale-lock',
            'port-availability',
            'node-conflicts',
            'crash-log',
          ],
        },
      },
    ],
  },

  billing: {
    id: 'billing',
    question: 'What do you need to know?',
    choices: [
      {
        label: 'I ran out of Freebucks / hit the daily limit',
        action: {
          type: 'showFaq',
          slugs: ['freebucks-currency--daily-limits'],
        },
      },
      {
        label: 'How many Freebucks should I get?',
        description: 'Limits by region and plan',
        action: {
          type: 'showFaq',
          slugs: ['freebucks-currency--daily-limits'],
        },
      },
      {
        label: 'I want a refund',
        action: { type: 'showFaq', slugs: ['freebucks-refunds'] },
      },
      {
        label: 'Who do I contact about billing?',
        action: {
          type: 'showFaq',
          slugs: ['freebucks-refunds', 'getting-help--who-to-contact'],
        },
      },
    ],
  },

  session: {
    id: 'session',
    question: 'What are you trying to recover?',
    choices: [
      {
        label: 'A conversation that vanished',
        action: { type: 'showFaq', slugs: ['session--context-recovery'] },
      },
      {
        label: 'Context I lost after a crash',
        action: { type: 'showFaq', slugs: ['session--context-recovery'] },
      },
      {
        label: 'I want to find my local log files',
        action: { type: 'showFaq', slugs: ['session--context-recovery'] },
      },
      {
        label: 'Mission mode is misbehaving',
        action: { type: 'showFaq', slugs: ['mission-mode'] },
      },
      {
        label: 'Run just the log checks',
        action: {
          type: 'diagnose',
          only: [
            'split-state',
            'session-logs',
            'crash-log',
            'error-triage',
            'state-growth',
            'install-paths',
          ],
        },
      },
    ],
  },

  install: {
    id: 'install',
    question: 'What is going wrong with the install?',
    choices: [
      {
        label: '“command not found” or not on PATH',
        action: { type: 'showFaq', slugs: ['troubleshooting-official'] },
      },
      {
        label: 'Permission errors while installing',
        action: { type: 'showFaq', slugs: ['troubleshooting-official'] },
      },
      {
        label: 'How do I update to the latest version?',
        action: { type: 'showFaq', slugs: ['crash-on-start--updating'] },
      },
      {
        label: 'Where is Freebuff installed on disk?',
        action: { type: 'showFaq', slugs: ['installation-paths'] },
      },
      {
        label: 'What version am I running?',
        action: {
          type: 'showFaq',
          slugs: ['crash-on-start--updating', 'troubleshooting-official'],
        },
      },
      {
        label: 'Run just the install checks',
        action: {
          type: 'diagnose',
          only: [
            'node-runtime',
            'arch-match',
            'global-install',
            'command-shadowing',
            'binary-integrity',
            'cache-integrity',
            'git-prereqs',
            'install-paths',
            'temp-health',
            'path-length',
            'storage',
          ],
        },
      },
    ],
  },

  integrations: {
    id: 'integrations',
    question: 'Which integration is involved?',
    choices: [
      {
        label: 'A custom MCP server or connector',
        action: {
          type: 'showFaq',
          slugs: ['mcp-server-setup-beta', 'mcp-servers'],
        },
      },
      {
        label: 'Deploying, GitHub or a custom domain',
        action: { type: 'showFaq', slugs: ['using-freebuff-cloud'] },
      },
      {
        label: 'A project stuck “Archiving”',
        action: { type: 'showFaq', slugs: ['cloud-archiving-issues'] },
      },
      {
        label: 'I can’t find my project URL',
        action: { type: 'showFaq', slugs: ['getting-your-project-url'] },
      },
      {
        label: 'Exporting my code / database',
        action: {
          type: 'showFaq',
          slugs: ['exporting-code--migrating-your-database'],
        },
      },
    ],
  },
}

/** Prints the FAQ sections the wizard landed on, with a pointer to each. */
export function showWizardSections(slugs: string[]): number {
  const sections = resolveSections(slugs)
  if (sections.length === 0) {
    write(`${c().yellow('No matching FAQ section was found for that answer.')}`)
    write(c().dim('Try `fbdoc faq --list` to browse everything.'))
    return 0
  }

  write('')
  write(
    `${c().dim(`${GLYPH.arrow} ${sections.length} matching FAQ section${sections.length === 1 ? '' : 's'}`)}`,
  )

  for (const section of sections) {
    printFaqSection(section)
  }

  const reference = faqReference(sections[0]?.slug ?? '')
  if (reference) {
    write(c().dim(`Read it again later with: ${reference.command}`))
    write('')
  }
  return sections.length
}

/**
 * Runs the wizard. `offerNext` is false when the caller (the main menu) will run
 * its own "what next?" prompt.
 */
export async function runWizard(
  options: GlobalOptions,
  behaviour: { offerNext?: boolean } = {},
): Promise<void> {
  let nodeId = WIZARD_START

  for (;;) {
    const node = WIZARD_NODES[nodeId]
    if (!node) return

    const choice = await choose<number>({
      message: node.question,
      choices: node.choices.map((entry, index) => ({
        name: entry.label,
        value: index,
        ...(entry.description ? { description: entry.description } : {}),
      })),
    })

    if (choice === null) {
      write(c().dim('Cancelled.'))
      return
    }
    const selected = node.choices[choice]
    if (!selected) return

    if (selected.action.type === 'goto') {
      nodeId = selected.action.node
      continue
    }

    if (selected.action.type === 'showFaq') {
      showWizardSections(selected.action.slugs)
      if (behaviour.offerNext === false) return
      const wantsDiagnostics = await confirm({
        message: 'Run the diagnostics now?',
        default: true,
      })
      if (wantsDiagnostics) {
        await runCheckCommand(options)
      }
      return
    }

    await runCheckCommand({
      ...options,
      ...(selected.action.only ? { only: selected.action.only } : {}),
    })
    return
  }
}
