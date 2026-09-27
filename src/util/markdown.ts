import { c, colorEnabled, type Colors } from '../ui/theme.js'
import { renderInline, stripInlineMarkdown } from './markdown-inline.js'
import { padTo, stringWidth, truncate } from './width.js'

export interface RenderMarkdownOptions {
  colors?: Colors
  /** Available visible columns, used to wrap prose and size tables. */
  width?: number
  indent?: string
}

interface TableBlock {
  header: string[]
  rows: string[][]
  aligns: Array<'left' | 'right' | 'center'>
}

/**
 * Renders the subset of markdown the FAQ uses — headings, lists, tables, fenced
 * code and blockquotes — as terminal-friendly lines.
 */
export function renderMarkdown(
  markdown: string,
  options: RenderMarkdownOptions = {},
): string[] {
  const colors = options.colors ?? c()
  const width = options.width ?? 88
  const indent = options.indent ?? ''
  const lines = markdown.replace(/\r\n/g, '\n').split('\n')
  const out: string[] = []

  // Collapse runaway blank lines but keep single ones for rhythm.
  const blank = (): void => {
    if (out.length > 0 && out[out.length - 1] !== '') out.push('')
  }

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index] ?? ''

    if (line.trim() === '') {
      blank()
      continue
    }

    // Fenced code.
    const fence = /^\s*(```|~~~)/.exec(line)
    if (fence) {
      const marker = fence[1] ?? '```'
      const body: string[] = []
      index += 1
      while (
        index < lines.length &&
        !(lines[index] ?? '').trimStart().startsWith(marker)
      ) {
        body.push(lines[index] ?? '')
        index += 1
      }
      for (const code of body) {
        out.push(`${indent}${colors.dim(`  ${code}`)}`)
      }
      blank()
      continue
    }

    // Horizontal rule.
    if (/^\s*([-*_])\1{2,}\s*$/.test(line)) {
      out.push('')
      continue
    }

    // Table: a header row followed by a separator row.
    const next = lines[index + 1] ?? ''
    if (/^\s*\|.*\|\s*$/.test(line) && /^\s*\|[\s:|-]+\|\s*$/.test(next)) {
      const block: TableBlock = {
        header: splitRow(line),
        rows: [],
        aligns: splitRow(next).map((cell) => {
          const trimmed = cell.trim()
          if (trimmed.startsWith(':') && trimmed.endsWith(':')) return 'center'
          if (trimmed.endsWith(':')) return 'right'
          return 'left'
        }),
      }
      index += 2
      while (
        index < lines.length &&
        /^\s*\|.*\|\s*$/.test(lines[index] ?? '')
      ) {
        block.rows.push(splitRow(lines[index] ?? ''))
        index += 1
      }
      index -= 1
      out.push(...renderTable(block, colors, width, indent))
      blank()
      continue
    }

    // Blockquote.
    const quote = /^\s*>\s?(.*)$/.exec(line)
    if (quote) {
      const text = renderInline(quote[1] ?? '', colors)
      for (const wrapped of wrap(text, width - stringWidth(indent) - 2)) {
        out.push(`${indent}${colors.dim('│')} ${colors.dim(wrapped)}`)
      }
      continue
    }

    // Headings.
    const heading = /^(#{1,6})\s+(.*)$/.exec(line)
    if (heading) {
      const level = (heading[1] ?? '#').length
      const text = renderInline(heading[2] ?? '', colors)
      if (level <= 2) {
        if (out.length > 0 && out[out.length - 1] !== '') out.push('')
        out.push(`${indent}${colors.bold(text)}`)
        out.push(
          `${indent}${colors.dim('─'.repeat(Math.min(stringWidth(text) + 2, width - 2)))}`,
        )
      } else {
        out.push(`${indent}${colors.bold(text)}`)
      }
      continue
    }

    // Unordered list items, including nested indentation.
    const bullet = /^(\s*)([-*+])\s+(.*)$/.exec(line)
    if (bullet) {
      const depth = Math.floor((bullet[1] ?? '').length / 2)
      const text = renderInline(bullet[3] ?? '', colors)
      const prefix = `${'  '.repeat(depth)}${colors.dim('•')} `
      for (const [i, wrapped] of wrap(text, width - 2 - depth * 2).entries()) {
        out.push(
          `${indent}${i === 0 ? prefix : ' '.repeat(depth * 2 + 2)}${wrapped}`,
        )
      }
      continue
    }

    // Ordered list items are kept verbatim, they read better with real numbers.
    const ordered = /^(\s*)(\d+)[.)]\s+(.*)$/.exec(line)
    if (ordered) {
      const depth = Math.floor((ordered[1] ?? '').length / 2)
      const marker = `${ordered[2]}. `
      const text = renderInline(ordered[3] ?? '', colors)
      for (const [i, wrapped] of wrap(text, width - 2 - depth * 2).entries()) {
        out.push(
          `${indent}${i === 0 ? ' '.repeat(depth * 2) + colors.dim(marker) : ' '.repeat(depth * 2 + marker.length)}${wrapped}`,
        )
      }
      continue
    }

    for (const wrapped of wrap(
      renderInline(line, colors),
      width - stringWidth(indent),
    )) {
      out.push(`${indent}${wrapped}`)
    }
  }

  while (out.length > 0 && out[out.length - 1] === '') out.pop()
  return out
}

