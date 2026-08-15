# llm-trajectory-harvest

Harvest clean, model-training trajectories from DeepSeek Harness: feed it a
JSONL list of questions, get one durable session per question, then export the
whole corpus as one training-ready JSONL.

```
questions.jsonl ──▶ run.mjs ──▶ manifest.jsonl (question id ↔ session id)
                                     │
                                     ▼   (dsh Web server running)
                              /api/train.export?allSessions=1
                                     │
                                     ▼
                              export.mjs ──▶ training.jsonl
```

## What you get

- **One session per question.** Each run spawns
  `dsh --profile headless "<prompt>"`, which creates a fresh session whose id
  is pinned to `batch-<question id>` (via `DSH_HEADLESS_SESSION_ID`), runs the
  task, flushes the log to durable storage, and exits.
- **manifest.jsonl** maps question ids to session ids with status
  (`ok` / `error` / `timeout`), exit code, elapsed time, and the final answer.
- **training.jsonl** is the training corpus: one line per session (root first,
  then its subagent descendants) holding the current model surface folded into
  clean messages — `system` / `user` / `assistant` / `tool` roles, tool calls
  paired by id, `reasoning` separated from content, per-request token `usage`,
  provider/model, step `duration_ms`, and lineage fields (`parent_session`,
  `depth`, `origin`). See `sample-training.jsonl` for the exact format.

## Requirements

- The **dsh Web server and the headless runs must share the same `DSH_HOME`**
  (default `~/.dsh`) so `export.mjs` can see the sessions `run.mjs` created.
- `dsh` must be on `PATH` (or pass `--dsh-cmd`; from the harness sources on
  Windows use `--dsh-cmd "node --import tsx/esm apps/cli/src/bin.ts"`, or set
  `DSH_CMD`).
- Each run calls the real LLM provider: **it consumes your API quota.** Start
  with 2–3 questions.

## Usage

```bash
# 1. Prepare questions (one JSON object per line)
#    {"id": "q-001", "prompt": "List the files in this project."}

# 2. Run — serial by default; keep --concurrency small to respect rate limits
node run.mjs questions.jsonl --concurrency 1
node run.mjs questions.jsonl --concurrency 2 --manifest run-1.jsonl

# 3. Export the whole corpus (dsh Web server must be running)
node export.mjs --out training.jsonl
```

### run.mjs options

| Option | Default | Meaning |
| --- | --- | --- |
| `--concurrency <n>` | `1` | how many dsh processes may run at once |
| `--dsh-cmd <cmd>` | `dsh` | the dsh command; leading args allowed (e.g. `node --import tsx/esm apps/cli/src/bin.ts`); env `DSH_CMD` |
| `--cwd <dir>` | this dir | working directory for each run |
| `--timeout <min>` | `30` | per-question timeout in minutes |
| `--manifest <file>` | `manifest.jsonl` | output manifest path |
| `--keep-failures` | off | also write failed runs to the manifest |
| `--session-prefix <p>` | `batch` | session id prefix (`batch-<id>`) |

### export.mjs options

| Option | Default | Meaning |
| --- | --- | --- |
| `--base <url>` | `http://127.0.0.1:3080` | dsh Web host base URL |
| `--out <file>` | `training.jsonl` | output file (streamed, never held fully in memory) |
| `--no-descendants` | off | do not include subagent descendants |

## Manual / alternative entry points

The same data is available without these scripts:

- One session: `GET /api/train.export?sessionId=batch-q-001&includeDescendants=true`
- Whole corpus: `GET /api/train.export?allSessions=1&includeDescendants=true`
  (downloads `dsh-train-all.jsonl`)
- Web UI: the **Train data** header button or the `/export-train` slash
  command exports the current session.
- Terminal: `DSH_HEADLESS_SESSION_ID=batch-q-001 dsh --profile headless "…"`
  runs one question into a pinned session id without the script.

## Notes & troubleshooting

- **Question ids must be unique** — a second run with the same id targets the
  same session. Use fresh ids or a new `--session-prefix` per batch.
- **Blank sessions are skipped**: a run that never produced a turn writes no
  training line.
- `export.mjs` fails loud if the Web server is not running or the sessions are
  invisible (wrong `DSH_HOME`).
- The training schema comes from the `@deepseek-ai/dsh-session-train-export`
  host fold (`foldSurface`, the same fold the Web Trajectory view renders):
  compaction replacements are folded, shadowed messages excluded, raw stream
  chunks (`assistant/chunk`) dropped in favor of assembled messages, images
  kept as `blocks` metadata.
- To customize the schema (per-turn granularity, drop the system message,
  embed image bytes, …), the fold lives in
  `packages/host/apiproxy/src/train-export.ts` of the harness repository.
