# 文档类工具按需携带（Lazy Tool Offering）

> 设计规格 · **已落地（Phase 1–3 已完成；Phase 4 可选增强待办）**  
> 目标：减少每轮 LLM 请求中的工具 schema token，降低模型选错工具概率，同时保持执行层能力完整。

---

## 1. 背景与问题

### 1.1 现状

iceCoder 在 `initializeToolSystem()`（`src/tools/index.ts`）中注册全部内置工具，Harness 每轮将 `toolRegistry.getDefinitions()` 全量传给 LLM（`chat-ws.ts`、`cli/commands/run.ts`、`cli/commands/chat.ts`）。

文档与媒体相关工具包括：

| 工具名 | 用途 | 典型格式 |
|--------|------|----------|
| `parse_document` | 通用文档解析（策略自动选择） | PDF、DOCX、PPTX、XLSX、ODT、RTF、HTML、MD、CSV、JSON 等 |
| `parse_doc_legacy` | 旧版 OLE2 `.doc` | `.doc` |
| `parse_xlsx_deep` | Excel 结构化深度解析 | `.xlsx`、`.xlsm` |
| `parse_pptx_deep` | PPTX 结构化深度解析 | `.pptx` |
| `parse_xmind_deep` | XMind 思维导图深度解析 | `.xmind` |
| `notebook_read` | Jupyter Notebook | `.ipynb` |
| `image_read` | 图片视觉分析（需 LLM adapter） | `.png`、`.jpg` 等 |

此外还有 Shell 协作模式已有的**工具白名单**（`src/session/session-tool-policy.ts`），与普通 Agent 模式独立。

### 1.2 痛点

| 问题 | 说明 |
|------|------|
| Token 浪费 | 纯编码对话每轮仍携带 7+ 个文档工具 definition，合计约 1.5k–3k input tokens |
| 选错工具 | 工具列表过长，模型在 `read_file` 与 `parse_document` 之间犹豫 |
| 与 Prompt 不一致风险 | `sections.ts` 固定提及文档工具，即使用户任务与文档无关 |

### 1.3 结论

**文档类工具不必每轮携带。** 默认只带核心（Tier-0）工具；当用户消息、上传文件、引用路径等信号表明需要文档处理时，再动态追加对应工具。

---

## 2. 设计原则

### 2.1 注册与携带分离

```text
Registry（执行层）     → 始终注册全部工具，handler 不变
Offering（LLM 可见层） → 每轮按信号筛选 toolDefs 再传给 Harness
```

- 执行层保留完整能力，避免「注册了但 LLM 看不到」导致维护两套 handler。
- 若模型调用未在本轮 Offering 中的工具，执行层返回明确错误（可选 Phase 4）。

### 2.2 与现有模式兼容

| 模式 | 策略 |
|------|------|
| 普通 Agent | 启用 Lazy Tool Offering |
| Shell 协作（`/shell`） | **不**走 lazy 逻辑，继续用 `SHELL_COLLAB_TOOL_NAMES` 白名单 |
| MCP 工具 | 独立策略；本规格暂不裁剪 MCP（后续可扩展 Tier-2） |

### 2.3 会话粘性

用户可能在第 1 轮说「分析 report.xlsx」，第 2 轮只说「把第 3 列求和」。若第 2 轮不再携带 `parse_xlsx_deep`，模型将无法继续。

**规则：** 本会话一旦成功调用过某 deferred 工具，后续轮次继续携带，直到会话结束或显式过期策略触发。

---

## 3. 工具分层

### 3.1 Tier-0 Core（永远携带）

文件 CRUD、搜索、Shell、Git、网络、目录浏览等日常编码工具：

```text
read_file, write_file, edit_file, append_file, fs_operation, file_info,
glob, grep, run_command, diff_files, batch_edit_file, patch_file,
web_search, fetch_url, git,
list_drives, browse_directory, open_file,
env_info, undo_edit
```

