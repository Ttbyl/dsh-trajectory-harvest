#!/usr/bin/env node
/**
 * dsh-trajectory-harvest offline export: read the dsh session store directly
 * and fold every top-level session into one training JSONL — no dsh Web server
 * and no headless process required.
 *
 * It mounts the harness's own persistence + session-query services against
 * $DSH_HOME/sessions and reuses the exact same surface fold the Web export
 * uses (collectAllTrainSessionRecords), so the output is byte-identical in
 * format to /api/train.export?allSessions=1.
 *
 * Usage:
 *   node export-offline.mjs --harness <harness-repo> [--dsh-home <dir>] [--out <file>] [--no-descendants]
 *
 * Options:
 *   --harness <dir>     deepseek-harness repository root (reads its compiled
 *                       lib artifacts; required)
 *   --dsh-home <dir>    dsh home (default: $DSH_HOME or ~/.dsh); sessions are
 *                       read from <dsh-home>/sessions
 *   --out <file>        output file (default training.jsonl)
 *   --no-descendants    do not include subagent descendants
 *
 * Note: for a consistent snapshot, do not run this while a dsh process is
 * actively writing sessions.
 */
import { writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

function parseArgs(argv) {
  const opts = {
    harness: null,
    dshHome: process.env.DSH_HOME ?? join(homedir(), '.dsh'),
    out: 'training.jsonl',
    includeDescendants: true,
  }
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]
    if (arg === '--harness') opts.harness = argv[++i]
    else if (arg === '--dsh-home') opts.dshHome = argv[++i]
    else if (arg === '--out') opts.out = argv[++i]
    else if (arg === '--no-descendants') opts.includeDescendants = false
    else if (arg === '-h' || arg === '--help') {
      process.stderr.write('Usage: node export-offline.mjs --harness <harness-repo> [--dsh-home <dir>] [--out <file>] [--no-descendants]\n')
      process.exit(0)
    } else {
      process.stderr.write(`unknown option: ${arg}\n`)
      process.exit(2)
    }
  }
  if (opts.harness === null) {
    process.stderr.write('--harness <deepseek-harness repo root> is required\n')
    process.exit(2)
  }
  return opts
}

async function main() {
  const opts = parseArgs(process.argv.slice(2))
  const harness = resolve(opts.harness)

  const { Context } = await import(pathToFileURL(join(harness, 'vendor/cordis/lib/index.js')))
  const { default: SessionStore } = await import(pathToFileURL(join(harness, 'packages/core/session/lib/index.js')))
  const { default: JsonlSessionPersistence } = await import(pathToFileURL(join(harness, 'packages/session/session-persistence-jsonl/lib/index.js')))
  const { default: SqliteSessionQueryEngine } = await import(pathToFileURL(join(harness, 'packages/session-query/session-query-sqlite/lib/index.js')))
  const { collectAllTrainSessionRecords } = await import(pathToFileURL(join(harness, 'packages/host/apiproxy/lib/types/train-export.js')))

  const sessionsRoot = join(resolve(opts.dshHome), 'sessions')
  const ctx = new Context()
  await ctx.plugin(SessionStore)
  await ctx.plugin(JsonlSessionPersistence, { root: sessionsRoot })
  // openAt 'never' keeps exact reads/titles/lineage available without opening
  // any search index; the corpus reads the jsonl artifacts directly.
  await ctx.plugin(SqliteSessionQueryEngine, { path: ':memory:', openAt: 'never' })

  const lines = []
  for await (const record of collectAllTrainSessionRecords(ctx.sessionQuery, undefined, opts.includeDescendants === false)) {
    lines.push(JSON.stringify(record))
  }
  await writeFile(resolve(opts.out), lines.join('\n') + (lines.length > 0 ? '\n' : ''), 'utf8')
  await ctx.fiber.dispose()
  process.stderr.write(`offline export: read ${sessionsRoot} -> ${opts.out} (${lines.length} sessions)\n`)
}

main().catch((error) => {
  process.stderr.write(`dsh-trajectory-harvest offline export failed: ${error instanceof Error ? error.message : String(error)}\n`)
  process.exit(1)
})
