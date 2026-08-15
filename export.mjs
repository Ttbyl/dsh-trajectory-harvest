#!/usr/bin/env node
/**
 * dsh-trajectory-harvest export: download the whole training corpus as one
 * JSONL file from the dsh Web host's /api/train.export endpoint
 * (allSessions=1).
 *
 * Requirements: the dsh Web server must be running and share the same DSH_HOME
 * as the headless runs (so the sessions you created with run.mjs are visible).
 *
 * Usage:
 *   node export.mjs [options]
 *
 * Options:
 *   --base <url>      web host base URL (default http://127.0.0.1:3080)
 *   --out <file>      output file (default training.jsonl)
 *   --no-descendants  do not include subagent descendants
 *
 * The response is streamed directly to the file, so large corpora never load
 * fully into memory.
 */
import { createWriteStream } from 'node:fs'
import { resolve } from 'node:path'
import { pipeline } from 'node:stream/promises'
import { Readable } from 'node:stream'

function parseArgs(argv) {
  const opts = {
    base: 'http://127.0.0.1:3080',
    out: 'training.jsonl',
    includeDescendants: true,
  }
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]
    switch (arg) {
      case '--base':
      case '--out':
        opts[arg.slice(2)] = argv[++i]
        break
      case '--no-descendants':
        opts.includeDescendants = false
        break
      case '-h':
      case '--help':
        process.stderr.write(`Usage: node export.mjs [--base url] [--out file] [--no-descendants]\n`)
        process.exit(0)
        break
      default:
        process.stderr.write(`unknown option: ${arg}\n`)
        process.exit(2)
    }
  }
  return opts
}

async function main() {
  const opts = parseArgs(process.argv.slice(2))
  const url = new URL('/api/train.export', opts.base)
  url.searchParams.set('allSessions', 'true')
  if (opts.includeDescendants) url.searchParams.set('includeDescendants', 'true')

  const response = await fetch(url, { method: 'GET' })
  if (!response.ok) {
    const detail = await response.text().catch(() => '')
    throw new Error(`export failed: HTTP ${response.status}${detail === '' ? '' : ` ${detail}`}`)
  }
  const out = resolve(opts.out)
  await pipeline(Readable.fromWeb(response.body), createWriteStream(out))
  process.stderr.write(`exported ${out} (${url})\n`)
}

main().catch((error) => {
  process.stderr.write(`dsh-trajectory-harvest export failed: ${error instanceof Error ? error.message : String(error)}\n`)
  process.exit(1)
})
