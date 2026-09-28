import { exec } from '../util/exec.js'
import {
  found,
  type CheckContext,
  type DiagnosticCheck,
  type ResultInit,
} from './types.js'

/** Process names that belong to Freebuff or Codebuff. */
export const FREE_BUFF_PROCESS = /freebuff|codebuff/i

export interface ProcessEntry {
  pid: number
  name: string
}

export interface ListenerEntry {
  port: number
  address: string
  /** Null when the platform would not report an owner (permissions). */
  pid: number | null
}

/** Parses `netstat -ano` output on Windows. */
export function parseNetstatListeners(output: string): ListenerEntry[] {
  const listeners: ListenerEntry[] = []
  for (const line of output.split(/\r?\n/)) {
    const match =
      /^\s*TCP\s+(\[[^\]]+\]|[^\s:]+):(\d+)\s+\S+\s+LISTENING\s+(\d+)\s*$/i.exec(
        line,
      )
    if (!match) continue
    const port = Number(match[2])
    const pid = Number(match[3])
    if (!Number.isInteger(port) || port <= 0) continue
    listeners.push({
      port,
      address: match[1] ?? '',
      pid: Number.isInteger(pid) ? pid : null,
    })
  }
  return listeners
}

/** Parses `ss -ltnp` output on Linux. */
export function parseSsListeners(output: string): ListenerEntry[] {
  const listeners: ListenerEntry[] = []
  for (const line of output.split(/\r?\n/)) {
    if (!/^LISTEN/i.test(line.trim())) continue
    const portMatch = /(?:\*|\[[^\]]*\]|[^\s:]+):(\d+)\s/.exec(`${line} `)
    const pidMatch = /pid=(\d+)/.exec(line)
    const port = portMatch ? Number(portMatch[1]) : Number.NaN
    if (!Number.isInteger(port) || port <= 0) continue
    listeners.push({
      port,
      address: '',
      pid: pidMatch?.[1] ? Number(pidMatch[1]) : null,
    })
  }
  return listeners
}

/** Parses `lsof -nP -iTCP -sTCP:LISTEN` output on macOS. */
export function parseLsofListeners(output: string): ListenerEntry[] {
  const listeners: ListenerEntry[] = []
  // The first line is the column header; every row ends with `(LISTEN)`, so
  // the port is read from the address column rather than the last column.
  for (const line of output.split(/\r?\n/).slice(1)) {
    const columns = line.trim().split(/\s+/)
    if (columns.length < 2) continue
    const pid = Number(columns[1])
    const addresses = [...line.matchAll(/([^\s:]*):(\d+)/g)]
    const last = addresses[addresses.length - 1]
    const port = last?.[2] ? Number(last[2]) : Number.NaN
    if (!Number.isInteger(port) || port <= 0) continue
    listeners.push({
      port,
      address: last?.[0] ?? '',
      pid: Number.isInteger(pid) ? pid : null,
    })
  }
  return listeners
}

