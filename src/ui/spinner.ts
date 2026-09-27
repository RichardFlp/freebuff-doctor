import { isInteractive } from './theme.js'

/** Handle used to narrate long-running work. */
export interface ProgressReporter {
  /** Replaces the spinner label. */
  text(value: string): void
  succeed(value?: string): void
  fail(value?: string): void
  stop(): void
}

export interface SpinnerOptions {
  /** How long a task may run before the spinner appears. */
  delayMs?: number
  stream?: NodeJS.WriteStream
}

const NOOP: ProgressReporter = {
  text: () => {},
  succeed: () => {},
  fail: () => {},
  stop: () => {},
}

/**
 * Runs `task` with a spinner that only materialises after `delayMs` (300 ms by
 * default), so quick checks never flash. When output is piped, in CI, or behind
 * `NO_COLOR`, nothing is drawn at all and the caller's own output is the report.
 */
export async function withSpinner<T>(
  label: string,
  task: (reporter: ProgressReporter) => Promise<T>,
  options: SpinnerOptions = {},
): Promise<T> {
  const stream = options.stream ?? process.stderr
  if (!isInteractive(stream)) {
    return task(NOOP)
  }

  // Imported lazily: the spinner module is never loaded for a fast, piped run.
  const { default: ora } = await import('ora')
  const spinner = ora({
    text: label,
    color: 'cyan',
    spinner: 'dots',
    stream,
    // Raw stdin would fight with the interactive prompts.
    discardStdin: false,
  })

  let started = false
  let pending = label
  const timer = setTimeout(() => {
    started = true
    spinner.text = pending
    spinner.start()
  }, options.delayMs ?? 300)
  timer.unref?.()

  const stopTimer = (): void => clearTimeout(timer)

  const reporter: ProgressReporter = {
    text: (value) => {
      pending = value
      if (started) spinner.text = value
    },
    succeed: (value) => {
      stopTimer()
      const text = value ?? pending
      if (started) spinner.succeed(text)
      else if (value) stream.write(`${text}\n`)
    },
    fail: (value) => {
      stopTimer()
      const text = value ?? pending
      if (started) spinner.fail(text)
      else if (value) stream.write(`${text}\n`)
    },
    stop: () => {
      stopTimer()
      if (started) spinner.stop()
    },
  }

  try {
    return await task(reporter)
  } finally {
    stopTimer()
    if (started) spinner.stop()
  }
}
