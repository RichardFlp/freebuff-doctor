import {
  c,
  colorEnabled,
  plainColors,
  terminalWidth,
  type Colors,
} from '../ui/theme.js'
import { renderInline, stripInlineMarkdown } from '../util/markdown-inline.js'
import { renderMarkdown, wrap } from '../util/markdown.js'
import { stringWidth } from '../util/width.js'

export interface AnswerRendererOptions {
  /** Visible columns to wrap prose to. Defaults to the terminal width. */
  width?: number
  /** Palette to style with; defaults to the process palette. */
  colors?: Colors
  /** Force styling on or off. Defaults to the terminal's own support. */
  color?: boolean
  /** Prefix every rendered line, e.g. to nest the answer under a heading. */
  indent?: string
}

const FENCE = /^\s*(```|~~~)/
const RULE = /^\s*([-*_])\1{2,}\s*$/
const HEADING = /^(#{1,6})\s+(.*)$/
const BULLET = /^(\s*)[-*+]\s+(.*)$/
const ORDERED = /^(\s*)(\d+)[.)]\s+(.*)$/
// A table row opens with a pipe; the separator row underneath is what makes
// the block a table rather than prose that happens to contain pipes.
const TABLE_ROW = /^\s*\|/
const TABLE_SEPARATOR = /^\s*\|[\s:|-]+\|\s*$/

/**
 * Styles the assistant's markdown *while it streams*.
 *
 * A streamed chunk can split anywhere — mid-word, mid-emphasis, or between a
 * fence marker and its contents — so nothing can be rendered until the line it
 * belongs to is complete. This buffers the partial line, styles each finished
 * one the way the FAQ does, and remembers whether it is inside a fenced block so
 * code is passed through verbatim.
 *
 * A table is the one block that needs more than a line: its columns cannot be
 * sized until the last row is in, so pipe rows are held back and handed to the
 * FAQ's own table renderer when the block ends (or the stream does). A run of
 * pipes with no separator row is not a table, and is printed as prose.
 *
 * With colour unavailable the markers are stripped rather than printed, so a
 * piped answer stays readable.
 */
export class AnswerRenderer {
  readonly #color: boolean
  readonly #colors: Colors
  readonly #width: number
  readonly #indent: string

  #buffer = ''
  #inFence = false
  #wroteContent = false
  #pendingBlank = false
  #table: string[] = []

  constructor(options: AnswerRendererOptions = {}) {
    this.#color = options.color ?? colorEnabled()
    this.#colors = options.colors ?? c()
    this.#width = options.width ?? terminalWidth()
    this.#indent = options.indent ?? ''
  }

  /** True while a fenced code block is open. */
  get inFence(): boolean {
    return this.#inFence
  }

  /** Takes one fragment of the stream and returns the lines ready to print. */
  push(fragment: string): string[] {
    this.#buffer += fragment
    const parts = this.#buffer.split('\n')
    this.#buffer = parts.pop() ?? ''
    return this.#emit(parts.flatMap((line) => this.#renderLine(line)))
  }

  /** Renders whatever is left when the stream ends without a final newline. */
  flush(): string[] {
    const rest = this.#buffer
    this.#buffer = ''
    if (rest.trim() === '') return this.#emit(this.#takeTable())
    // The last line may itself be another row of an open table, so it is fed
    // through first — and a table still open after that is rendered too: the
    // block ended because the stream did, not because a blank line arrived.
    const lines = this.#renderLine(rest)
    return this.#emit([...lines, ...this.#takeTable()])
  }

  #renderLine(line: string): string[] {
    // While a table is open, only more pipe rows extend it. Anything else ends
    // the block — and a blank line ends it too, which is where the reader's
    // hard-won spacing comes from.
    if (this.#table.length > 0 && !TABLE_ROW.test(line)) {
      return [...this.#takeTable(), ...this.#renderLine(line)]
    }

    // A fence marker is structural: it is never printed, only tracked.
    if (FENCE.test(line)) {
      this.#inFence = !this.#inFence
      return ['']
    }

    if (this.#inFence) {
      // Blank lines inside code stay blank rather than printing indentation.
      return line.trim() === '' ? [''] : [`${this.#indent}  ${line}`]
    }

    if (line.trim() === '') return ['']

    // Pipe rows are buffered whole: the renderer below sizes the columns from
    // every row at once, so nothing can be printed until the block is done.
    if (TABLE_ROW.test(line)) {
      this.#table.push(line)
      return []
    }

    if (RULE.test(line)) {
      return this.#color ? [this.#dim('─'.repeat(this.#ruleWidth()))] : []
    }

    const heading = HEADING.exec(line)
    if (heading) {
      const text = this.#inline(heading[2] ?? '')
      if (!this.#color) return [`${this.#indent}${text}`]
      return [
        `${this.#indent}${this.#colors.bold(text)}`,
        `${this.#indent}${this.#dim(
          '─'.repeat(Math.min(stringWidth(text) + 2, this.#ruleWidth())),
        )}`,
      ]
    }

    // Lists keep their original numbers and bullets where that matters, but
    // wrap with a hanging indent so continuation lines line up under the text.
    const ordered = ORDERED.exec(line)
    if (ordered) {
      const marker = `${ordered[2]}. `
      return this.#hang(this.#inline(ordered[3] ?? ''), this.#dim(marker))
    }

    const bullet = BULLET.exec(line)
    if (bullet) {
      const depth = Math.floor((bullet[1] ?? '').length / 2)
      // Styled output redraws the marker; a piped one keeps the original so it
      // can still be pasted.
      return this.#hang(
        this.#inline(bullet[2] ?? ''),
        this.#color ? `${this.#dim('•')} ` : '- ',
        depth * 2,
      )
    }

    return this.#wrapProse(line)
  }

  /**
   * Renders the buffered pipe rows and clears the buffer. A real table (one
   * with the separator row markdown requires) goes through the FAQ's table
   * renderer so the columns line up exactly as they do there; anything else is
   * prose that happened to start with a pipe, and is printed as such.
   */
  #takeTable(): string[] {
    const rows = this.#table
    this.#table = []
    if (rows.length < 2 || !TABLE_SEPARATOR.test(rows[1] ?? '')) {
      return rows.flatMap((row) => this.#wrapProse(row))
    }
    return renderMarkdown(rows.join('\n'), {
      colors: this.#color ? this.#colors : plainColors(),
      width: this.#width,
      indent: this.#indent,
    })
  }

  /** Wraps list text so every continuation line is indented under the marker. */
  #hang(text: string, marker: string, extraIndent = 0): string[] {
    const lead = `${this.#indent}${' '.repeat(extraIndent)}`
    const width = this.#width - stringWidth(lead) - stringWidth(marker)
    return wrap(text, width).map(
      (part, index) =>
        `${lead}${index === 0 ? marker : ' '.repeat(stringWidth(marker))}${part}`,
    )
  }

  /** Prose: markdown's own hard-break spaces are not worth printing. */
  #wrapProse(line: string): string[] {
    const text = this.#inline(line.replace(/\s+$/, ''))
    return wrap(text, this.#width - stringWidth(this.#indent)).map(
      (wrapped) => `${this.#indent}${wrapped}`,
    )
  }

  /**
   * Turns a block into printable lines: no leading blank, one blank between
   * blocks, and no trailing blank — a blank line is held back until there is
   * something after it, because this may be the last output of the stream.
   */
  #emit(lines: string[]): string[] {
    const out: string[] = []
    for (const line of lines) {
      if (line === '') {
        if (this.#wroteContent) this.#pendingBlank = true
        continue
      }
      if (this.#pendingBlank) {
        out.push('')
        this.#pendingBlank = false
      }
      this.#wroteContent = true
      out.push(line)
    }
    return out
  }

  #ruleWidth(): number {
    return Math.max(20, Math.min(this.#width, 60))
  }

  #inline(text: string): string {
    return this.#color
      ? renderInline(text, this.#colors)
      : stripInlineMarkdown(text)
  }

  #dim(text: string): string {
    return this.#colors.dim(text)
  }
}

/** Renders a whole answer at once. Equivalent to feeding it through in one go. */
export function renderAnswer(
  markdown: string,
  options: AnswerRendererOptions = {},
): string[] {
  const renderer = new AnswerRenderer(options)
  return [...renderer.push(markdown), ...renderer.flush()]
}
