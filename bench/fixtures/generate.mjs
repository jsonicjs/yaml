// Generate synthetic YAML fixtures that exercise specific hotspots.
// Writes .yaml files into ./fixtures/. Each file targets one hotspot
// so benchmarks can attribute time to a specific code path.
//
// Usage:
//   node bench/fixtures/generate.mjs           # default sizes
//   node bench/fixtures/generate.mjs --scale=2 # 2x sizes

import { writeFileSync, mkdirSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = dirname(fileURLToPath(import.meta.url))
mkdirSync(__dirname, { recursive: true })

const scaleArg = process.argv.find(a => a.startsWith('--scale='))
const SCALE = scaleArg ? Number(scaleArg.split('=')[1]) : 1

// Counts tuned so each fixture parses in roughly 10-200ms on a fast CPU,
// which keeps the full bench run minutes-not-hours while still exposing
// O(n^2) behavior. Bump --scale to stress the hotspots harder.
const N_BLOCK_MAP_KEYS   = Math.round(2000 * SCALE)
const N_BLOCK_SEQ_ITEMS  = Math.round(2000 * SCALE)
const N_LITERAL_LINES    = Math.round(2000 * SCALE)  // block scalar lines
const N_FOLDED_LINES     = Math.round(2000 * SCALE)
const N_PLAIN_CONT_LINES = Math.round( 500 * SCALE)
const N_FLOW_ITEMS       = Math.round(2000 * SCALE)
const N_ANCHOR_REFS      = Math.round( 500 * SCALE)
const N_DQ_STRINGS       = Math.round(1000 * SCALE)
const NESTED_DEPTH       = Math.round(  40 * SCALE)
const N_MIXED_USERS      = Math.round( 200 * SCALE)

function fixture(name, body) {
  const path = join(__dirname, name + '.yaml')
  writeFileSync(path, body)
  return { path, bytes: Buffer.byteLength(body) }
}

// ---------- 1. Wide block mapping ----------
// Exercises: indent tokens, flow-depth rescan per plain scalar,
//            plain scalar scanner, map assembly.
{
  const lines = []
  for (let i = 0; i < N_BLOCK_MAP_KEYS; i++) {
    lines.push(`key_${i}: value number ${i}`)
  }
  fixture('block_map_wide', lines.join('\n') + '\n')
}

// ---------- 2. Long block sequence ----------
{
  const lines = []
  for (let i = 0; i < N_BLOCK_SEQ_ITEMS; i++) {
    lines.push(`- item ${i}`)
  }
  fixture('block_seq_long', lines.join('\n') + '\n')
}

// ---------- 3. Deeply nested mappings ----------
// Exercises recursion and indent handling.
{
  let body = ''
  for (let d = 0; d < NESTED_DEPTH; d++) body += '  '.repeat(d) + `level${d}:\n`
  body += '  '.repeat(NESTED_DEPTH) + 'leaf: done\n'
  fixture('nested_map_deep', body)
}

// ---------- 4. Long literal block scalar (|) ----------
// Exercises: handleBlockScalar, lines collection, chomping.
{
  const body = 'content: |\n' +
    Array.from({ length: N_LITERAL_LINES },
               (_, i) => `  line ${i} with some trailing content ${i * 13}`).join('\n') +
    '\n'
  fixture('literal_block_long', body)
}

// ---------- 5. Long folded block scalar (>) ----------
// Exercises the *fold* path (foldLines in Go, inline in TS) —
// this is a flagged string-concatenation hotspot in TS.
{
  const parts = []
  for (let i = 0; i < N_FOLDED_LINES; i++) {
    // Mix normal, empty, and more-indented lines so all branches run.
    if (i % 17 === 0) parts.push('')
    else if (i % 23 === 0) parts.push('    more indented line ' + i)
    else parts.push(`word${i} more words for line ${i}`)
  }
  const body = 'content: >\n' + parts.map(l => l ? '  ' + l : '').join('\n') + '\n'
  fixture('folded_block_long', body)
}

// ---------- 6. Long multiline plain scalar ----------
// Exercises continuation-line detection and plain scalar scanner.
{
  const lines = []
  lines.push('paragraph:')
  for (let i = 0; i < N_PLAIN_CONT_LINES; i++) {
    lines.push('  continuation word token ' + i)
  }
  fixture('plain_multiline_long', lines.join('\n') + '\n')
}

// ---------- 7. Large flow mapping ----------
// Exercises preprocessFlowCollections in TS (major up-front cost).
{
  const entries = []
  for (let i = 0; i < N_FLOW_ITEMS; i++) entries.push(`k${i}: v${i}`)
  fixture('flow_map_large', 'doc: {' + entries.join(', ') + '}\n')
}

// ---------- 8. Large flow sequence ----------
{
  const items = []
  for (let i = 0; i < N_FLOW_ITEMS; i++) items.push('item' + i)
  fixture('flow_seq_large', 'doc: [' + items.join(', ') + ']\n')
}

// ---------- 9. Anchors and aliases (heavy deepCopy) ----------
// Each alias triggers JSON.parse(JSON.stringify(...)) in TS and
// json.Marshal/Unmarshal-based deepCopy in Go.
{
  const lines = []
  lines.push('anchors:')
  lines.push('  base: &base')
  for (let i = 0; i < 50; i++) lines.push(`    k${i}: v${i}`)
  lines.push('refs:')
  for (let i = 0; i < N_ANCHOR_REFS; i++) {
    lines.push(`  - *base`)
  }
  fixture('anchor_alias_heavy', lines.join('\n') + '\n')
}

// ---------- 10. Many double-quoted strings with escapes ----------
{
  const lines = []
  for (let i = 0; i < N_DQ_STRINGS; i++) {
    lines.push(`k${i}: "hello \\"world\\" line${i}\\n\\ttab"`)
  }
  fixture('dq_strings_escaped', lines.join('\n') + '\n')
}

// ---------- 11. Realistic mixed document ----------
{
  const parts = []
  parts.push('meta:')
  parts.push('  title: Benchmark Fixture')
  parts.push('  generated: "2026-04-21"')
  parts.push('users:')
  for (let i = 0; i < N_MIXED_USERS; i++) {
    parts.push(`  - id: ${i}`)
    parts.push(`    name: User ${i}`)
    parts.push(`    email: user${i}@example.com`)
    parts.push(`    tags: [a, b, c, d]`)
    parts.push(`    bio: |`)
    parts.push(`      Short bio line 1 for user ${i}.`)
    parts.push(`      Short bio line 2 for user ${i}.`)
  }
  fixture('mixed_realistic', parts.join('\n') + '\n')
}

console.log('Generated fixtures in', __dirname)
