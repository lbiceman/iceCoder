# iceCoder environment variables

Reference for every **process** environment variable read under `src/` and `scripts/`, plus the browser **`localStorage`** key used by the Web UI. Each entry documents purpose, valid values, defaults, and where it is read.

**Maintenance:** When adding or removing env reads in code, update this file and [`环境变量.md`](./环境变量.md) together.

---

## 1. How to use

| Method | Notes |
|--------|-------|
| Shell export | `export ICE_DATA_DIR=./data` before starting |
| Project `.env` | iceCoder does not load `.env` itself; inject via shell or your launcher |
| CLI flags | e.g. `--port` overrides `PORT` |

**CLI data-dir resolution:**

1. Explicit env (`ICE_CONFIG_PATH`, etc.)
2. Paths under `ICE_DATA_DIR`
3. `./data` if `data/config.json` exists in cwd
4. Else `~/.iceCoder`

**Note:** `src/index.ts` (`npm run dev:api`) uses fixed defaults for some paths and does not go through CLI `resolveDataPaths()`.

---

## 2. Master index

| Variable | Category | Default (unset) | Valid values / type |
|----------|----------|-----------------|---------------------|
| `ICE_DATA_DIR` | Paths | `./data` or `~/.iceCoder` | Directory path |
| `ICE_CONFIG_PATH` | Paths | `{dataDir}/config.json` | File path |
| `ICE_SYSTEM_PROMPT_PATH` | Paths | `{dataDir}/system-prompt.md` | File path |
| `ICE_OUTPUT_DIR` | Paths | `output` or `{dataDir}/output` | Directory path |
| `ICE_SESSIONS_DIR` | Paths | `data/sessions` | Directory path |
| `ICE_MEMORY_DIR` | Paths | `data/memory-files` | Directory path |
| `ICE_USER_MEMORY_DIR` | Paths | `data/user-memory` | Directory path |
| `ICE_RUNTIME_DIR` | Paths | `{sessions}/../runtime` | Directory path |
| `ICE_SUPERVISOR_CONFIG_PATH` | Supervisor | `{dataDir}/supervisor-config.json` | File path |
| `ICE_SUPERVISOR_SHADOW` | Supervisor | Config file `shadow` | `1`/`true`/`0`/`false` |
| `PORT` | HTTP | `1024` (index) / `3784` (CLI) | 1–65535 |
| `NODE_ENV` | HTTP | non-production | `production`, etc. |
| `ICE_EVAL_MODE` | Prompts / eval | off | `1` enables |
| `ICE_DISABLE_TOOLS` | Prompts / eval | off | `1` enables |
| `ICE_CONTEXT_WINDOW` | LLM / context | provider → **128000** | positive integer |
| `ICE_OPENAI_REQUEST_TIMEOUT_MS` | LLM | adapter **120000** | positive integer (ms) |
| `ICE_SLIM_TOOL_DESCRIPTIONS` | LLM | off | `1`/`true`/`yes` |
| `ICE_SLIM_TOOL_DESC_MAX_CHARS` | LLM | **384** | integer ≥ **48** |
| `ICE_HARNESS_MAX_ROUNDS` | Harness | **5000** | positive integer |
| `ICE_TASK_GRAPH` | Harness | **false** | any value except `0`/`false` → true |
| `ICE_COMPACTION_RATIO` | Compaction | **0.88** | (0, 1] |
| `ICE_MICRO_COMPACT_RATIO` | Compaction | **0.72** | (0, 1] |
| `ICE_COMPACTION_RESERVE_TOKENS` | Compaction | **15000** | positive integer |
| `ICE_STANDARD_RECALL_COOLDOWN_SEC` | Memory | **300** | integer ≥ **0**; **0** disables |
| `ICE_EXTRACTION_MAX_MESSAGES` | Memory | **80** | integer ≥ **20** |
| `ICE_MEMORY_DIMENSION_DOC` | Memory | `docs/记忆系统调整.md` | File path |
| `ICE_MAX_TOOL_OUTPUT_CHARS` | Tools | **24000** | **8000–200000** |
| `ICE_READ_FILE_MAX_LINES` | Tools | **420** | **50–5000** |
| `ICE_READ_FILE_MAX_CHARS` | Tools | **18000** | **2000–500000** |
| `ICE_DOC_PARSE_TEXT_MAX_CHARS` | Tools | **16000** | **2000–200000** |
| `ICE_SUBAGENT_TIMEOUT_MS` | Sub-agent | **120000** | positive integer |
| `ICE_SUBAGENT_CACHE_MAX_ENTRIES` | Sub-agent | **100** | integer ≥ **1** |
| `ICE_MCP_CONFIG_PATH` | MCP | `<cwd>/.iceCoder/mcp.json` | File path |
| `ICE_MCP_INIT_TIMEOUT_MS` | MCP | **120000** | integer ≥ **15000** |
| `TUNNEL_URL` | Tunnel | none | HTTPS URL |
| `ICE_TUNNEL_WS_NOTIFY` | Tunnel | enabled | `0` disables |
| `ICE_TUNNEL_PROBE_MS` | Tunnel | **2500** | integer ≥ **500** |
| `ICE_TUNNEL_METRICS_HOST` | Tunnel | **127.0.0.1** | hostname/IP |
| `ICE_TUNNEL_METRICS_PORT` | Tunnel | **20241** | port |
| `ICE_TUNNEL_METRICS_QUICKTUNNEL` | Tunnel | built from host+port | full URL |
| `CLOUDFLARED_BIN` | Tunnel | PATH lookup | executable path |
| `ICE_AGENT_EVAL_MODE` | Scripts | **mock** | `mock` \| `real` |
| `ICE_RUNTIME_TELEMETRY` | Scripts | `data/runtime/telemetry.jsonl` | File path |
| `ICE_AGENT_EVAL_HISTORY` | Scripts | `data/eval/agent-eval-history.jsonl` | File path |
| `NO_COLOR` | Terminal | off | any non-empty disables color |
| `COMSPEC` | System | Windows default | shell path |
| `SHELL` | System | Unix default | shell path |
| `ICE_PLAN_PANEL` | Browser | enabled | `localStorage`=`0` hides panel |

