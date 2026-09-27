import os from 'node:os'
import path from 'node:path'

export const isWindows = process.platform === 'win32'
export const isMac = process.platform === 'darwin'
export const isLinux = process.platform === 'linux'

export interface PlatformPaths {
  home: string
  /** Platform config root, honouring `XDG_CONFIG_HOME` where it applies. */
  configRoot: string
  /** `~/.config/manicode` — CLI/engine state: chats, cached binary, crash logs. */
  cliState: string
  /** `~/.config/freebuff-desktop` — Desktop app state and session databases. */
  desktopState: string
  /** `~/.config/codebuff` — older Codebuff state directory still seen in the wild. */
  legacyState: string
  /** Desktop application bundles to probe, most likely first. */
  desktopInstalls: string[]
}

/**
 * Resolves the directories Freebuff and Codebuff use on this machine.
 * Kept platform-aware but free of filesystem access so it stays cheap and testable.
 */
export function resolvePlatformPaths(
  home = os.homedir(),
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
): PlatformPaths {
  const configRoot = env.XDG_CONFIG_HOME?.trim() || path.join(home, '.config')

  const desktopInstalls: string[] = []
  if (platform === 'win32') {
    const localAppData =
      env.LOCALAPPDATA?.trim() || path.join(home, 'AppData', 'Local')
    desktopInstalls.push(
      path.join(localAppData, 'Programs', '@codebufffreebuff-desktop'),
      path.join(localAppData, 'Programs', 'freebuff-desktop'),
      path.join(localAppData, 'Programs', 'Freebuff Desktop'),
    )
  } else if (platform === 'darwin') {
    desktopInstalls.push(
      '/Applications/Freebuff Desktop.app',
      path.join(home, 'Applications', 'Freebuff Desktop.app'),
    )
  } else {
    desktopInstalls.push(
      '/opt/Freebuff Desktop',
      '/opt/freebuff-desktop',
      path.join(
        home,
        '.local',
        'share',
        'applications',
        'freebuff-desktop.desktop',
      ),
    )
  }

  return {
    home,
    configRoot,
    cliState: path.join(configRoot, 'manicode'),
    desktopState: path.join(configRoot, 'freebuff-desktop'),
    legacyState: path.join(configRoot, 'codebuff'),
    desktopInstalls,
  }
}

/** Human-readable platform string, e.g. `win32 10.0.26100 (x64)`. */
export function describePlatform(): string {
  const release = os.release()
  return `${process.platform} ${release} (${process.arch})`
}

/**
 * Replaces the user's home directory and username with placeholders so a report
 * can be pasted into a public channel without leaking identity.
 */
export function anonymizePath(
  value: string,
  home = os.homedir(),
  platform: NodeJS.Platform = process.platform,
): string {
  if (!value) return value
  let result = value
  // Match both native and forward-slash spellings of home.
  const variants = [home, home.replace(/\\/g, '/')]
  for (const variant of variants) {
    if (variant && result.includes(variant)) {
      result = result.split(variant).join('~')
    }
  }
  const username = path.basename(home)
  if (username && platform === 'win32') {
    const escaped = username.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
    result = result.replace(
      new RegExp(`\\\\Users\\\\${escaped}`, 'gi'),
      '\\Users\\<user>',
    )
  }
  return result
}
