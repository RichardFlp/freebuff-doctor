/** Code point ranges that occupy two terminal columns. */
const WIDE_RANGES: Array<[number, number]> = [
  [0x1100, 0x115f],
  [0x2e80, 0x303e],
  [0x3041, 0x33ff],
  [0x3400, 0x4dbf],
  [0x4e00, 0x9fff],
  [0xa000, 0xa4cf],
  [0xac00, 0xd7a3],
  [0xf900, 0xfaff],
  [0xfe30, 0xfe6f],
  [0xff00, 0xff60],
  [0xffe0, 0xffe6],
  [0x1f000, 0x1f02f],
  [0x1f300, 0x1f64f],
  [0x1f900, 0x1f9ff],
  [0x1fa70, 0x1faff],
  // Misc symbols: renders ⚠ ✅ ❌ ➖ in the emoji-presentation width most
  // terminals use, which is what keeps status columns aligned.
  [0x2600, 0x27bf],
  [0x2b00, 0x2bff],
]

const ZERO_WIDTH = new Set([
  0x200b, 0x200c, 0x200d, 0x200e, 0x200f, 0xfe0e, 0xfe0f, 0xfeff,
])

function charWidth(codePoint: number): number {
  if (codePoint === 0) return 0
  if (codePoint < 32) return 0
  if (ZERO_WIDTH.has(codePoint)) return 0
  // Combining marks attach to the previous cell.
  if (codePoint >= 0x0300 && codePoint <= 0x036f) return 0
  for (const [start, end] of WIDE_RANGES) {
    if (codePoint >= start && codePoint <= end) return 2
  }
  return 1
}

/** Visible column width of a string, ignoring ANSI escape sequences. */
export function stringWidth(value: string): number {
  if (!value) return 0
  // eslint-disable-next-line no-control-regex
  const plain = value.replace(
    /\u001b\[[0-9;]*m|\u001b\]8;;[^\u0007]*\u0007/g,
    '',
  )
  let width = 0
  for (const char of plain) {
    width += charWidth(char.codePointAt(0) ?? 0)
  }
  return width
}

/** Pads to `target` visible columns, leaving longer values untouched. */
export function padTo(
  value: string,
  target: number,
  align: 'left' | 'right' | 'center' = 'left',
): string {
  const filler = Math.max(0, target - stringWidth(value))
  if (align === 'right') return ' '.repeat(filler) + value
  if (align === 'center') {
    const left = Math.floor(filler / 2)
    return ' '.repeat(left) + value + ' '.repeat(filler - left)
  }
  return value + ' '.repeat(filler)
}

/** Shortens text to `max` visible columns, appending an ellipsis when cut. */
export function truncate(value: string, max: number): string {
  if (stringWidth(value) <= max) return value
  let result = ''
  let used = 0
  for (const char of value) {
    const width = charWidth(char.codePointAt(0) ?? 0)
    if (used + width > max - 1) break
    result += char
    used += width
  }
  return `${result}…`
}