/** Parses `tasklist /FO CSV /NH` or `ps -eo pid=,comm=` output. */
export function parseProcesses(
  output: string,
  platform: NodeJS.Platform,
): ProcessEntry[] {
  const processes: ProcessEntry[] = []
  for (const line of output.split(/\r?\n/)) {
    const trimmed = line.trim()
    if (!trimmed) continue
    if (platform === 'win32') {
      const columns = trimmed
        .split('","')
        .map((value) => value.replace(/"/g, ''))
      const name = columns[0] ?? ''
      const pid = Number(columns[1])
      if (!name || !Number.isInteger(pid)) continue
      processes.push({ pid, name })
      continue
    }
    const match = /^(\d+)\s+(.+)$/.exec(trimmed)
    if (!match) continue
    const pid = Number(match[1])
    const name = match[2] ?? ''
    if (!Number.isInteger(pid) || !name) continue
    processes.push({ pid, name })
  }
  return processes
}

export interface PortObservation {
  platform: NodeJS.Platform
  processes: ProcessEntry[]
  listeners: ListenerEntry[]
  /** False when the listening-socket table could not be read at all. */
  listenersKnown: boolean
}

function killFix(platform: NodeJS.Platform, pids: number[]): string {
  return platform === 'win32'
    ? `taskkill /PID ${pids.join(' /PID ')} /F`
    : `kill -9 ${pids.join(' ')}`
}

/**
 * Pure verdict for the processes Freebuff has running.
 *
 * A leftover instance from a crash keeps its listening socket, which is why the
 * app can look like it launched while the port it wanted is actually taken. The
 * check counts Freebuff's own listening processes rather than guessing which
 * port the app prefers.
 */
export function classifyPorts(observation: PortObservation): ResultInit {
  const { platform, processes, listeners, listenersKnown } = observation

  const mine = processes.filter((entry) => FREE_BUFF_PROCESS.test(entry.name))
  if (mine.length === 0) {
    return {
      status: 'pass',
      message: 'No Freebuff process is running, so no local port is held.',
      data: { processes: 0, ports: [] },
    }
  }

  const pids = new Set(mine.map((entry) => entry.pid))
  const owned = listeners.filter(
    (entry) => entry.pid !== null && pids.has(entry.pid),
  )
  const listeningPids = [...new Set(owned.map((entry) => entry.pid as number))]
  const ports = [...new Set(owned.map((entry) => entry.port))].sort(
    (a, b) => a - b,
  )
  const names = [...new Set(mine.map((entry) => entry.name))]

  const data = {
    processes: mine.length,
    names,
    listeningProcesses: listeningPids.length,
    ports,
    listenersKnown,
  }

  if (!listenersKnown) {
    return {
      status: 'pass',
      message: `${mine.length} Freebuff process${mine.length === 1 ? '' : 'es'} running, but the listening-socket table could not be read on this system.`,
      details: [
        `Processes: ${names.join(', ')}`,
        'Run the equivalent of `netstat -ano` to see which port they hold.',
      ],
      data,
    }
  }

  if (listeningPids.length > 1 && ports.length > 0) {
    const extras = listeningPids.slice(1)
    return {
      status: 'warn',
      message: `${listeningPids.length} Freebuff processes are listening at once (ports ${ports.join(', ')}), which usually means an earlier session never shut down.`,
      details: [
        `Processes: ${names.join(', ')}`,
        'A leftover instance holds the port a new launch expects, and can also keep a stale lock or session open.',
        `Ending the extra process${extras.length === 1 ? '' : 'es'} is safe when Freebuff is closed: PID ${extras.join(', ')}.`,
      ],
      fix: killFix(platform, extras),
      faqSlug: 'crash-on-start--updating',
      data,
    }
  }

  if (ports.length === 0) {
    return {
      status: 'pass',
      message: `${mine.length} Freebuff process${mine.length === 1 ? '' : 'es'} running without holding a listening port.`,
      details: [`Processes: ${names.join(', ')}`],
      data,
    }
  }

  return {
    status: 'pass',
    message: `Freebuff is listening on port${ports.length === 1 ? '' : 's'} ${ports.join(', ')}, which is expected while it runs.`,
    details: [
      `Processes: ${names.join(', ')}`,
      'No second instance is competing for the same port.',
    ],
    data,
  }
}

/** Reports the local ports Freebuff holds, and any leftover instance. */
export const portAvailabilityCheck: DiagnosticCheck = {
  id: 'port-availability',
  title: 'Local ports and running instances',
  async run(context: CheckContext) {
    const timeoutMs = Math.min(Math.max(context.timeoutMs, 2000), 8000)

    const processResult =
      context.platform === 'win32'
        ? await exec(
            'tasklist',
            ['/FI', 'IMAGENAME eq freebuff*', '/FO', 'CSV', '/NH'],
            { timeoutMs },
          )
        : await exec('ps', ['-eo', 'pid=,comm='], { timeoutMs })

    const processes = processResult.ok
      ? parseProcesses(processResult.stdout, context.platform)
      : []

    // Only look up the socket table when one of our own processes exists, so
    // the check stays free on machines that never run Freebuff.
    const hasCandidates = processes.some((entry) =>
      FREE_BUFF_PROCESS.test(entry.name),
    )
    if (!hasCandidates) {
      return found(
        classifyPorts({
          platform: context.platform,
          processes,
          listeners: [],
          listenersKnown: true,
        }),
      )
    }

    const listenerResult =
      context.platform === 'win32'
        ? await exec('netstat', ['-ano'], {
            timeoutMs,
            maxBuffer: 4 * 1024 * 1024,
          })
        : context.platform === 'darwin'
          ? await exec('lsof', ['-nP', '-iTCP', '-sTCP:LISTEN'], {
              timeoutMs,
              maxBuffer: 4 * 1024 * 1024,
            })
          : await exec('ss', ['-ltnp'], {
              timeoutMs,
              maxBuffer: 4 * 1024 * 1024,
            })

    const listeners = listenerResult.ok
      ? context.platform === 'win32'
        ? parseNetstatListeners(listenerResult.stdout)
        : context.platform === 'darwin'
          ? parseLsofListeners(listenerResult.stdout)
          : parseSsListeners(listenerResult.stdout)
      : []

    return found(
      classifyPorts({
        platform: context.platform,
        processes,
        listeners,
        listenersKnown: listenerResult.ok,
      }),
    )
  },
}