（具体名单以 `src/tools/index.ts` 注册列表为准，排除 Tier-1 文档工具。）

### 3.2 Tier-1 Document（按需携带）

```text
parse_document
parse_doc_legacy
parse_xlsx_deep
parse_pptx_deep
parse_xmind_deep
notebook_read
image_read          ← 仅当 llmAdapter 存在且未走多模态 inline 图片时
```

**说明：**

- `parse_document` 是万能入口，大多数格式只需激活它。
- 深度工具（`parse_*_deep`）在与对应后缀或语义 intent 匹配时追加。
- **ZIP 无专用 parse 工具**：解压依赖 Tier-0 的 `run_command` / `fs_operation`，不激活 Tier-1。

### 3.3 Tier-2 特殊（本规格不裁剪）

```text
mcp_*
request_analysis
Shell 协作白名单工具
```

---

## 4. 激活信号

每轮用户消息到达后，在 `resolveSessionHarnessToolContext` 之后、`harnessConfig.context.tools` 赋值之前，计算 `activatedToolNames`。

### 4.1 输入结构

```typescript
interface ToolActivationInput {
  /** 用户原始消息（含 @引用 解析前或后，见实现约定） */
  userMessage: string;
  /** resolveFileReferences 返回的上传/引用文件绝对路径 */
  uploadedFilePaths: string[];
  /** 显式 @ 路径 */
  explicitReferencePaths: string[];
  /** 本会话最近 N 轮成功调用过的工具名 */
  sessionRecentToolCalls: string[];
  /** file-browser-direct 最近一次 browse 目录 */
  lastBrowsedPath?: string;
  /** 是否 Shell 协作模式 */
  shellCollabActive: boolean;
  /** 是否已有 vision 多模态 inline 图片 */
  hasInlineVisionImages: boolean;
}

interface ToolActivationResult {
  activated: Set<string>;
  /** 调试日志：'ext:.xlsx', 'upload:report.pdf', 'sticky:parse_document' */
  reasons: string[];
}
```

### 4.2 后缀 → 工具映射表

```typescript
const EXT_TOOL_MAP: Record<string, string[]> = {
  // 通用文档
  pdf:   ['parse_document'],
  docx:  ['parse_document'],
  odt:   ['parse_document'],
  odp:   ['parse_document'],
  ods:   ['parse_document'],
  rtf:   ['parse_document'],
  pptx:  ['parse_document', 'parse_pptx_deep'],
  ppt:   ['parse_document'],   // parse_pptx_deep 仅接受 .pptx（src/tools/builtin/pptx-parse-tool.ts:320）
  xlsx:  ['parse_document', 'parse_xlsx_deep'],
  xls:   ['parse_document'],   // parse_xlsx_deep 仅接受 .xlsx（src/tools/builtin/xlsx-parse-tool.ts:501）
  xlsm:  ['parse_document'],   // 同上，.xlsm 不匹配 deep 的 .xlsx 校验
  doc:   ['parse_document', 'parse_doc_legacy'],
  xmind: ['parse_document', 'parse_xmind_deep'],
  ipynb: ['notebook_read'],
  md:    ['parse_document'],
  markdown: ['parse_document'],
  csv:   ['parse_document'],
  html:  ['parse_document'],
  htm:   ['parse_document'],
  txt:   ['parse_document'],
  json:  ['parse_document'],
  xml:   ['parse_document'],
  // 图片
  png:   ['image_read'],
  jpg:   ['image_read'],
  jpeg:  ['image_read'],
  gif:   ['image_read'],
  webp:  ['image_read'],
  bmp:   ['image_read'],
};
```

**不映射的后缀（走 Core）：** `.ts`、`.js`、`.py`、`.zip`、`.tar`、`.gz` 等 — 分别用 `read_file` 或 `run_command`。

### 4.3 正则提取规则

**禁止**全局扫描 `\.\w+`（会把 `node.js`、`config.ts` 误识别为文件）。

推荐两类 pattern：

