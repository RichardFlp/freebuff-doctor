import type { Colors } from '../ui/theme.js'

/**
 * Renders the inline markdown that appears in FAQ prose: emphasis, inline code
 * and links. Deliberately minimal — it handles what the FAQ actually uses.
 */
export function renderInline(text: string, colors: Colors): string {
  let output = text

  // Links first so their URLs don't get mangled by later passes.
  output = output.replace(
    /\[([^\]]+)\]\(([^)\s]+)\)/g,
    (_match, label: string, url: string) =>
      `${colors.underline(label)} ${colors.dim(`(${url})`)}`,
  )

  // Inline code.
  output = output.replace(/`([^`]+)`/g, (_match, code: string) =>
    colors.cyan(code),
  )

  // Bold / italic.
  output = output.replace(/\*\*([^*]+)\*\*/g, (_match, value: string) =>
    colors.bold(value),
  )
  output = output.replace(/__([^_]+)__/g, (_match, value: string) =>
    colors.bold(value),
  )
  output = output.replace(
    /(^|[\s(])\*([^*\n]+)\*/g,
    (_match, lead: string, value: string) => `${lead}${colors.italic(value)}`,
  )

  // Strikethrough.
  output = output.replace(/~~([^~]+)~~/g, (_match, value: string) =>
    colors.strikethrough(value),
  )

  // Unescape the backslash escapes markdown uses.
  output = output.replace(/\\([\\`*_{}[\]()#+.!|-])/g, '$1')

  return output
}

/** Plain-text version, used when colour is disabled or output is piped. */
export function stripInlineMarkdown(text: string): string {
  return text
    .replace(
      /\[([^\]]+)\]\(([^)\s]+)\)/g,
      (_match, label: string, url: string) => `${label} (${url})`,
    )
    .replace(/`([^`]+)`/g, '$1')
    .replace(/\*\*([^*]+)\*\*/g, '$1')
    .replace(/__([^_]+)__/g, '$1')
    .replace(/~~([^~]+)~~/g, '$1')
    .replace(/\\([\\`*_{}[\]()#+.!|-])/g, '$1')
}
