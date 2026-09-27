/**
 * Thin wrappers over `@inquirer/prompts` that load lazily, so a non-interactive
 * `fbdoc check` never pays for the prompt library, and so a cancelled prompt
 * (Ctrl+C / Esc) becomes `null` instead of a thrown error.
 */

export class CancelledError extends Error {
  constructor() {
    super('Cancelled')
    this.name = 'CancelledError'
  }
}

function isCancellation(error: unknown): boolean {
  return (
    error instanceof Error &&
    (error.name === 'ExitPromptError' || error.name === 'AbortPromptError')
  )
}

export interface Choice<T> {
  name: string
  value: T
  description?: string
  short?: string
}

export interface ChooseOptions<T> {
  message: string
  choices: Array<Choice<T>>
  default?: T
  pageSize?: number
}

/** Single-choice list with arrow-key navigation. */
export async function choose<T>(options: ChooseOptions<T>): Promise<T | null> {
  const { select } = await import('@inquirer/prompts')
  try {
    return await select<T>({
      message: options.message,
      choices: options.choices,
      pageSize: options.pageSize ?? 12,
      ...(options.default !== undefined ? { default: options.default } : {}),
    })
  } catch (error) {
    if (isCancellation(error)) return null
    throw error
  }
}

/** Free-text input. */
export async function ask(options: {
  message: string
  default?: string
}): Promise<string | null> {
  const { input } = await import('@inquirer/prompts')
  try {
    return await input({ message: options.message, default: options.default })
  } catch (error) {
    if (isCancellation(error)) return null
    throw error
  }
}

/** Yes/no prompt. */
export async function confirm(options: {
  message: string
  default?: boolean
}): Promise<boolean | null> {
  const { confirm: prompt } = await import('@inquirer/prompts')
  try {
    return await prompt({
      message: options.message,
      default: options.default ?? true,
    })
  } catch (error) {
    if (isCancellation(error)) return null
    throw error
  }
}

export { isCancellation }
