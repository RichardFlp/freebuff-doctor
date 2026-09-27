import fs from 'node:fs'
import path from 'node:path'

import { canAccess, listDir, safeStat } from '../util/fs-scan.js'
import { anonymizePath } from '../util/platform.js'
import { found, type DiagnosticCheck } from './types.js'

export interface SessionLogs {
  /** Chat transcripts from the CLI, under `<manicode>/projects/<project>/chats`. */
  chatFiles: Array<{ path: string; mtimeMs: number; readable: boolean }>
  /** Desktop session databases, under `<freebuff-desktop>/projects/<slug>/desktop-v2.db`. */
  desktopDbs: Array<{ path: string; mtimeMs: number; readable: boolean }>
  /** Project folders that exist but hold no logs. */
  emptyProjects: number
}

/**
 * Collects the local session logs the FAQ points at, so a user can confirm their
 * history is on disk (and attach it to a help ticket) before assuming data loss.
 */
export function collectSessionLogs(stateDirs: string[]): SessionLogs {
  const chatFiles: SessionLogs['chatFiles'] = []
  const desktopDbs: SessionLogs['desktopDbs'] = []
  let emptyProjects = 0

  for (const stateDir of stateDirs) {
    const projectsDir = path.join(stateDir, 'projects')
    if (!safeStat(projectsDir)?.isDirectory()) continue

    for (const project of listDir(projectsDir)) {
      if (!project.isDirectory()) continue
      const projectDir = path.join(projectsDir, project.name)
      let contributed = false

      // CLI: <project>/chats/<date-time>/log.jsonl
      const chatsDir = path.join(projectDir, 'chats')
      if (safeStat(chatsDir)?.isDirectory()) {
        for (const entry of listDir(chatsDir)) {
          if (entry.isDirectory()) {
            for (const file of listDir(path.join(chatsDir, entry.name))) {
              if (!file.isFile() || !file.name.endsWith('.jsonl')) continue
              const full = path.join(chatsDir, entry.name, file.name)
              chatFiles.push({
                path: full,
                mtimeMs: safeStat(full)?.mtimeMs ?? 0,
                readable: canAccess(full, fs.constants.R_OK),
              })
              contributed = true
            }
          } else if (entry.isFile() && entry.name.endsWith('.jsonl')) {
            const full = path.join(chatsDir, entry.name)
            chatFiles.push({
              path: full,
              mtimeMs: safeStat(full)?.mtimeMs ?? 0,
              readable: canAccess(full, fs.constants.R_OK),
            })
            contributed = true
          }
        }
      }

      // Desktop: <project>/desktop-v2.db
      const desktopDb = path.join(projectDir, 'desktop-v2.db')
      if (safeStat(desktopDb)?.isFile()) {
        desktopDbs.push({
          path: desktopDb,
          mtimeMs: safeStat(desktopDb)?.mtimeMs ?? 0,
          readable: canAccess(desktopDb, fs.constants.R_OK),
        })
        contributed = true
      }

      if (!contributed) emptyProjects += 1
    }
  }

  return { chatFiles, desktopDbs, emptyProjects }
}

/** Confirms chat/session logs exist and can be read. */
export const sessionLogsCheck: DiagnosticCheck = {
  id: 'session-logs',
  title: 'Local sessions and chat logs',
  async run(context) {
    const stateDirs = [
      context.paths.cliState,
      context.paths.desktopState,
      context.paths.legacyState,
    ]
    const logs = collectSessionLogs(stateDirs)
    const show = (value: string): string =>
      anonymizePath(value, context.home, context.platform)

    const all = [...logs.chatFiles, ...logs.desktopDbs]
    const unreadable = all.filter((entry) => !entry.readable)
    const newest = all.reduce<number>(
      (latest, entry) => (entry.mtimeMs > latest ? entry.mtimeMs : latest),
      0,
    )

    const data = {
      chatLogs: logs.chatFiles.length,
      desktopDatabases: logs.desktopDbs.length,
      unreadable: unreadable.length,
      emptyProjects: logs.emptyProjects,
      newest: newest > 0 ? new Date(newest).toISOString() : null,
      sample: logs.chatFiles[0] ? show(logs.chatFiles[0].path) : null,
    }

    if (all.length === 0) {
      return found({
        status: 'warn',
        message:
          'No local chat or session logs found — nothing to recover yet.',
        details: [
          `Checked ${stateDirs.map(show).join(', ')}`,
          logs.emptyProjects > 0
            ? `${logs.emptyProjects} project folder(s) exist but contain no session data.`
            : 'No project folders exist yet.',
        ],
        fix: 'Start a session in Freebuff, then re-run `fbdoc check`',
        faqSlug: 'session--context-recovery',
        data,
      })
    }

    const ageHours = Math.round((Date.now() - newest) / 3_600_000)
    const details = [
      `${logs.chatFiles.length} CLI chat log(s) and ${logs.desktopDbs.length} desktop database(s).`,
      `Most recent session: ${ageHours < 1 ? 'less than an hour ago' : `${ageHours} hours ago`}.`,
    ]

    if (unreadable.length > 0) {
      return found({
        status: 'fail',
        message: `${unreadable.length} session file(s) exist but are not readable by your user account.`,
        details: [
          ...details,
          `Example: ${show(unreadable[0]?.path ?? '')}`,
          'Unreadable logs mean the app may also fail to write new sessions.',
        ],
        fix:
          context.platform === 'win32'
            ? `takeown /F "${context.paths.cliState}" /R /D Y`
            : `sudo chown -R $(whoami) "${context.paths.cliState}"`,
        faqSlug: 'troubleshooting-official',
        data,
      })
    }

    return found({
      status: 'pass',
      message: `Session history is present and readable (${logs.chatFiles.length + logs.desktopDbs.length} file(s)).`,
      details: [
        ...details,
        'Everything is stored locally, so an interrupted session is always recoverable.',
      ],
      faqSlug: 'session--context-recovery',
      data,
    })
  },
}
