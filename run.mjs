#!/usr/bin/env node
/**
 * llm-trajectory-harvest: run one JSONL of questions through dsh headless
 * mode and write a manifest mapping each question id to its session id.
 *
 * questions file format (JSONL, one object per line):
 *   {"id": "q-001", "prompt": "explain X"}
 *
 * Usage:
 *   node run.mjs questions.jsonl [options]
 *
 * Options:
 *   --concurrency <n>   how many dsh processes may run at once (default 1;
 *                       keep small to avoid provider rate limits)
 *   --dsh-cmd <cmd>     the dsh command (default "dsh"; leading args allowed,
 *                       e.g. on Windows from harness sources:
 *                       "node --import tsx/esm apps/cli/src/bin.ts"; env DSH_CMD)
 *   --cwd <dir>         working directory for each dsh process (default: this
 *                       directory)
 *   --timeout <min>     per-question timeout in minutes (default 30)
 *   --manifest <file>   output manifest path (default manifest.jsonl)
 *   --keep-failures     also write failed runs to the manifest
 *   --session-prefix    id prefix for sessions (default "batch")
 *
 * Outputs manifest.jsonl:
 *   {"id":"q-001","session":"batch-q-001","status":"ok","exitCode":0,
 *    "elapsedMs":12345,"answer":"final assistant text"}
 * The session id equals DSH_HEADLESS_SESSION_ID, so you can later export
 * training data per question via /api/train.export?sessionId=batch-q-001, or
 * the whole corpus via /api/train.export?allSessions=1.
 */
import { spawn } from 'node:child_process'
import { readFile, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'

function usage() {
  process.stderr.write(`Usage: node run.mjs questions.jsonl [--concurrency n] [--dsh-cmd cmd] [--timeout min] [--manifest file] [--keep-failures]
`)
}

function parseArgs(argv) {
  const opts = {
    concurrency: 1,
    dshCmd: process.env.DSH_CMD ?? 'dsh',
    cwd: process.cwd(),
    timeoutMin: 30,
    manifest: 'manifest.jsonl',
    keepFailures: false,
    sessionPrefix: 'batch',
  }
  const aliases = {
    '--concurrency': 'concurrency',
    '--dsh-cmd': 'dshCmd',
    '--cwd': 'cwd',
    '--timeout': 'timeoutMin',
    '--manifest': 'manifest',
    '--session-prefix': 'sessionPrefix',
  }
  const positional = []
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]
    const key = aliases[arg]
    if (key !== undefined) {
      opts[key] = argv[++i]
    } else if (arg === '--keep-failures') {
      opts.keepFailures = true
    } else if (arg === '-h' || arg === '--help') {
      usage()
      process.exit(0)
    } else {
      positional.push(arg)
    }
  }
  if (positional.length !== 1) {
    usage()
    process.exit(2)
  }
  opts.questionsFile = resolve(positional[0])
  opts.concurrency = Number(opts.concurrency)
  opts.timeoutMin = Number(opts.timeoutMin)
  if (!Number.isInteger(opts.concurrency) || opts.concurrency < 1) {
    process.stderr.write('--concurrency must be a positive integer\n')
    process.exit(2)
  }
  return opts
}

async function loadQuestions(file) {
  const text = await readFile(file, 'utf8')
  const questions = []
  for (const line of text.split(/\r?\n/)) {
    if (line.trim() === '') continue
    const parsed = JSON.parse(line)
    if (typeof parsed !== 'object' || parsed === null
      || typeof parsed.id !== 'string' || typeof parsed.prompt !== 'string') {
      throw new Error(`bad question line: ${line}`)
    }
    questions.push({ id: parsed.id, prompt: parsed.prompt })
  }
  return questions
}

function sessionIdFor(prefix, id) {
  // Session ids must survive the batch mapping; keep them filesystem/db-safe.
  const safe = String(id).replace(/[^A-Za-z0-9_-]/g, '_')
  return `${prefix}-${safe}`
}

function runOne(question, opts) {
  return new Promise((resolvePromise) => {
    const sessionId = sessionIdFor(opts.sessionPrefix, question.id)
    const startedAt = Date.now()
    // The dsh command may carry leading arguments, e.g. on Windows with the
    // harness sources: "node --import tsx/esm apps/cli/src/bin.ts".
    const [program, ...prefixArgs] = opts.dshCmd.trim().split(/\s+/)
    const child = spawn(program, [...prefixArgs, '--profile', 'headless', question.prompt], {
      cwd: opts.cwd,
      // DSH_HEADLESS_SESSION_ID (not DSH_SESSION_ID, which the harness shell
      // env injects into every child process of a live session) pins the
      // session id so the question→session mapping survives the run.
      env: { ...process.env, DSH_HEADLESS_SESSION_ID: sessionId },
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    })
    let stdout = ''
    let stderr = ''
    const timer = setTimeout(() => {
      child.kill()
    }, opts.timeoutMin * 60_000)
    child.stdout.on('data', (chunk) => { stdout += chunk })
    child.stderr.on('data', (chunk) => { stderr += chunk })
    child.on('error', (error) => {
      clearTimeout(timer)
      resolvePromise({
        id: question.id, session: sessionId, status: 'error',
        exitCode: null, elapsedMs: Date.now() - startedAt,
        answer: '', error: error.message,
      })
    })
    child.on('close', (code) => {
      clearTimeout(timer)
      const timedOut = code === null
      resolvePromise({
        id: question.id, session: sessionId,
        status: code === 0 ? 'ok' : timedOut ? 'timeout' : 'error',
        exitCode: code,
        elapsedMs: Date.now() - startedAt,
        answer: stdout.trim(),
        ...(stderr.trim() === '' ? {} : { stderr: stderr.trim() }),
      })
    })
  })
}

/** Run questions with a bounded worker pool. */
async function runAll(questions, opts) {
  const results = []
  let cursor = 0
  const workers = Array.from({ length: Math.min(opts.concurrency, questions.length) }, async () => {
    while (cursor < questions.length) {
      const index = cursor++
      const question = questions[index]
      const sessionId = sessionIdFor(opts.sessionPrefix, question.id)
      process.stderr.write(`[${index + 1}/${questions.length}] ${question.id} -> ${sessionId}\n`)
      const result = await runOne(question, opts)
      process.stderr.write(`  ${result.status} (${result.elapsedMs}ms)\n`)
      results.push(result)
    }
  })
  await Promise.all(workers)
  return results
}

async function main() {
  const opts = parseArgs(process.argv.slice(2))
  const questions = await loadQuestions(opts.questionsFile)
  if (questions.length === 0) {
    process.stderr.write('no questions found\n')
    process.exit(2)
  }
  const results = await runAll(questions, opts)
  const keep = opts.keepFailures
    ? results
    : results.filter(result => result.status === 'ok')
  // The manifest always lands next to the script invocation (where the
  // questions file lives), never inside --cwd, which only sets the dsh
  // working directory.
  await writeFile(resolve(process.cwd(), opts.manifest),
    keep.map(result => JSON.stringify(result)).join('\n') + (keep.length > 0 ? '\n' : ''), 'utf8')
  const ok = results.filter(result => result.status === 'ok').length
  process.stderr.write(`done: ${ok}/${questions.length} ok, manifest: ${opts.manifest}\n`)
  if (ok < questions.length) process.exitCode = 1
}

main().catch((error) => {
  process.stderr.write(`llm-trajectory-harvest failed: ${error instanceof Error ? error.message : String(error)}\n`)
  process.exit(1)
})