See [`环境变量.md`](./环境变量.md) for full Chinese prose per variable (sections 3–16). The sections below mirror the same structure in English.

---

## 3. Paths and data directories

| Variable | Purpose | Default | Valid values |
|----------|---------|---------|--------------|
| `ICE_DATA_DIR` | CLI data root | `./data` or `~/.iceCoder` | directory path |
| `ICE_CONFIG_PATH` | LLM providers JSON (not MCP) | `{dataDir}/config.json` | file path |
| `ICE_SYSTEM_PROMPT_PATH` | Override assembled system prompt file | `{dataDir}/system-prompt.md` | file path |
| `ICE_OUTPUT_DIR` | General output directory | `output` or `{dataDir}/output` | directory path |
| `ICE_SESSIONS_DIR` | Sessions, checkpoints, session notes | `data/sessions` | directory path |
| `ICE_MEMORY_DIR` | Project-level memory store | `data/memory-files` | directory path |
| `ICE_USER_MEMORY_DIR` | User-scoped memory | `data/user-memory` | directory path |
| `ICE_RUNTIME_DIR` | Runtime telemetry JSONL root | `{sessions}/../runtime` | directory path |

---

## 4. Dual-mode Supervisor

### `config.json` → `supervisorMode` (not env)

| Field | Purpose | Default | Valid values |
|-------|---------|---------|--------------|
| `supervisorMode` | User-facing supervisor mode; Web nav tri-state toggle | `adaptive` | **`off`** \| **`adaptive`** \| **`strict`** |

API: `GET /api/config` includes `supervisorMode`; `PATCH /api/config/supervisor-mode` with `{ "supervisorMode": "strict" }`.

