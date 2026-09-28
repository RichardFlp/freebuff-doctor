/**
 * Documentation for every diagnostic check.
 *
 * Kept next to the checks rather than inside each module so the whole catalogue
 * reads in one place — `fbdoc checks` groups by category, `fbdoc explain <id>`
 * prints one entry, and `test/checks-extra.test.ts` asserts that the two lists
 * never drift apart.
 */

export type CheckCategory =
  | 'runtime'
  | 'install'
  | 'state'
  | 'sessions'
  | 'network'
  | 'environment'
  | 'storage'
  | 'resources'

export const CATEGORY_ORDER: CheckCategory[] = [
  'runtime',
  'install',
  'state',
  'sessions',
  'network',
  'environment',
  'storage',
  'resources',
]

export const CATEGORY_LABEL: Record<CheckCategory, string> = {
  runtime: 'Runtime',
  install: 'Install',
  state: 'Local state',
  sessions: 'Sessions and logs',
  network: 'Network',
  environment: 'Environment',
  storage: 'Storage',
  resources: 'Resources and processes',
}

export interface CheckDoc {
  category: CheckCategory
  /** One line, shown by `fbdoc checks`. */
  summary: string
  /** What the check actually reads or runs. */
  looks: string[]
  /** Why it is worth knowing about. */
  why: string
  /** True when the check needs the network and reports `skip` under --offline. */
  network?: boolean
  /** FAQ section that covers the problem this check reports. */
  faqSlug?: string
}

