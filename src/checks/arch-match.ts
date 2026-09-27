import { exec } from '../util/exec.js'
import {
  found,
  type CheckContext,
  type DiagnosticCheck,
  type ResultInit,
} from './types.js'

/**
 * Collapses the many spellings of a CPU architecture onto Node's own names, so
 * `uname` output and `process.arch` can be compared directly.
 */
export function normalizeArch(value: string | null | undefined): string | null {
  const raw = (value ?? '').trim().toLowerCase()
  if (!raw) return null
  if (raw === 'x64' || raw === 'x86_64' || raw === 'x86-64' || raw === 'amd64')
    return 'x64'
  if (
    raw === 'arm64' ||
    raw === 'aarch64' ||
    raw === 'armv8' ||
    raw === 'armv8l'
  )
    return 'arm64'
  if (
    raw === 'ia32' ||
    raw === 'x86' ||
    raw === 'win32' ||
    /^i[3-6]86$/.test(raw)
  ) {
    return 'ia32'
  }
  if (raw.startsWith('armv7') || raw === 'arm') return 'arm'
  if (raw === 'ppc64' || raw === 'ppc64le') return 'ppc64'
  if (raw === 's390x') return 's390x'
  return raw
}

export interface ArchObservation {
  /** `process.arch` of the running Node runtime. */
  processArch: string
  /** The machine's architecture, or null when it could not be determined. */
  osArch: string | null
  /** macOS Rosetta 2: true when Node itself is a translated process. */
  translated: boolean | null
}

const NATIVE_HINT =
  'Install a Node.js build that matches this machine (nvm: `nvm install --lts --latest-npm`)'

/**
 * Pure comparison of runtime and machine architecture. Two situations deserve a
 * warning even though everything "works": a translated (Rosetta) runtime and a
 * 32-bit runtime on a 64-bit machine, because prebuilt native binaries then
 * resolve for the wrong target.
 */
export function classifyArchMatch(observation: ArchObservation): ResultInit {
  const proc = normalizeArch(observation.processArch)
  const os = normalizeArch(observation.osArch)
  const details: string[] = []
  if (observation.osArch) {
    details.push(
      `Node reports ${proc ?? observation.processArch}; the machine reports ${observation.osArch}.`,
    )
  }
  if (observation.translated === true) {
    details.push(
      'Node is running through Rosetta 2 translation rather than natively.',
    )
  }

  // Rosetta: an x64 runtime on an arm64 Mac. Reported either outright or
  // inferred from the architecture pair when the translation flag is missing.
  const rosetta =
    observation.translated === true ||
    (proc === 'x64' && os === 'arm64' && observation.translated !== false)
  if (rosetta) {
    return {
      status: 'warn',
      message: `This Node.js is an ${proc ?? 'x64'} build running on an arm64 machine${
        observation.translated ? ' under Rosetta 2' : ''
      } — native modules and prebuilt Freebuff binaries resolve for the wrong target here.`,
      details,
      fix: 'Install an arm64 build of Node.js (https://nodejs.org/en/download)',
      faqSlug: 'crash-on-start--updating',
    }
  }

  if (proc === 'ia32' && (os === 'x64' || os === 'arm64')) {
    return {
      status: 'warn',
      message: `Node.js is a 32-bit (ia32) runtime on a 64-bit machine, which limits the engine to a small address space and breaks 64-bit prebuilt binaries.`,
      details: [...details, 'A 32-bit heap cannot exceed roughly 4 GB.'],
      fix: 'Install the 64-bit build of Node.js',
      faqSlug: 'crash-on-start--updating',
    }
  }

  if (proc && os && proc !== os) {
    return {
      status: 'fail',
      message: `The running Node.js is an ${proc} build, but this machine is ${os} — the engine cannot execute its own binaries here.`,
      details,
      fix: NATIVE_HINT,
      faqSlug: 'crash-on-start--updating',
    }
  }

  if (!os) {
    return {
      status: 'pass',
      message: `Running a ${proc ?? observation.processArch} build of Node.js (the machine's architecture could not be confirmed).`,
      details,
    }
  }

  return {
    status: 'pass',
    message: `Node.js matches this machine's architecture (${os}).`,
    details,
  }
}

interface MachineArch {
  osArch: string | null
  translated: boolean | null
  source: string
}

/** Asks the operating system what architecture it really is. */
async function detectMachineArch(context: CheckContext): Promise<MachineArch> {
  const timeoutMs = Math.min(Math.max(context.timeoutMs, 2000), 8000)

  // On Windows the PROCESSOR_ARCHITECTURE seen by a 32-bit process is `x86`,
  // with the real machine reported separately in PROCESSOR_ARCHITEW6432.
  if (context.platform === 'win32') {
    const real = context.env.PROCESSOR_ARCHITEW6432?.trim()
    const native = context.env.PROCESSOR_ARCHITECTURE?.trim()
    return {
      osArch: real || native || null,
      translated: null,
      source: 'PROCESSOR_ARCHITECTURE',
    }
  }

  const uname = await exec('uname', ['-m'], { timeoutMs })
  const osArch = uname.ok ? (uname.stdout.trim().split(/\r?\n/)[0] ?? '') : null

  let translated: boolean | null = null
  if (context.platform === 'darwin') {
    const proc = await exec('sysctl', ['-n', 'sysctl.proc_translated'], {
      timeoutMs,
    })
    const value = proc.stdout.trim()
    if (value === '0' || value === '1') translated = value === '1'
  }

  return { osArch: osArch || null, translated, source: 'uname -m' }
}

/** Compares the running Node runtime with the architecture of the machine. */
export const archMatchCheck: DiagnosticCheck = {
  id: 'arch-match',
  title: 'Runtime and machine architecture',
  async run(context) {
    const machine = await detectMachineArch(context)
    const observation: ArchObservation = {
      processArch: context.arch,
      osArch: machine.osArch,
      translated: machine.translated,
    }
    const verdict = classifyArchMatch(observation)

    return found({
      ...verdict,
      data: {
        processArch: context.arch,
        osArch: machine.osArch,
        translated: machine.translated,
        platform: context.platform,
        source: machine.source,
      },
    })
  },
}