```typescript
// 路径型：D:\foo\bar.xlsx、./src/a.pdf、/tmp/report.docx
const PATH_EXT_RE = /(?:^|[\s"'`(]|[/\\])[\w.-]+\.([a-z0-9]{1,8})\b/gi;

// 纯文件名型：report.xlsx、需求.doc
const BARE_FILE_RE = /\b([\w\u4e00-\u9fff.-]+)\.([a-z0-9]{1,8})\b/gi;
```

**扫描顺序（优先级从高到低）：**

1. `uploadedFilePaths` / `explicitReferencePaths` — **必激活**，从路径 extname 查表
2. `userMessage` — 路径型 + 文件名型正则
3. `lastBrowsedPath` + 用户只写文件名 — 拼接后查 ext（复用 `chat-ws.ts` 已有 hint 逻辑）

### 4.4 语义兜底

当无明确后缀但 intent 明显时：

```typescript
const DOC_INTENT_RE =
  /分析|解读|总结|提取|翻译|对比|表格|幻灯|文档|pdf|excel|word|ppt|pptx|xlsx|xmind/i;
// 注意：与现有 ANALYSIS_HINT（src/web/file-browser-direct.ts:16）部分重叠，
// 实现时可考虑统一正则来源，避免两套语义漂移。

// 已有：src/web/file-browser-direct.ts
looksLikeFileAnalysisIntent(userMessage)
```

| 条件 | 激活 |
|------|------|
| `looksLikeFileAnalysisIntent(msg)` && `lastBrowsedPath` | `parse_document`, `parse_pptx_deep`, `open_file`（保守小包） |
| `DOC_INTENT_RE.test(msg)` && 有上传或引用 | `parse_document` + 按引用后缀追加 deep 工具 |
| 用户说「分析 Excel」无路径 | `parse_document`, `parse_xlsx_deep` |

### 4.5 会话粘性

```typescript
const DEFERRED_TOOLS = new Set([
  'parse_document', 'parse_doc_legacy', 'parse_xlsx_deep',
  'parse_pptx_deep', 'parse_xmind_deep', 'notebook_read', 'image_read',
]);

sessionSticky = sessionRecentToolCalls.filter(n => DEFERRED_TOOLS.has(n));
activated = CORE_ALWAYS ∪ sessionSticky ∪ thisTurnActivated;

> ✅ 已实现：Web 端按会话在内存中采集（`sessionDeferredToolCalls`，chat-ws.ts）；
> CLI 端（run.ts / chat.ts）也接入（模块级 `cliSessionDeferredToolCalls`）。
> 工具成功执行（tool_result 且 toolSuccess）时写入。**仅进程内存，重启即失**。
```

**可选过期（Phase 4）：** 连续 2 轮无 tool call 且新消息无文档信号时，从 sticky 集移除文档工具。

### 4.6 多模态图片

若消息已通过 vision 通道 inline 发送图片（`src/llm/vision-fallback.ts` 已有「无需调用 image_read」逻辑），**不**激活 `image_read`。

---

## 5. 架构与接入点

### 5.1 数据流

```text
用户消息 + 上传/引用
        ↓
resolveSessionHarnessToolContext()     ← 已有：Shell 白名单 / 完整 ToolSystem
        ↓
selectToolsForOffering()               ← 【新增】
  input:  allDefs, ToolActivationInput
  output: filtered ToolDefinition[]
        ↓
prepareToolsForChatCompletions()       ← 已有：字典序排序 + 可选 slim description
                                         （src/llm/tool-offering.ts:23；openai-adapter.ts:604、
                                          openai-responses-bridge.ts:144 调用）
                                          ⚠️ 会按名重排，deferred 工具并非 append 在尾部
        ↓
harnessConfig.context.tools
        ↓