Overrides `supervisor-config.json` `mode` when present. See [`环境变量.md`](./环境变量.md) §4 (Chinese).

| Variable | Purpose | Default | Valid values |
|----------|---------|---------|--------------|
| `ICE_SUPERVISOR_CONFIG_PATH` | Path to `supervisor-config.json` | `{dataDir}/supervisor-config.json` | file path |
| `ICE_SUPERVISOR_SHADOW` | Shadow eval without mutating `supervisorPhase` | file `shadow` | **`1`/`true`** on; **`0`/`false`** off |

Load failure degrades to **`off`** without blocking startup. Parsed only in `mode-controller.ts` (Global layer).

---

## 5. HTTP and Node

| Variable | Purpose | Default | Valid values |
|----------|---------|---------|--------------|
| `PORT` | HTTP listen port | **1024** (`index.ts`); **3784** (CLI) | port integer; CLI `--port` wins |
| `NODE_ENV` | **`production`** serves SPA from `dist/public` | dev behavior | `production`, etc. |

---

## 6. Prompts, eval, and LLM

| Variable | Purpose | Default | Valid values |
|----------|---------|---------|--------------|
| `ICE_EVAL_MODE` | Eval mode: no memory extraction, eval system append | off | **`1`** only |
| `ICE_DISABLE_TOOLS` | Omit tool schemas and tool prompt sections | off | **`1`** only |
| `ICE_CONTEXT_WINDOW` | Override effective context window (tokens) | provider → **128000** | positive integer |
| `ICE_OPENAI_REQUEST_TIMEOUT_MS` | OpenAI-compatible request timeout (ms) | **120000** after provider field | positive integer |
| `ICE_SLIM_TOOL_DESCRIPTIONS` | Truncate tool descriptions for LLM | off | **`1`/`true`/`yes`** |
| `ICE_SLIM_TOOL_DESC_MAX_CHARS` | Max chars per description when slim enabled | **384** | integer ≥ **48** |

**Context window resolution:** `ICE_CONTEXT_WINDOW` → default provider `maxContextTokens` in `data/config.json` → max across providers → **128000**. Note: tier reader uses hardcoded `data/config.json`, not `ICE_CONFIG_PATH`.

---

## 7. Harness

| Variable | Purpose | Default | Valid values |
|----------|---------|---------|--------------|
| `ICE_HARNESS_MAX_ROUNDS` | Max rounds per `Harness.run()` | **5000** | positive integer |
| `ICE_TASK_GRAPH` | `isTaskGraphEnabled()` flag | **false** | not `0`/`false` → **true** |

**Removed (do not use):** `ICE_HARNESS_TOKEN_BUDGET` (fixed **50000000**); `ICE_HARNESS_TIMEOUT_MS` / `ICE_HARNESS_TIMEOUT_HOURS` (fixed **86400000** ms).

---

## 8. Context compaction

| Variable | Purpose | Default | Valid values |
|----------|---------|---------|--------------|
| `ICE_COMPACTION_RATIO` | Hard compaction trigger ratio | **0.88** | (0, 1] |
| `ICE_MICRO_COMPACT_RATIO` | Micro-compaction trigger ratio | **0.72** | (0, 1] |
| `ICE_COMPACTION_RESERVE_TOKENS` | Token reserve after hard compaction | **15000** | positive integer |

---

## 9. Memory

| Variable | Purpose | Default | Valid values |
|----------|---------|---------|--------------|
| `ICE_STANDARD_RECALL_COOLDOWN_SEC` | Standard recall cooldown | **300** | ≥ **0**; **0** = off |
| `ICE_EXTRACTION_MAX_MESSAGES` | Max messages per LLM extraction | **80** | ≥ **20** |
| `ICE_MEMORY_DIMENSION_DOC` | Memory-dimension doc for extraction prompts | `docs/记忆系统调整.md` | path (truncated at 12k chars) |

**Hot config (not env):** `data/memory/memory-config.json`.

