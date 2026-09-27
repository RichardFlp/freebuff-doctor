// Guarantees the compiled entry point is runnable as a `bin` script.
// tsc preserves a leading shebang, but we repair it if it ever goes missing.
import { chmodSync, readFileSync, writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const entry = join(root, 'dist', 'cli.js')
const shebang = '#!/usr/bin/env node\n'

const source = readFileSync(entry, 'utf8')
if (!source.startsWith('#!')) {
  writeFileSync(entry, shebang + source)
}

try {
  chmodSync(entry, 0o755)
} catch {
  // Windows and some filesystems have no executable bit; npm handles this itself.
}