export const CHECK_DOCS: Record<string, CheckDoc> = {
  'node-runtime': {
    category: 'runtime',
    summary: 'Node.js and npm versions the app will run on',
    looks: [
      'The Node.js version executing the doctor',
      'Whether the version is one Freebuff supports',
    ],
    why: 'Freebuff needs a modern Node runtime; an old one fails in ways that look like application bugs.',
    faqSlug: 'troubleshooting-official',
  },
  'arch-match': {
    category: 'runtime',
    summary: 'Runtime and machine architecture agree',
    looks: [
      'Process architecture versus operating-system architecture',
      'Rosetta 2 translation on Apple silicon',
      '32-bit runtimes on 64-bit systems',
    ],
    why: 'A translated or mismatched runtime cannot load the engine binary, and the error never mentions architecture.',
    faqSlug: 'crash-on-start--updating',
  },
  'global-install': {
    category: 'install',
    summary: 'Freebuff CLI installed, current and on PATH',
    looks: [
      "npm's global root and installed package versions",
      'The latest published version',
    ],
    why: 'A stale or missing global install is behind most "command not found" and update-loop reports.',
    network: true,
    faqSlug: 'crash-on-start--updating',
  },
  'command-shadowing': {
    category: 'install',
    summary: 'Duplicate commands and repeated PATH entries',
    looks: [
      'Every `freebuff` and `codebuff` executable on PATH, in order',
      'PATH directories listed more than once',
    ],
    why: 'When two installs exist, updating one changes nothing the shell can run.',
    faqSlug: 'troubleshooting-official',
  },
  'binary-integrity': {
    category: 'install',
    summary: 'The installed command is actually runnable',
    looks: [
      'File size, executable bit and symlink targets',
      'The script an npm shim points at',
      'macOS quarantine attributes',
    ],
    why: 'Nothing is executed, so this check can never trigger an engine download or a self-update.',
    faqSlug: 'troubleshooting-official',
  },
  'install-paths': {
    category: 'install',
    summary: 'Install and state directories exist and are readable',
    looks: [
      'CLI, desktop and legacy state directories',
      'Desktop application bundles',
      'The cached engine binary',
    ],
    why: 'Establishes where everything lives before other checks read those directories.',
    faqSlug: 'installation-paths',
  },
  'cache-integrity': {
    category: 'install',
    summary: 'Cached engine and interrupted downloads',
    looks: [
      'Half-written downloads (`*.part`, `*.crdownload`, `*.tmp`)',
      'Superseded engine copies (`freebuff.exe.old.<timestamp>`)',
    ],
    why: 'An interrupted update leaves hundreds of megabytes behind and makes the next update re-download.',
    faqSlug: 'crash-on-start--updating',
  },
  'config-health': {
    category: 'state',
    summary: 'Settings and state files parse and match this version',
    looks: [
      'Every JSON/JSONC file in the state directories',
      'Schema versions, renamed keys and leftover `.tmp`/`.bak` files',
    ],
    why: 'A truncated or newer-than-this-build config file is a common cause of instant crashes.',
    faqSlug: 'troubleshooting-official',
  },
  'auth-session': {
    category: 'state',
    summary: 'Saved login exists, parses and has not expired',
    looks: [
      'Credential files in the state directories',
      'Expiry timestamps and file permissions',
    ],
    why: 'Expired or truncated credentials explain sudden sign-outs. Token values are never read out or reported.',
    faqSlug: 'troubleshooting-official',
  },
  'stale-lock': {
    category: 'state',
    summary: 'Orphaned locks from interrupted runs',
    looks: [
      'Lock, pid and Singleton files, including inside project folders',
      'Whether the owning process is still alive',
    ],
    why: 'A lock held by a process that no longer exists blocks the next launch with no useful message.',
    faqSlug: 'crash-on-start--updating',
  },
  'split-state': {
    category: 'state',
    summary: 'Where local history actually lives',
    looks: [
      'Session counts per state directory',
      'Sessions left in the legacy Codebuff directory',
    ],
    why: 'History stored under a directory the current build no longer reads looks exactly like lost data.',
    faqSlug: 'session--context-recovery',
  },
  'session-logs': {
    category: 'sessions',
    summary: 'Local sessions and chat logs are present and readable',
    looks: [
      'CLI chat logs and desktop session databases',
      'File readability and the most recent session time',
    ],
    why: 'Confirms your history is on disk before anyone assumes data loss.',
    faqSlug: 'session--context-recovery',
  },
  'crash-log': {
    category: 'sessions',
    summary: 'The engine crash log records a recent fatal error',
    looks: [
      'The tail of the newest engine stderr log',
      'Fatal signatures such as out-of-memory or uncaught exceptions',
    ],
    why: 'Distinguishes a crash that just happened from one that is months old.',
    faqSlug: 'session--context-recovery',
  },
  'error-triage': {
    category: 'sessions',
    summary: 'Recent errors recorded in your own logs',
    looks: [
      'Tails of log files in the state directories',
      'Actionable signatures like ENOSPC, EADDRINUSE or TLS failures',
    ],
    why: 'Turns the error you actually hit into a suggested next step. Chat transcripts are never scanned, so pasted code cannot trigger it.',
    faqSlug: 'session--context-recovery',
  },
  'state-growth': {
    category: 'storage',
    summary: 'How much local session data is on the volume',
    looks: [
      'Sizes of session logs and databases per project',
      'The single largest file',
    ],
    why: 'Names the runaway log rather than the volume, which is what actually needs clearing.',
    faqSlug: 'session--context-recovery',
  },
  dns: {
    category: 'network',
    summary: 'Freebuff hostnames resolve normally',
    looks: [
      'System DNS answers for freebuff.com',
      'The same lookup against public resolvers',
    ],
    why: 'Detects hijacked or filtered DNS by comparing the two answers.',
    network: true,
    faqSlug: 'network-issues',
  },
  network: {
    category: 'network',
    summary: 'The API and npm registry are reachable',
    looks: ['A request to Freebuff', 'A request to the npm registry'],
    why: 'Separates "no network at all" from "this service is unreachable from your network".',
    network: true,
    faqSlug: 'network-issues',
  },
  'proxy-trust': {
    category: 'network',
    summary: 'Proxy variables point at a working proxy',
    looks: [
      'HTTP_PROXY, HTTPS_PROXY, ALL_PROXY and NO_PROXY',
      'A TCP connection to the configured proxy',
      'Whether Node is set to use the proxy at all',
    ],
    why: 'A configured proxy that no longer answers blocks every request, and Node ignores proxy variables unless env-proxy support is enabled.',
    network: true,
    faqSlug: 'network-issues',
  },
  'tls-chain': {
    category: 'network',
    summary: 'The certificate chain Freebuff sees is trusted',
    looks: [
      'A live TLS handshake with freebuff.com',
      'Every certificate in the returned chain',
    ],
    why: 'Node ignores the operating-system trust store, so a corporate root that satisfies your browser can still break only Freebuff.',
    network: true,
    faqSlug: 'network-issues',
  },
  'hosts-pin': {
    category: 'network',
    summary: 'The hosts file does not redirect Freebuff',
    looks: [
      'Active entries in the system hosts file',
      'Entries naming a Freebuff domain',
    ],
    why: 'A leftover pinned IP is why a connection works on one network and fails on another.',
    faqSlug: 'network-issues',
  },
  'clock-skew': {
    category: 'network',
    summary: 'System clock, TLS variables and certificate trust',
    looks: [
      "The server's Date header compared with local time",
      'NODE_EXTRA_CA_CERTS, SSL_CERT_FILE and NODE_TLS_REJECT_UNAUTHORIZED',
    ],
    why: 'A skewed clock makes valid tokens and certificates look expired; the variable audit still runs with --offline.',
    network: true,
    faqSlug: 'network-issues',
  },
  'env-hygiene': {
    category: 'environment',
    summary: 'Environment variables that change how Freebuff behaves',
    looks: [
      'NODE_OPTIONS, NODE_PATH and npm configuration variables',
      'Registry overrides in user and project `.npmrc` files',
    ],
    why: 'One stale variable in a shell profile outweighs every other setting.',
    faqSlug: 'troubleshooting-official',
  },
  'node-conflicts': {
    category: 'environment',
    summary: 'Two Node.js installs competing for PATH',
    looks: [
      'Every node, npm and npx binary on PATH',
      'Which install tool provides each one',
    ],
    why: 'Competing installs are the known cause of endless update loops.',
    faqSlug: 'troubleshooting-official',
  },
  'git-prereqs': {
    category: 'environment',
    summary: 'Git is installed and configured for Freebuff',
    looks: [
      'Git availability and global user identity',
      'core.autocrlf, core.longpaths and repository ownership',
    ],
    why: 'Missing git or an unset identity blocks project features with unclear errors.',
    faqSlug: 'troubleshooting-official',
  },
  'watcher-limits': {
    category: 'environment',
    summary: 'OS file-watching limits are high enough',
    looks: [
      'Linux inotify watches and instances',
      'macOS maxfiles and maxfilesperproc',
    ],
    why: 'When these are low, file watching silently stops noticing edits on a large repository.',
    faqSlug: 'working-with-large-codebases',
  },
  'path-length': {
    category: 'environment',
    summary: 'Paths within Windows\u2019 260-character limit',
    looks: [
      'Every file in the Freebuff directories',
      'The longest path and how many approach the limit',
    ],
    why: 'A path over the limit cannot be read at all, so long-path support is only useful once you know it matters.',
    faqSlug: 'troubleshooting-official',
  },
  'temp-health': {
    category: 'storage',
    summary: 'The temporary directory is usable and not clogged',
    looks: [
      'Existence and write access for TMPDIR/TEMP',
      'Free space, entry count and stale files',
    ],
    why: 'A full or unwritable temp directory fails updates with errors that never mention the real cause.',
    faqSlug: 'troubleshooting-official',
  },
  'port-availability': {
    category: 'resources',
    summary: 'Local ports and leftover Freebuff processes',
    looks: [
      'Running Freebuff processes',
      'Which of them hold a listening socket',
    ],
    why: 'An instance left over from a crash keeps the port a new launch expects.',
    faqSlug: 'crash-on-start--updating',
  },
  storage: {
    category: 'storage',
    summary: 'Free disk space and write permissions',
    looks: [
      'Free space on the volume holding the state directory',
      'Write access to the state and npm global directories',
    ],
    why: 'Running out of room mid-update is how state directories end up half-written.',
    faqSlug: 'session--context-recovery',
  },
  'resource-limits': {
    category: 'resources',
    summary: 'Memory, file descriptors and stray processes',
    looks: [
      'Total and free memory, and the file-descriptor limit',
      'Stray Node processes, correlated with any recorded out-of-memory crash',
    ],
    why: 'Ties an out-of-memory crash to the machine limits that caused it.',
    faqSlug: 'working-with-large-codebases',
  },
}

/** Looks up a check's documentation by id. */
export function checkDoc(id: string): CheckDoc | null {
  return CHECK_DOCS[id] ?? null
}

/** Every documented check id, in catalogue order. */
export function documentedIds(): string[] {
  return Object.keys(CHECK_DOCS)
}