---

## 10. Tool output limits

| Variable | Purpose | Default | Valid range |
|----------|---------|---------|-------------|
| `ICE_MAX_TOOL_OUTPUT_CHARS` | Tool result chars in context | **24000** | **8000–200000** |
| `ICE_READ_FILE_MAX_LINES` | `read_file` default max lines | **420** | **50–5000** |
| `ICE_READ_FILE_MAX_CHARS` | `read_file` soft char cap | **18000** | **2000–500000** |
| `ICE_DOC_PARSE_TEXT_MAX_CHARS` | Doc parse text soft cap | **16000** | **2000–200000** |

---

## 11. Sub-agent

| Variable | Purpose | Default | Valid values |
|----------|---------|---------|--------------|
| `ICE_SUBAGENT_TIMEOUT_MS` | `delegate_to_subagent` envelope timeout | **120000** | positive integer |
| `ICE_SUBAGENT_CACHE_MAX_ENTRIES` | Process LRU cache size | **100** | integer ≥ **1** |

---

## 12. MCP

| Variable | Purpose | Default | Valid values |
|----------|---------|---------|--------------|
| `ICE_MCP_CONFIG_PATH` | MCP config JSON | `<cwd>/.iceCoder/mcp.json` | file path |
| `ICE_MCP_INIT_TIMEOUT_MS` | MCP `initialize` timeout | **120000** | integer ≥ **15000** |

---

## 13. Quick Tunnel / remote

| Variable | Purpose | Default | Valid values |
|----------|---------|---------|--------------|
| `TUNNEL_URL` | Fixed public URL; skip metrics probe | none | HTTPS URL |
| `ICE_TUNNEL_WS_NOTIFY` | WebSocket push when tunnel ready | enabled | **`0`** disables |
| `ICE_TUNNEL_PROBE_MS` | Metrics poll interval (ms) | **2500** | ≥ **500** |
| `ICE_TUNNEL_METRICS_HOST` | cloudflared metrics host | **127.0.0.1** | host |
| `ICE_TUNNEL_METRICS_PORT` | cloudflared metrics port | **20241** (`dev` script may use **20341**) | port |
| `ICE_TUNNEL_METRICS_QUICKTUNNEL` | Full quicktunnel URL | derived | URL |
| `CLOUDFLARED_BIN` | cloudflared executable for CLI `start` | PATH | path |

---

## 14. Scripts / eval

| Variable | Purpose | Default | Valid values |
|----------|---------|---------|--------------|
| `ICE_AGENT_EVAL_MODE` | `npm run eval:agent` mode | **mock** | **`mock`** \| **`real`** (not `live`) |
| `ICE_RUNTIME_TELEMETRY` | Telemetry JSONL for `real` mode | `data/runtime/telemetry.jsonl` | file path |
| `ICE_AGENT_EVAL_HISTORY` | Eval history JSONL | `data/eval/agent-eval-history.jsonl` | file path |

CLI `--mode` overrides `ICE_AGENT_EVAL_MODE`.

---

## 15. Terminal / system

| Variable | Purpose |
|----------|---------|
| `NO_COLOR` | Any non-empty value disables CLI ANSI colors |
| `COMSPEC` / `SHELL` | Reported by `env_info` tool (usually leave unset) |

---

## 16. Browser localStorage (not server env)

| Key | Purpose | Valid values |
|-----|---------|--------------|
| `ICE_PLAN_PANEL` | Task-graph / plan panel visibility in Web chat | **`0`** hides; delete key to show |

---

## 17. `.env` template

See section 17 in [`环境变量.md`](./环境变量.md) for a copy-paste template with all common variables commented.

---

## 18. Related docs

- [`README.md`](../README.md) — architecture overview
- [`双模方案2.md`](./双模方案2.md) — Supervisor spec
- [`data/supervisor-config.example.json`](../data/supervisor-config.example.json)
- [`data/config.example.json`](../data/config.example.json)