/** Plain-text rendering for pipes, CI and `NO_COLOR`. */
export function renderMarkdownPlain(markdown: string, width = 88): string[] {
  const lines = markdown.replace(/\r\n/g, '\n').split('\n')
  const out: string[] = []
  let inFence = false

  for (const line of lines) {
    if (/^\s*(```|~~~)/.test(line)) {
      inFence = !inFence
      continue
    }
    if (inFence) {
      out.push(`  ${line}`)
      continue
    }
    const heading = /^#{1,6}\s+(.*)$/.exec(line)
    if (heading) {
      if (out.length > 0 && out[out.length - 1] !== '') out.push('')
      out.push(stripInlineMarkdown(heading[1] ?? ''))
      continue
    }
    if (line.trim() === '') {
      if (out.length > 0 && out[out.length - 1] !== '') out.push('')
      continue
    }
    if (/^\s*([-*_])\1{2,}\s*$/.test(line)) continue
    out.push(stripInlineMarkdown(line))
  }

  while (out.length > 0 && out[out.length - 1] === '') out.pop()
  return out
}

function splitRow(line: string): string[] {
  return line
    .replace(/^\s*\|/, '')
    .replace(/\|\s*$/, '')
    .split('|')
    .map((cell) => cell.trim())
}

function renderTable(
  block: TableBlock,
  colors: Colors,
  width: number,
  indent: string,
): string[] {
  const columns = Math.max(
    block.header.length,
    ...block.rows.map((row) => row.length),
  )
  const widths: number[] = []
  for (let column = 0; column < columns; column += 1) {
    const cells = [
      block.header[column] ?? '',
      ...block.rows.map((row) => row[column] ?? ''),
    ]
    const longest = Math.max(
      ...cells.map((cell) => stringWidth(stripInlineMarkdown(cell))),
    )
    widths.push(Math.max(3, longest))
  }

  // Tables in the FAQ can be wider than the terminal; shrink the widest column.
  const available = width - stringWidth(indent) - (columns * 3 + 1)
  const total = widths.reduce((sum, value) => sum + value, 0)
  if (total > available && available > columns * 3) {
    let overflow = total - available
    while (overflow > 0) {
      const widest = widths.indexOf(Math.max(...widths))
      if ((widths[widest] ?? 0) <= 6) break
      widths[widest] = (widths[widest] ?? 0) - 1
      overflow -= 1
    }
  }

  const out: string[] = []
  const header = block.header
    .map((cell, i) =>
      padTo(
        colors.bold(truncate(stripInlineMarkdown(cell), widths[i] ?? 0)),
        widths[i] ?? 0,
      ),
    )
    .join(colors.dim(' │ '))
  out.push(`${indent}${header}`)
  out.push(
    `${indent}${widths.map((value) => colors.dim('─'.repeat(value))).join(colors.dim('─┼─'))}`,
  )
  for (const row of block.rows) {
    const rendered = []
    for (let i = 0; i < columns; i += 1) {
      const cell = renderInline(row[i] ?? '', colors)
      rendered.push(
        padTo(
          truncate(cell, widths[i] ?? 0),
          widths[i] ?? 0,
          block.aligns[i] ?? 'left',
        ),
      )
    }
    out.push(`${indent}${rendered.join(colors.dim(' │ '))}`)
  }
  return out
}

/**
 * Greedy word wrap that understands ANSI escapes and CJK/emoji widths.
 * Lines that already fit are returned untouched.
 */
export function wrap(text: string, width: number): string[] {
  const limit = Math.max(20, width)
  if (stringWidth(text) <= limit) return [text]

  const result: string[] = []
  let current = ''
  for (const word of text.split(' ')) {
    const candidate = current === '' ? word : `${current} ${word}`
    if (stringWidth(candidate) > limit && current !== '') {
      result.push(current)
      current = word
    } else {
      current = candidate
    }
  }
  if (current !== '') result.push(current)
  return result
}
