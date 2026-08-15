# dsh-trajectory-harvest(DSH 轨迹收割)

从 DeepSeek Harness 收割干净、可直接用于模型训练的轨迹:喂入一份 JSONL 问题清单,
每个问题跑成一个独立会话,再把整个语料折叠为一份训练就绪的 JSONL——可以走 Web 在线导出,
也可以**离线直接从会话存储读取**(无需 DSH 运行)。

```
questions.jsonl ──▶ run.mjs ──▶ manifest.jsonl(问题 id ↔ 会话 id)
                                     │
              ┌──────────────────────┴──────────────────────┐
              ▼ (离线,无需 DSH 运行)        ▼ (dsh Web 运行且为新版本)
  export-offline.mjs ──▶ training.jsonl    export.mjs ──▶ training.jsonl
```

## 你能得到什么

- **每个问题一个独立会话**。每次运行会拉起 `dsh --profile headless "<问题>"`,
  创建一个会话 id 固定为 `batch-<问题id>` 的新会话(通过
  `DSH_HEADLESS_SESSION_ID` 指定),跑完任务、把日志落盘后退出。
- **manifest.jsonl**:问题 id ↔ 会话 id 的映射,以及状态(`ok` / `error` /
  `timeout`)、退出码、耗时和最终回答文本。
- **training.jsonl**:训练语料,每行一个会话(根会话在前,子代理后代随后),
  内容是"当前模型表面"折叠后的干净消息——`system` / `user` / `assistant` /
  `tool` 四种角色、按 id 配对的工具调用、与正文分离的 `reasoning`、每次请求的
  token `usage`、provider/model、step 耗时 `duration_ms`,以及血缘字段
  (`parent_session`、`depth`、`origin`)。格式见 `sample-training.jsonl`。

## 前提

- **离线导出读取的是 headless 写入的同一个 `DSH_HOME`**(默认 `~/.dsh`)。
  不需要任何 dsh 进程在运行。
- `dsh` 命令需要在 `PATH` 里(或传 `--dsh-cmd`;从仓库源码在 Windows 上跑用
  `--dsh-cmd "node --import tsx/esm apps/cli/src/bin.ts"`,也可设环境变量
  `DSH_CMD`)。
- 每次运行都会真实调用模型 API:**会消耗你的 API 额度**,请先用 2–3 个问题试跑。

## 用法(两步,无需重启)

```bash
# 1. 准备问题文件(每行一个 JSON 对象)
#    {"id": "q-001", "prompt": "列出这个项目里的文件。"}

# 2. 运行 —— 默认串行;并发数开小一点,避免被 API 限流
node run.mjs questions.jsonl --concurrency 1
node run.mjs questions.jsonl --concurrency 2 --manifest run-1.jsonl

# 3. 导出整个语料 —— 离线,直接从 $DSH_HOME/sessions 读取
node export-offline.mjs --harness C:\path\to\deepseek-harness --out training.jsonl
```

就这么简单:不需要 Web 服务、不需要重启。离线导出器在会话存储上挂载 harness 的
持久化与 session-query 服务,复用与 Web 导出完全相同的表面折叠,因此输出格式与
`/api/train.export?allSessions=1` 完全一致。

### run.mjs 参数

| 参数 | 默认值 | 含义 |
| --- | --- | --- |
| `--concurrency <n>` | `1` | 同时运行几个 dsh 进程 |
| `--dsh-cmd <cmd>` | `dsh` | dsh 命令;支持带前置参数(例如 `node --import tsx/esm apps/cli/src/bin.ts`);也支持环境变量 `DSH_CMD` |
| `--cwd <dir>` | 本目录 | 每个运行的工作目录 |
| `--timeout <min>` | `30` | 单题超时(分钟) |
| `--manifest <file>` | `manifest.jsonl` | 输出清单路径 |
| `--keep-failures` | 关 | 失败的运行也写入清单 |
| `--session-prefix <p>` | `batch` | 会话 id 前缀(`batch-<id>`) |

### export-offline.mjs 参数

| 参数 | 默认值 | 含义 |
| --- | --- | --- |
| `--harness <dir>` | *(必填)* | deepseek-harness 仓库根目录(读取其编译产物) |
| `--dsh-home <dir>` | `$DSH_HOME` 或 `~/.dsh` | dsh 主目录;会话从 `<dsh-home>/sessions` 读取 |
| `--out <file>` | `training.jsonl` | 输出文件 |
| `--no-descendants` | 关 | 不包含子代理后代 |

### export.mjs 参数(在线路径,仅当 Web 服务运行新版本时)

| 参数 | 默认值 | 含义 |
| --- | --- | --- |
| `--base <url>` | `http://127.0.0.1:3080` | dsh Web 服务地址 |
| `--out <file>` | `training.jsonl` | 输出文件(流式写入) |
| `--no-descendants` | 关 | 不包含子代理后代 |

## 手动 / 其它入口

- 单个会话:`GET /api/train.export?sessionId=batch-q-001&includeDescendants=true`
- 全部语料(在线):`GET /api/train.export?allSessions=1&includeDescendants=true`
- Web 界面:Header 上的「训练数据」按钮或 `/export-train` 命令,导出当前会话。
- 终端单跑:`DSH_HEADLESS_SESSION_ID=batch-q-001 dsh --profile headless "…"`
  可不开脚本直接把一个问题跑进固定会话。

## 注意事项与排障

- **问题 id 必须唯一**——同一 id 再次运行会命中同一个会话。换批时请用新 id
  或新的 `--session-prefix`,避免冲突。
- **空白会话会被跳过**:没产生过轮次的运行不会输出训练行。
- 为获得一致快照,不要在 dsh 进程正在写会话时运行 `export-offline.mjs`。
- 训练 schema 由 `@deepseek-ai/dsh-session-train-export` 的宿主折叠产生
  (`foldSurface`,与 Web Trajectory 视图同源):compaction 替换已折叠、被替换的
  消息不出现、原始流式分片(`assistant/chunk`)被丢弃只用组装消息、图片以
  `blocks` 元数据保留。
- 想自定义 schema(按轮次粒度、去掉 system 消息、内嵌图片字节等),
  折叠逻辑在 harness 仓库的 `packages/host/apiproxy/src/train-export.ts`。