Harness 循环（Registry 仍可执行全部已注册工具）
```

### 5.2 建议新增模块

| 文件 | 职责 |
|------|------|
| `src/tools/tool-offering-selector.ts` | 映射表、正则、激活逻辑、`selectToolsForOffering()` |
| `test/tools/tool-offering-selector.test.ts` | 单元测试 |

### 5.3 修改点

| 文件 | 改动 | 状态 |
|------|------|------|
| `src/tools/tool-offering-selector.ts` | 选择器核心 | ✅ 已实现 |
| `src/web/chat-ws.ts` | 在 `toolDefs = sessionToolCtx.toolDefs` 之后调用 selector | ✅ 已实现 |
| `src/cli/commands/run.ts` | 同上 | ✅ 已实现 |
| `src/cli/commands/chat.ts` | 同上 | ✅ 已实现 |
| `src/prompts/sections.ts` | 文档工具段落改为通用说明（不写死 parse 工具） | ✅ 已实现 |

### 5.4 运行开关

**无环境变量开关**：Lazy Tool Offering 恒定开启（Web / CLI 均生效），不读取任何 `ICE_LAZY_*` 环境变量。

- 唯一例外：Shell 协作模式与运行时工具禁用（`ICE_DISABLE_TOOLS` / `ICE_EVAL_MODE`）下自然跳过。
- **sticky 仅进程内存**；单个 Harness run 内 tools 列表固定不变（每轮由 `selectToolsForOffering` 计算一次）。

---

## 6. Prompt 同步

### 6.1 问题

`src/prompts/sections.ts` 工具段落当前固定写：

```text
parse_document; parse_xlsx_deep / parse_pptx_deep when needed.
```

若 Offering 未携带这些工具，会造成 **Prompt 与 tools 数组不一致**。

### 6.2 方案

| Offering 状态 | System prompt 行为 |
|---------------|-------------------|
| 未激活任何 Tier-1 | 不写 parse 工具说明（sections.ts 已改为通用表述：文档工具按需提供） |
| 已激活部分 Tier-1 | 注入 `available-doc-tools` 到 systemContext（经 `buildAvailableDocToolsContext`） |

实现位置：`src/prompts/sections.ts`（静态段落改为通用说明）+ `buildAvailableDocToolsContext()`（selector，注入 systemContext）。

> ✅ **已实现**：未激活时不写 parse 指引；已激活时经 harness 动态层注入
> `<available-doc-tools>parse_document, parse_xlsx_deep</available-doc-tools>`（systemContext）。
> Shell 协作模式 / 运行时工具禁用（`ICE_DISABLE_TOOLS` / `ICE_EVAL_MODE`）下跳过注入。

---

## 7. 边界场景

| 场景 | 处理 |
|------|------|
| 纯编码任务（改 bug、写测试） | 仅 Tier-0，无文档工具 |
| 用户上传 `.zip` | 不激活 parse；`run_command` 解压 |
| 路径中含 `.ts` | 不激活 parse；`read_file` |
| Shell 协作模式 | 跳过 lazy，沿用白名单 |
| 模型调用未 Offering 的工具 | 返回：`Tool not offered this turn; re-send with file reference or explicit path` |
| 上传 PDF 但消息无文字 | 仅从 `uploadedFilePaths` 激活 `parse_document` |
| /browse 后直接「总结一下」 | `looksLikeFileAnalysisIntent` + `lastBrowsedPath` 兜底 |

---

## 8. 预期收益

| 指标 | 估计 |
|------|------|
| 纯编码对话每轮 input token | 减少约 1.5k–3k（视模型 tool schema 编码而定） |
| 工具选择准确率 | 列表更短，误用 parse 工具概率下降 |
| 前缀缓存 | prepareToolsForChatCompletions 会对 tools 按名重排（字典序），deferred 工具按字母序插入而非 append 尾部；激活集合轮间稳定时前缀仍可缓存，集合变化时该段失效 |

---

## 9. 实施计划

### Phase 1 — 最小可用

- [x] 新增 `tool-offering-selector.ts`
- [x] 从 `uploadedFilePaths` / `explicitReferencePaths` 激活
- [x] 会话 sticky（Web 端内存采集 `sessionDeferredToolCalls`）
- [x] 接入 `chat-ws.ts`
- [x] 恒定开启（无环境变量开关，移除 ICE_LAZY_*）
- [x] 单元测试：后缀映射、上传路径、sticky

### Phase 2 — 消息正则与语义

- [x] 用户消息 PATH_EXT_RE / BARE_FILE_RE
- [x] `looksLikeFileAnalysisIntent` + `lastBrowsedPath` 兜底
- [x] `DOC_INTENT_RE` 语义激活
- [x] 接入 `run.ts` / `chat.ts`（CLI，含 sticky）

### Phase 3 — Prompt 动态化

- [x] `sections.ts` 静态段落改为通用说明（不写死 parse 工具）
- [x] `buildAvailableDocToolsContext` 注入 systemContext（Web + CLI）
- [ ] 集成测试：Offering 与 prompt 一致（待办）

### Phase 4 — 可选增强

- [ ] sticky 过期策略
- [ ] 未 Offering 工具的友好错误
- [ ] MCP 工具 lazy（独立规格）
- [ ] 指标：每会话 deferred 工具激活率、token 节省估算

---

## 10. 测试要点

### 10.1 单元测试（`tool-offering-selector.test.ts`）

```text
✓ 无信号 → 仅 Core，无 parse_*
✓ 消息含 report.xlsx → parse_document + parse_xlsx_deep
✓ 上传 path/to/a.pdf → parse_document
✓ 消息含 app.ts → 不激活 parse
✓ sticky：上轮用过 parse_xlsx_deep，本轮无后缀 → 仍携带
✓ shellCollabActive=true → 透传原 toolDefs，不裁剪
✓ hasInlineVisionImages=true → 不携带 image_read
✓ package.json / tsconfig.json / *.lock → 不激活 parse（工程配置排除）
✓ 「看看 doc」→ 不激活 parse（doc 格式词严格化）
```

### 10.2 手工验收

1. 纯编码：「帮我把 utils.ts 里的 foo 改成 bar」→ 工具列表无 `parse_*`
2. 文档：「分析 `./docs/spec.pdf`」→ 出现 `parse_document`
3. 多轮：第 1 轮分析 xlsx，第 2 轮「求第 3 列合计」→ 仍有 `parse_xlsx_deep`
4. Shell 模式：工具仍为协作白名单

---

## 11. 相关代码索引

| 路径 | 说明 |
|------|------|
| `src/tools/index.ts` | 工具注册入口 |
| `src/tools/tool-offering-selector.ts` | Lazy Tool Offering 选择器（新增） |
| `src/tools/tool-metadata.ts` | `parse` tag 元数据 |
| `src/tools/builtin/doc-parse-tool.ts` | `parse_document` |
| `src/session/session-tool-policy.ts` | Shell 协作工具策略（参考白名单模式） |
| `src/harness/workspace-run-context.ts` | ToolSystem 解析 |
| `src/llm/tool-offering.ts` | 排序与 description slim |
| `src/web/chat-ws.ts` | Web Harness 工具注入 |
| `src/web/file-browser-direct.ts` | `looksLikeFileAnalysisIntent` |
| `src/web/routes/upload.ts` | `resolveFileReferences`、扩展名列表 |
| `src/prompts/sections.ts` | 静态工具说明段落 |

---

## 12. 不在本规格范围

- ZIP 专用解析工具（继续用 Shell 解压 + `read_file` / `parse_document`）
- 按文件大小 / MIME 激活（仅按后缀与语义）
- 运行时动态注册新工具类型
- Learning 层根据历史自动调整激活策略

---

## 13. 修订记录

| 日期 | 说明 |
|------|------|
| 2026-08-10 | 初稿：Lazy Tool Offering 设计规格 |
| 2026-08-10 | 落地 Phase 1–3：selector、Web/CLI 接入、sticky、Prompt 对齐；移除 ICE_LAZY_* 环境变量开关（恒定开启） |
