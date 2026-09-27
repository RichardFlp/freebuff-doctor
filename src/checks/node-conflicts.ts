import { whichAll } from '../util/exec.js'
import { anonymizePath } from '../util/platform.js'
import { found, type DiagnosticCheck } from './types.js'

export type NodeManager =
  | 'nvm'
  | 'fnm'
  | 'volta'
  | 'homebrew'
  | 'scoop'
  | 'winget'
  | 'nodist'
  | 'system'
  | 'bundled'
  | 'unknown'

export const MANAGER_LABEL: Record<NodeManager, string> = {
  nvm: 'nvm',
  fnm: 'fnm',
  volta: 'Volta',
  homebrew: 'Homebrew',
  scoop: 'Scoop',
  winget: 'winget',
  nodist: 'nodist',
  system: 'a system installer',
  bundled: 'an app-bundled runtime',
  unknown: 'an unidentified install',
}

/**
 * Managers that actually take over `node`/`npm` on PATH. App-bundled runtimes
 * (VS Code, Cursor, Codex, …) ship their own Node but do not own the global
 * install, so they are reported without raising an update-loop warning.
 */
const INSTALL_MANAGERS: NodeManager[] = [
  'nvm',
  'fnm',
  'volta',
  'homebrew',
  'scoop',
  'winget',
  'nodist',
  'system',
]

const BUNDLED_MARKERS = [
  '/appdata/local/openai/',
  '/appdata/local/programs/microsoft vs code',
  '/codex/',
  '/cursor/',
  '/.cursor/',
  '/.vscode/',
  '/microsoft vs code/',
  '/windsurf/',
  '/zed/',
  '/trae/',
  '/.bun/',
  '/node_modules/',
]

/**
 * Works out which tool provides a Node binary from its (symlink-resolved) path.
 * Install-manager shims are the root cause of the update loop described in the FAQ.
 */
export function classifyNodeManager(binaryPath: string): NodeManager {
  const value = binaryPath.toLowerCase().replace(/\\/g, '/')
  if (
    value.includes('/.nvm/') ||
    value.includes('/nvm/versions/') ||
    value.includes('/appdata/roaming/nvm/')
  ) {
    return 'nvm'
  }
  if (value.includes('/fnm/') || value.includes('/.fnm/')) return 'fnm'
  if (value.includes('/.volta/') || value.includes('/volta/')) return 'volta'
  if (
    value.includes('/cellar/') ||
    value.includes('/opt/homebrew/') ||
    value.includes('/homebrew/') ||
    value.includes('/linuxbrew/')
  ) {
    return 'homebrew'
  }
  if (value.includes('/scoop/')) return 'scoop'
  if (value.includes('/windowsapps/')) return 'winget'
  if (value.includes('/nodist/')) return 'nodist'
  if (BUNDLED_MARKERS.some((marker) => value.includes(marker))) return 'bundled'
  if (
    value.includes('/program files/nodejs/') ||
    /^\/(usr\/)?(local\/)?bin\//.test(value) ||
    value.startsWith('/usr/bin/')
  ) {
    return 'system'
  }
  return 'unknown'
}

export interface NodeInstallAnalysis {
  /** Resolved binary paths grouped by the tool that provides them. */
  byManager: Map<NodeManager, string[]>
  /** Install managers present, in a stable order. */
  managers: NodeManager[]
  /** App-bundled or unrecognised Node binaries found on PATH. */
  extras: Array<{ manager: NodeManager; path: string }>
  /** True when more than one install tool is providing Node/npm. */
  conflict: boolean
}

/** Groups discovered Node/npm binaries by install manager. */
export function analyzeNodeInstalls(
  binaryPaths: string[],
): NodeInstallAnalysis {
  const byManager = new Map<NodeManager, string[]>()
  for (const binary of binaryPaths) {
    const manager = classifyNodeManager(binary)
    const list = byManager.get(manager) ?? []
    if (!list.includes(binary)) list.push(binary)
    byManager.set(manager, list)
  }

  const managers = INSTALL_MANAGERS.filter((manager) => byManager.has(manager))
  const extras: NodeInstallAnalysis['extras'] = []
  for (const manager of ['bundled', 'unknown'] as const) {
    for (const path of byManager.get(manager) ?? [])
      extras.push({ manager, path })
  }

  return { byManager, managers, extras, conflict: managers.length > 1 }
}

/** Detects two Node installs competing for PATH — the FAQ's update-loop cause. */
export const nodeConflictsCheck: DiagnosticCheck = {
  id: 'node-conflicts',
  title: 'Conflicting Node.js installs',
  async run(context) {
    const candidates: string[] = []
    for (const command of ['node', 'npm', 'npx']) {
      candidates.push(...whichAll(command, { platform: context.platform }))
    }
    // The running runtime is evidence too, even if it is not first on PATH.
    candidates.push(process.execPath)

    const analysis = analyzeNodeInstalls(candidates)
    const show = (value: string): string =>
      anonymizePath(value, context.home, context.platform)
    const isActive = (value: string): boolean => value === process.execPath

    const details: string[] = []
    for (const manager of analysis.managers) {
      const paths = (analysis.byManager.get(manager) ?? []).map(
        (entry) => `${show(entry)}${isActive(entry) ? ' (active)' : ''}`,
      )
      if (paths.length > 0)
        details.push(`${MANAGER_LABEL[manager]}: ${paths.join(', ')}`)
    }
    for (const extra of analysis.extras) {
      details.push(
        `${MANAGER_LABEL[extra.manager]}: ${show(extra.path)}${isActive(extra.path) ? ' (active)' : ''} — ships its own Node, so it is not treated as a competing install`,
      )
    }

    const data = {
      managers: analysis.managers,
      activeNode: show(process.execPath),
      activeManager: classifyNodeManager(process.execPath),
    }

    if (!analysis.conflict) {
      const only = analysis.managers[0]
      return found({
        status: 'pass',
        message: only
          ? `Only one Node.js install was found on PATH (${MANAGER_LABEL[only]}).`
          : 'Only one Node.js install was found on PATH.',
        details,
        data,
      })
    }

    const involvesHomebrew = analysis.managers.includes('homebrew')
    const involvesVersionManager = analysis.managers.some(
      (manager) =>
        manager === 'nvm' || manager === 'fnm' || manager === 'volta',
    )
    const labels = analysis.managers.map((manager) => MANAGER_LABEL[manager])

    return found({
      status: 'warn',
      message: `${analysis.managers.length} separate Node.js installs are on your PATH (${labels.join(' and ')}) — a known cause of endless update loops.`,
      details: [
        ...details,
        `The doctor itself is running with Node at ${show(process.execPath)}.`,
        ...(involvesHomebrew && involvesVersionManager
          ? [
              'Uninstalling the Homebrew copy usually fixes it; nvm/fnm then owns node and npm.',
            ]
          : []),
      ],
      fix: involvesHomebrew
        ? 'brew uninstall node, then let your version manager take over'
        : `Remove one of these from PATH: ${labels.join(', ')}`,
      faqSlug: 'troubleshooting-official',
      data,
    })
  },
}
