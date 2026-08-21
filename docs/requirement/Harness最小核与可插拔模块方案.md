# Harness 最小核与可插拔模块方案

> 状态：**设计草案 · 未改代码**
> 日期：2026-08-19
> 背景：当前 Harness 把 L1 / L2 / 记忆 / 压缩 / 任务图等全部内聚进主循环；目标是 **核只做最基础循环，能力以组件方式挂载，设置里可开关，打开后下一次对话即生效**。

---

## 1. 要解决什么

现状（代码事实）：

- `Harness` 构造函数**总是**创建 `HarnessMemoryIntegration`、`ModeDecisionEngine`、`TaskRiskClassifier`、`GraphExecutor`，即使 `supervisorMode=off`。
- 记忆被写进 `harness-round-prep` / `harness-tool-round` / `harness-compaction` / `onLoopStart` / `onLoopEnd`，不是可选附件。
- L0 档位（`off` / `adaptive` / `strict`）已可切换，但 **L1、L2、记忆、压缩、任务图不能独立开关**。
- 每次用户发言都会 `new Harness(...)`（`chat-ws.ts`），进程内其实有「下一轮重建」的机会，但没有模块注册表，也没有设置页开关。

目标一句话：

> **Harness 只负责「问模型 → 发生命周期 → 决定停不停」。** 压缩和工具是内置插件（不可关，但核也不 import 它们）。记忆 / L1 / L2 等可选，设置里开/关，下一次对话生效。模块挂了只提示，绝不打断主循环。

---

## 2. 设计原则

| # | 原则 | 含义 |
|---|------|------|
| P1 | 核要小、契约要稳 | 主循环只暴露生命周期与端口；**禁止**对压缩、工具、记忆、L2 等实现做静态 `import` |
| P2 | 可选模块可开关 | 记忆 / L1 / L2 等有 `enabled`；**内置插件没有开关** |
| P3 | 对话边界生效 | **进行中的一轮不热替换**；可选模块开关变更在「下一次对话」生效（见 §7） |
| P4 | 清单装载，禁止核 import | 所有插件（含内置）由 **catalog + loader** 注入；核只收实例，不写 `import { ContextCompactor }` |
| P5 | 内置不可关 + 安全底线 | 压缩、工具系统是内置插件，设置里关不掉；权限确认 / HostGuard 随工具插件，同样不可关 |
| P6 | 依赖显式、失败降级 | 模块声明 `requires`；缺依赖则禁用并提示，不半开半关把循环弄坏 |
| P7 | 适配器包裹存量代码 | 不重写 L2 / 记忆 / 压缩 / 工具执行器；先做 `ModuleAdapter` 接到生命周期上 |
| P8 | 模块故障隔离 | **模块/插件抛错不得中断 Harness。** 捕获 → 提示用户 → 回滚该模块本钩子的副作用 → 继续跑核和其余模块 |

---

## 3. 目标架构

```text
┌─────────────────────────────────────────────────────────────┐
│ 设置页「模块」Tab（仅可选插件）                                │
│  [L1] [L2] [L3] [记忆] [任务图] [验收门] [Dream] ...           │
│  内置（只展示、无开关）：工具系统 · 上下文压缩                   │
│                     │ persist                                │
│                     ▼                                        │
│              config.json → runtimeModules                    │
└──────────────────────┬──────────────────────────────────────┘
                       │ 进程启动：读 catalog.json 装载插件
                       │ 下一次对话：按开关快照可选插件
                       ▼
┌─────────────────────────────────────────────────────────────┐
│ ModuleRegistry + CatalogLoader                               │
│  · 按清单装载（无 harness 静态 import）                       │
│  · 内置 alwaysOn 必须装上，失败则拒绝启动                     │
│  · 可选插件随开关；解析依赖；启停后台                         │
└──────────────────────┬──────────────────────────────────────┘
                       │ 注入 ModuleInstance[] + ports
                       ▼
┌─────────────────────────────────────────────────────────────┐
│ Harness Kernel（最小核 · 零实现 import）                      │
│  while (running)                                             │
│    emit(beforeRound)  → 压缩(内置) / 记忆 / L1 ...            │
│    call LLM                                                  │
│    emit(afterLlm)                                            │
│    if tools: emit(before/afterTool) → ports.tools.run()       │
│    emit(afterRound)   → L2 观察 / takeover                    │
│    emit(shouldStop)   → 验收门 / StopHook                     │
│  每个 emit：try/catch 包住单个模块；失败只记日志+提示，核继续   │
└─────────────────────────────────────────────────────────────┘
         ▲ 只依赖 Lifecycle API + 端口类型，不依赖任何插件实现
```

三层职责：

| 层 | 职责 | 例子 | 设置里能关？ |
|----|------|------|-------------|
| **Kernel** | 消息、调 LLM、生命周期 `emit`、abort、轮次上限 | 瘦身后的 `harness.ts` | —（不是插件） |
| **Builtin plugins** | 没它跑不下去的能力；**永远注册** | 工具系统、上下文压缩 | **不能关** |
| **Optional plugins** | 可开关能力 | L1、L2、L3、记忆、任务图、验收门 | 能关 |

核里的「跑工具」不是 `import ToolExecutor`，而是调用内置工具插件挂上的 **`ports.tools`**。压缩同理：核不 `new ContextCompactor()`，只 `emit('beforeRound')`，由压缩插件自己压。

---

## 4. 最小核边界

核**必须**做的：

1. 组装本轮 messages（静态 system + 历史）
2. 调 LLM（含流式、重试、abort）——LLM 适配器由 bootstrap 注入端口，核仍不 import 具体厂商 SDK
3. 若响应含 tool_calls：`emit(beforeTool)` → **`ports.tools.run()`** → `emit(afterTool)`
4. 把工具结果写回 messages
5. 根据 `maxRounds` / timeout / abort / 模型无工具 决定停
6. 发出 `HarnessStepEvent`（给 UI）
7. **按顺序调用生命周期**（核不知道谁注册了）；**单个模块失败不得冒泡出 `emit()`**

核**禁止**出现的代码形态（硬约束，可用 lint / 测试锁死）：

```ts
// harness.ts / harness-round-*.ts 里全部非法
import { ContextCompactor } from './context-compactor.js';
import { ToolExecutor } from '../tools/tool-executor.js';
import { HarnessMemoryIntegration } from './harness-memory.js';
import { RecoverySupervisor } from './supervisor/recovery-supervisor.js';
```

允许且仅允许：

```ts
import type { HarnessModule, LifecycleCtx, ToolRuntimePort } from './module-protocol.js';
```

核**禁止**直接依赖的目录：`src/memory/**`、`src/harness/supervisor/**`、`src/tools/**`（含 tool-executor）、`context-compactor` 实现、TaskGraph 实现、Dream runner。

内置 vs 可选（不再「压缩可关」）：

| 能力 | 类型 | 设置 | 原因 |
|------|------|------|------|
| **工具系统** | 内置插件 | 不可关 | 没工具就不是 coding agent；权限 / HostGuard / 执行器都在这里 |
| **上下文压缩** | 内置插件 | 不可关 | 关了长会话必爆窗，属于运行时必需品 |
| TaskGraph | 可选 | 可关 | L1/L2 依赖它；问答场景可不建图 |
| Verification Gate | 可选 | 可关 | 工程助手默开，闲聊可关 |
| 子代理 | 可选 | 可关 | 成本高 |
| 记忆 / Dream | 可选 | 可关 | 打开后下一对话生效 |
| L1 / L2 / L3 | 可选 | 可关 | 见 §6.3 |
| 工具按需携带（lazy offering） | 可选 | 可关 | 只是裁剪工具定义，不是工具系统本身 |

---

## 5. 生命周期契约

现有 `StopHookManager` 只覆盖「要不要停」一点。需要扩成完整总线，但**钩子数量要克制**——只覆盖主循环真实分叉，避免变成 40 个微钩子。

### 5.1 钩子列表（建议 12 个）

| 钩子 | 何时 | 模块典型用途 | 能否改控制流 |
|------|------|----------------|--------------|
| `onSessionStart` | 本对话第一次 `run` 前 | 记忆 hydrate、L2 `resetForNewTask` | 否 |
| `onLoopStart` | 每次用户消息进入循环 | 粗召回预取、风险分类 | 否 |
| `beforeRound` | compact + 注入之后、调 LLM 前 | 记忆注入、L1 `evaluate`、图节点上下文 | **可改 messages / tools** |
| `afterLlm` | LLM 返回后、执行工具前 | 文本 tool-call salvage、L1 模式切换 | 可改 parsed response |
| `beforeTool` | 单次工具执行前 | L1 ToolGate、HostGuard 之上的策略 | **可 block / 改 args** |
| `afterTool` | 单次工具执行后 | RepoContext、图节点完成、记忆写守卫 | 可改 tool result 展示 |
| `afterRound` | 本轮工具或无工具结束后 | L2 observer / takeover / handoff | **可注入纠偏消息、改 phase** |
| `onNoTools` | 模型本轮不调工具 | 验收门、不完整停止钩子 | **可强制 continue** |
| `shouldStop` | 即将退出循环 | StopHook、verification、user_checkpoint | **可阻止停止** |
| `onLoopEnd` | 循环正常/中止结束 | 记忆提取、Dream 调度、flush notice | 否 |
| `onError` | **核自身**未捕获错误（LLM/工具执行器） | 遥测、降级提示 | 可转用户可见错误；**不是**模块报错入口 |
| `onDispose` | Harness 实例释放 | 取消预取、释放锁 | 否 |

`beforeRound` / `afterRound` / `shouldStop` 是三条主动脉。L1 主要挂 `beforeRound`+`beforeTool`；L2 主要挂 `afterRound`；记忆主要挂 `onLoopStart`+`beforeRound`+`onLoopEnd`。

模块自己的异常**不走** `onError`，由总线按 §5.4 隔离。`onError` 只处理核路径（LLM 超时、工具执行器崩溃等）——那些本来就会让本轮失败。

### 5.2 上下文对象（所有钩子同一份，只读核状态 + 有限写入口）

```ts
interface LifecycleCtx {
  sessionId: string;
  round: number;
  messages: UnifiedMessage[];          // 模块可 splice/push，须走 ctx.inject()
  tools: ToolDefinition[];
  state: HarnessRunState;              // 核状态；模块只能写自己的 namespace
  abortSignal: AbortSignal;

  inject(msg: UnifiedMessage, meta?: { preserveOnCompaction?: boolean }): void;
  setTools(tools: ToolDefinition[]): void;
  requestContinue(reason: string): void;
  requestStop(reason: string): void;
  emit(event: HarnessStepEvent): void;

  /** 模块私有状态，按 moduleId 隔离 */
  bag: Record<string, unknown>;
}
```

约束：

- **禁止**模块直接 `messages.push` 绕过 `inject()`（否则压缩保留位、UI 事件会对不齐）。
- 模块状态放 `ctx.bag[moduleId]` 或 `state.modules[moduleId]`，**不准**在 `Harness` 上再加 `private memoryIntegration`。
- 钩子默认并行只读、**串行写入**（按模块 `priority`）。同一钩子里两个模块都改 messages 时，顺序必须确定、可测。

### 5.3 优先级与冲突

```ts
interface ModuleMeta {
  id: string;
  kind: 'builtin' | 'optional' | 'external';
  alwaysOn: boolean;         // builtin 必须 true；loader 拒绝 alwaysOn=false 的 builtin
  priority: number;          // 小的先跑。建议：工具 5 → 压缩 10 → 记忆 20 → L1 30 → 图 40 → L2 50 → L3 60
  requires?: string[];       // 硬依赖，缺则本模块不激活（内置缺失则拒绝启动）
  optional?: string[];
  conflicts?: string[];
}
```

示例：L2 `requires: ['l1']`；L3 `requires: ['l1', 'l2', 'task-graph']`。用户在设置里只开 L2、关 L1 → Registry 拒绝激活 L2，UI 显示「需要先开启 L1」。

内置插件（`tools`、`compaction`）永远在 snapshot 里，不参与依赖缺失时的「当没装」——它们没装就是启动失败。

### 5.4 故障隔离：模块报错不得拖垮 Harness

这是产品硬约束，不是优化项：

> **任意模块 / 插件在任意钩子里 throw、reject、超时，Harness 主循环必须继续。**  
> 核只负责：抓住它 → 回滚它本钩子的副作用 → 提示用户 → 跑下一个模块 / 下一轮。

今天记忆 Dream 曾把 `null.chat` 抛到日志里，说明「可选能力的异常」已经会污染主路径。插件化之后若不隔离，一个坏掉的记忆召回就能把整轮对话打断。

#### 5.4.1 总线怎么包（每个钩子、每个模块一次）

```ts
async function emit(hook: HookName, ctx: LifecycleCtx): Promise<void> {
  for (const mod of snapshot.modules) {          // 已按 priority 排好
    if (mod.circuitOpen) continue;               // 本对话已熔断则跳过
    const fn = mod.hooks[hook];
    if (!fn) continue;

    const checkpoint = ctx.checkpoint(mod.meta.id);  // messages / tools / bag[id]
    try {
      await withTimeout(fn(ctx), MODULE_HOOK_TIMEOUT_MS);
    } catch (err) {
      checkpoint.rollback();                     // 半截 inject / 半截改 tools 全部撤掉
      reportModuleFault(mod, hook, err);         // 提示 + 遥测，绝不 rethrow
      mod.recordFailure();
      // 不 break：同钩子里后面的模块照常跑
    }
  }
}
```

约束：

| 规则 | 做法 |
|------|------|
| 永不 rethrow | `emit()` 对核永远 resolve；核路径看不到模块异常 |
| 失败不连坐 | 记忆挂了，L1 / L2 / 压缩仍跑 |
| 半截写入要回滚 | 钩子开始前对 `messages` / `tools` / `bag[moduleId]` 做 checkpoint；失败则恢复。禁止「召回抛错但已经 push 了一半 CoN 块」 |
| 超时视为失败 | 单钩子默认 **2s**（`onLoopEnd` / `setup` 可更宽，如 10s）。挂死 = 失败，不堵 while |
| `setup` / `teardown` 同样隔离 | 进程级加载失败 → 该模块当未启用；已启用模块 `teardown` 抛错只记日志，不影响关进程 / 关开关 |
| 同步 throw、Promise reject、超时 三种都算失败 | 统一走 `reportModuleFault` |

核自己的失败（LLM 4xx、工具执行器崩溃、abort）**不在此列**，该停还停。隔离的是「挂件」，不是「发动机」。

#### 5.4.2 提示什么、提示到哪

失败必须让用户看见，但不能刷屏、不能冒充模型说话。

推荐一条事件，三处消费：

```ts
// HarnessStepEvent
{
  type: 'module_error',
  moduleId: 'memory',
  moduleName: '长期记忆',
  hook: 'beforeRound',
  message: '记忆召回失败，本轮已跳过记忆注入',
  retryable: true,
}
```

| 通道 | 行为 |
|------|------|
| 聊天系统提示（浅色、可折叠） | 「模块「长期记忆」出错，已跳过，对话继续。」详情可展开看 hook + 短错误 |
| 冰豆气泡 | 一句话，不刷第二次（同一模块同一对话合并） |
| 设置页该模块旁 | 红点 + 「本对话曾失败 N 次」；不自动关开关 |
| `telemetry.jsonl` | `module_fault`，带 `moduleId` / `hook` / `stack` 截断 |

**禁止：** 把堆栈当 assistant 消息塞进 LLM 上下文（污染下一轮推理）。提示只走 UI / 遥测。若必须让模型知道「这轮没有记忆」，用极短 `system-reminder`：「记忆模块本轮不可用，请勿假设有长期记忆。」——可选，默认关，避免错误文案本身变成干扰。

#### 5.4.3 本对话熔断（防同一模块每轮都炸）

同一 `sessionId` + `moduleId`：

1. 连续失败 **3** 次（可配）→ **本对话熔断**：后续钩子直接 `continue`，不再调用。
2. Toast 一次：「「长期记忆」本对话已暂停，下一次对话会再试。也可在设置中关闭该模块。」（**内置插件不出现后半句**，改为「将在下一次对话自动重试」。）
3. **不改** `config.json` 的 `enabled`。熔断是运行时的，不是用户关开关。
4. 新对话重新计数、重新尝试（用户可能已经修了配置 / 磁盘）。
5. 若被熔断的是别人的 `requires`（例如 L1 熔断），依赖它的 L2 / L3 **本对话也跳过**，并提示「L2 未运行：依赖的 L1 已暂停」。这比「L1 挂了 L2 仍 takeover」更安全。

熔断阈值不要设成 1：偶发超时（磁盘、LLM 侧查询）应允许下一轮再试。

#### 5.4.4 失败后主循环怎么走（具体例子）

| 失败点 | Harness 行为 |
|--------|----------------|
| 记忆 `beforeRound` 召回抛错 | 本轮不注入记忆，照常调 LLM、跑工具 |
| 压缩 `beforeRound` 超时 | 本轮不压缩，带着当前窗口继续，并 **加重提示**（内置能力失败）；下一轮仍会再试 |
| 工具插件 `ports.tools.run` 抛错 | **单次 tool_call** 记失败结果写回 messages，循环继续；不是整轮 abort。权限底线仍在该插件内，失败不得变成「未检查就执行」 |
| L1 `beforeTool` 抛错 | 视为该模块未表态；**不**当成「放行」。ToolGate 没跑就走核的权限底线（confirm/deny 仍在）。宁可不收紧，也不误放行——底线不在模块里 |
| L2 `afterRound` takeover 中抛错 | 不进入 takeover；`supervisorPhase` 保持钩子前的值（checkpoint 回滚） |
| 验收门 `shouldStop` 抛错 | 视为该模块未阻止停止；若只有它会 `requestContinue`，循环按核规则停。宁可不拦，也不卡死 |
| Dream `setup` 启动失败 | 记忆召回仍可用；设置页 Dream 显示错误；Harness 无感 |
| 外部插件装载失败 | 当该插件未安装；其它模块不受影响 |
| 内置插件 **进程启动时** 装载失败 | **拒绝启动**（缺工具/压缩不能装成「还能聊」的残缺进程）；与运行时钩子失败不同 |

原则：**失败 = 该模块本钩子不发生**（等价于这一跳没挂上），不是「失败 = 整轮 abort」，也不是「失败 = 默认放行危险操作」。安全底线仍在核里。

#### 5.4.5 测试必须锁死的行为

1. 记忆模块 `beforeRound` throw → 循环仍 `call LLM`，结果 `stop_reason` 与无记忆时一致；收到恰好一条 `module_error`。
2. 同钩子两个模块，第一个 throw、第二个仍被调用（不连坐）。
3. 模块 throw 前 `ctx.inject()` 过 → 回滚后 messages 与调用前 deepEqual。
4. 连续 3 次失败 → 第 4 轮不再进入该模块钩子，且只有一条熔断提示。
5. 模块 hook 超过超时 → 走同一失败路径，`while` 不被堵住。
6. 核 LLM 失败仍要失败（对照：隔离不能误伤发动机）。
7. PATCH `runtimeModules.compaction.enabled=false`（或 tools）不生效；snapshot 里永远有这两个 builtin。
8. `harness.ts` 的 import 列表不得包含 `context-compactor` / `tool-executor` / `harness-memory`。

---

## 6. 模块模型：清单装载，禁止核 import

### 6.1 接口

```ts
interface HarnessModule {
  readonly meta: ModuleMeta;
  setup?(host: ModuleHost): void | Promise<void>;
  teardown?(): void | Promise<void>;
  /** 内置工具插件在 setup 里把执行器挂到 host.ports.tools */
  hooks: Partial<HarnessLifecycleHooks>;
}

interface ModuleHost {
  ports: {
    tools?: ToolRuntimePort;   // 由 builtin:tools 提供；核只调这个
  };
  registerRoute(path: string, router: Router): void;
  registerTool(def: ToolDefinition, handler: ToolHandler): void;
  registerPromptSection(section: PromptSection): void;
  getConfig(): IceCoderConfigFile;
}

interface ToolRuntimePort {
  run(calls: ToolCall[], ctx: LifecycleCtx): Promise<ToolResult[]>;
}
```

### 6.2 怎么装进来：catalog，不是 import

**问题：** 若 `harness.ts` 顶部写 `import { CompactionModule } from '...'`，核和插件仍然编译期绑死，「插件」只是换了个文件夹。内置也不能走这条路。

**做法：** 插件清单是 **数据**；唯一的装载点是 `ModuleLoader`，Harness 核文件里 **零条实现 import**。

```text
src/modules/catalog.json          ← 数据：id / kind / entry / alwaysOn / priority
src/modules/loader.ts             ← 进程里唯一按 entry 装载的地方
src/harness/harness.ts            ← 只 import type；构造函数收 ModuleInstance[]
src/cli/bootstrap.ts              ← registry.loadCatalog()，不写 import CompactionModule
```

`catalog.json` 示例：

```json
{
  "plugins": [
    {
      "id": "tools",
      "kind": "builtin",
      "alwaysOn": true,
      "priority": 5,
      "entry": "builtin/tools/index.js"
    },
    {
      "id": "compaction",
      "kind": "builtin",
      "alwaysOn": true,
      "priority": 10,
      "entry": "builtin/compaction/index.js"
    },
    {
      "id": "memory",
      "kind": "optional",
      "alwaysOn": false,
      "priority": 20,
      "entry": "optional/memory/index.js"
    }
  ]
}
```

装载规则：

| 规则 | 说明 |
|------|------|
| 核禁止静态 import 实现 | `harness.ts`、`harness-round-*.ts` 不得引用 `context-compactor` / `tool-executor` / `harness-memory` / `supervisor/*`。用测试扫 import 图锁死 |
| 清单驱动 | loader 读 `entry` 字符串，运行时装载该文件的 default export（`HarnessModule` 工厂） |
| 内置与可选走同一条装载管线 | 差别只在 `alwaysOn` 和「装失败怎么办」，不在「一个 import、一个动态」 |
| 内置装失败 = 进程不起来 | 缺 `tools` / `compaction` 直接 boot error，避免半残 runtime |
| 可选装失败 = 跳过该插件 | 提示「记忆模块未能加载」，其余照跑 |
| 配置无法关掉内置 | PATCH `runtimeModules.compaction.enabled=false` 被 sanitize **拒绝或忽略**；设置页无开关 |
| TypeScript 类型 | 核只 `import type`。实现文件之间可以互相 import（压缩实现仍可引用自己的策略文件），**跨边界**（核 → 插件）不行 |

「不要 import」指的是 **核与插件之间的源码耦合方式**，不是「JavaScript 永远不能加载文件」。运行时总得把插件代码读进来，但入口是 **清单里的路径字符串**，换插件改 JSON，不改 `harness.ts`。

存量代码用适配器包一层，由各 `entry` 导出，而不是搬进核：

| 现有实现 | 适配器 entry | kind |
|----------|----------------|------|
| `ToolExecutor` + registry + HostGuard + 权限确认 | `builtin/tools` | **builtin** |
| `ContextCompactor` | `builtin/compaction` | **builtin** |
| `HarnessMemoryIntegration` | `optional/memory` | optional |
| `ModeDecisionEngine` + `execution-mode-constraints` | `optional/l1` | optional |
| `RecoverySupervisor` + `supervisor-bridge` | `optional/l2` | optional |
| `graph_hint force_switch` | `optional/l3` | optional |
| `GraphExecutor` | `optional/task-graph` | optional |
| `harness-verification-gate` | `optional/verification` | optional |

### 6.3 建议的开关清单（仅 optional）

设置页「模块」Tab 分两块：

1. **内置（只读）**：工具系统、上下文压缩 —— 徽章「始终开启」，无 toggle。
2. **可选**：下面这些才有开关。

| id | 名称 | 默认 | 依赖 | 关掉之后用户能感到什么 |
|----|------|------|------|------------------------|
| `l1` | L1 执行模式 | 开（随 L0≠off） | — | 不再 free↔forced、无 ToolGate 收紧 |
| `l2` | L2 监管接管 | 开（随 L0≠off） | `l1` | 无 takeover / 反构图 / handoff |
| `l3` | L3 强制切分支 | 开（随 L0=strict 更常见） | `l1`,`l2`,`task-graph` | 无 `force_switch` 升级 |
| `memory` | 长期记忆 | 开 | — | 不召回、不提取、不注入 MEMORY.md |
| `memory-dream` | Dream 整理 | 开 | `memory` | 后台不再整理记忆文件 |
| `task-graph` | 任务图 | 开 | — | 无图、无节点合约 |
| `verification` | 验收门 | 开 | — | 改代码后可不跑测试就口头完工 |
| `sub-agent` | 子代理 | 开 | — | 无 `request_analysis` 分流 |
| `lazy-tools` | 工具按需携带 | 开 | `tools`（内置） | 每轮带全量工具定义；**不关闭工具执行** |

L0（`supervisorMode`）与独立开关的关系（必须写死，避免两套真相）：

- **推荐：L0 是预设，独立开关是覆盖。**
  - `off` → 默认关 `l1/l2/l3`
  - `adaptive` / `strict` → 默认开 `l1/l2`，`l3` 按策略
  - 用户在模块 Tab 里关掉 `l2` → 即使 L0=adaptive，本对话也不跑 L2
- 设置页展示：「监管档位」仍在聊天侧栏；模块 Tab 显示「当前被 L0 预设为开，你已手动关闭」。
- **L0 不能关掉压缩和工具。** 档位只影响监管链。

**不可开关（两层）：**

| 层 | 内容 | 落地 |
|----|------|------|
| 内置插件 | 工具系统、上下文压缩 | catalog `alwaysOn: true`；设置页只读 |
| 随工具插件的安全底线 | 权限确认、HostGuard、Shell 强制确认、workspace lock | 不单独做模块开关；高级里最多「放宽」，不能关 |

`lazy-tools` 是「带哪些工具定义给模型」，不是「还能不能执行工具」。关掉 offering 只是每轮全量工具 schema，执行路径仍走内置 `tools`。

### 6.4 配置形状

```json
{
  "supervisorMode": "adaptive",
  "runtimeModules": {
    "l1": { "enabled": true },
    "l2": { "enabled": true },
    "l3": { "enabled": true },
    "memory": { "enabled": true },
    "memory-dream": { "enabled": true },
    "task-graph": { "enabled": true },
    "verification": { "enabled": true },
    "sub-agent": { "enabled": true },
    "lazy-tools": { "enabled": true }
  }
}
```

`runtimeModules` **不准出现** `tools` / `compaction` 的 `enabled: false`。sanitize：未知 key 拒绝；若有人手工写了内置 id，忽略 enabled 并打日志。前后端 DEFAULT 用测试锁死。

---

## 7. 「动态注入」语义（这是本方案的核心产品约定）

用户原话：**现在没有记忆系统，设置里打开，下一次对话就要使用记忆。**

### 7.1 生效边界：下一次对话，不是这一轮中间

| 时机 | 是否换模块集 | 原因 |
|------|----------------|------|
| 本轮 `while` 跑到一半 | **否** | L2 phase、记忆预取、图游标都是本轮状态；中途插入等于换引擎 |
| 本轮已结束、用户再发一条 | **可以，但不作为对外承诺** | 代码上每次发言都 `new Harness`，技术上能立刻带上新模块 |
| **新开对话 / 用户理解的「下一次对话」** | **是（对外承诺）** | 状态干净，无半截 takeover、无半截召回 |

对外文案建议：

> 模块开关将在 **下一次对话** 生效。当前正在进行的对话仍按开始时的模块组合运行。

实现上采用 **对话级快照**：

```text
对话开始（第一条 user 消息，或 session 创建）
  → Registry.snapshot(config.runtimeModules)
  → 本 sessionId 钉死 ModuleInstance[]
后续同一对话的每一轮 Harness.run()
  → 复用这份快照，忽略中途改的开关
新对话
  → 重新 snapshot
```

这样满足「打开记忆 → 下一对话就有」，同时避免同一会话前半无记忆、后半突然注入导致模型人格/上下文跳变。

若产品后来希望「下一句就生效」，只需把快照粒度从 `sessionId` 改成 `runId`，契约已经支持。

### 7.2 打开模块时要注入什么

以记忆为例，打开后下一次对话必须具备：

1. **进程侧**：若 `memory-dream` 也开，启动 Dream runner；关则 `teardown` 停定时器。
2. **路由侧**：`/api/memory/*` 可选择「关模块时 404 或返回 disabled」——建议 **路由仍在，API 返回 `{ enabled:false }`**，前端记忆页显示「已在设置中关闭」。
3. **Prompt 侧**：`loadMemoryPrompt` 只在快照含 `memory` 时执行。
4. **Harness 侧**：只注册 `MemoryModule` 的 hooks；核路径零 `if (memory)`。
5. **工具侧**：记忆相关工具（若有）随模块注册/注销，避免关了记忆还能 `write MEMORY.md`。

「动态」指的是 **不必重启进程**。Registry 监听 config 变更（设置页 PATCH 成功后 `broadcast('modules_changed')`），后台服务立即启停；**对话内循环仍用旧快照**。

### 7.3 关闭模块

- 磁盘数据保留（记忆文件、supervisor-events.jsonl 不删）。
- 本对话快照仍开着则跑完为止。
- 新对话不再 hydrate、不再召回。
- 后台 Dream / 扫描停止。

不自动做「卸载时的数据迁移」；需要的话做成独立「清理记忆」按钮。

---

## 8. 设置页与运行时通知

1. `config-page.js` 增加 Tab **模块**（桌面 + 移动 `#/m/config` 同步）。
2. 两块 UI：**内置（只读徽章）** + **可选（开关）**。关验收门等可二次确认；**不要**给压缩/工具做开关。
3. PATCH `/api/config/runtime-modules`；成功后：
   - 写 `config.json`（sanitize 丢掉对内置 id 的 enabled 篡改）
   - `ModuleRegistry.apply(next)`（只热启停 **optional** 后台服务）
   - WS 广播 `modules_changed` + 当前快照
4. 聊天欢迎页 / 冰豆可显示「本对话模块：记忆·L1·L2」（可选，避免噪音）。内置不刷。
5. 若用户在**当前对话进行中**改开关：toast「将在下一次对话生效」。
6. 收到 `module_error`：聊天一条可折叠系统提示 + 设置页对应模块红点；同一模块同一对话合并，不刷屏。内置失败用更醒目文案（「上下文压缩本轮失败，对话仍继续」）。

---

## 9. 落地路径：先改 Harness，再按模块一天一刀

**可以，而且就该这么干。** 不要一次把记忆、监管、图全搬完。每一刀都是可合并的 PR：默认行为与当天早上一致，测试全绿，随时能停。

约束（否则「一天一块」会变成每天都在拆核）：

1. **第一刀只做插座，不搬业务。** 没有生命周期 + catalog + 故障隔离，后面的记忆/监管无处可挂。
2. **每一刀是适配器，不是重写。** 「一天做记忆」= 把现有 `HarnessMemoryIntegration` 接到钩子上并可关，不是重做召回算法。
3. **当天结束必须可发布。** 开关默认开 = 和改造前一模一样；关是新能力，可以次日再做 UI。
4. **顺序有依赖。** 先内置（工具、压缩），再记忆，再 L1，再 L2（L2 依赖 L1）。不要先拆 L2。

### 建议节奏（按可合并切片，不是死承诺日历）

| 切片 | 做什么 | 当天结束时用户侧 | 预估 |
|------|--------|------------------|------|
| **D0 插座** | `HarnessLifecycle` + `emit` try/catch + catalog/loader 空壳；旧代码仍从钩子里被调用 | 完全无感 | 1–2 天 |
| **D1 工具内置** | `builtin/tools` 适配 `ToolExecutor`；核改 `ports.tools.run()`；import 图测试禁止核引用 `tool-executor` | 无感；工具不可关 | 1 天 |
| **D2 压缩内置** | `builtin/compaction` 适配 `ContextCompactor`；核不再 `new` 压缩器 | 无感；压缩不可关 | 1 天 |
| **D3 记忆可选** | `optional/memory` 适配现有记忆集成；对话快照；关了下一对话不召回 | 默认无感；设置可关记忆 | **1 天能挂上，开关+设置页可能再半天** |
| **D4 L1** | `optional/l1` 适配 ModeDecisionEngine / ToolGate | 默认无感；可关 L1 | 1 天 |
| **D5 L2** | `optional/l2` 适配 RecoverySupervisor / bridge；`requires: ['l1']` | 默认无感；可关监管 | **往往 1–2 天**（和 L1、图、checkpoint 缠得紧） |
| **D6+** | L3、任务图、验收门、Dream、lazy-tools、设置页打磨 | 一块一块加开关 | 各 0.5–1 天 |

「一天做监管」对 L1 基本成立；L2 不要硬压成一天，卡住就停在「L1 已是插件、L2 仍走旧桥」，也比半拆要安全。

### 每一刀的固定验收（复制粘贴）

- 相关 vitest 全绿（尤其 harness / 该模块原测试）
- 默认全开 ≡ 这一刀之前的事件与 stop_reason
- 该模块 throw 时循环仍结束，且有 `module_error`
- 核的实现 import 没有回潮
- 可以独立 revert 这一刀，不影响前几刀

### 随时停靠点

- 停在 D0：白做了插座，但产品不变，风险最低。
- 停在 D2：核已干净，压缩+工具是内置插件——**这是最小有价值形态**。
- 停在 D3：已经能演示「设置开关记忆，下一对话生效」。
- 停在 D5：双模也插件化。后面都是锦上添花。

### 和「三期」的关系

上面 D0–D2 ≈ 一期前半；D3 ≈ 一期后半（记忆开关）；D4–D5 ≈ 二期监管；D6+ ≈ 二期其余。三期外部插件等插座和 1–2 个可选模块都稳了再做。

---

## 10. 方案对比（为什么选「生命周期 + 组件」）

| 方案 | 做法 | 优点 | 缺点 | 结论 |
|------|------|------|------|------|
| **A. 继续 if 开关** | `if (config.memory)` 散落各处 | 改动小 | 核永远知道所有模块；开关越多越烂 | 否 |
| **B. 纯中间件洋葱** | Koa 式 `next()` 包整轮 | 组合灵活 | 工具轮/无工具轮/停止决策分叉多，洋葱难表达；调试栈深 | 不适合主循环 |
| **C. 事件总线（完全解耦）** | 只 emit，谁爱谁听 | 核最干净 | 控制流（block 工具、强制 continue）难做；顺序不确定 | 不够 |
| **D. 生命周期 + 组件（推荐）** | 固定钩子 + 有限写入口 + Registry | 贴合现有 while；可测；能开关；能下一对话注入 | 钩子设计要一次想对；适配器有样板代码 | **是** |
| **E. 多 Runtime 进程** | 记忆/L2 另进程 | 故障隔离 | 延迟、IPC、调试成本对本地助手过重 | 远期才考虑 |

推荐 **D**。它和现有 `StopHookManager`、`supervisorBridge` 是同一方向的正规化，而不是另起炉灶。

---

## 11. 改造之后的优缺点（相对现状）

对照对象：今天的单体 Harness（构造函数直接 `new` 记忆 / 压缩 / L1，`chat-ws` 每次拼 `HarnessConfig`）。

### 11.1 一句话

**工程上换的是「核不再认识插件、插件可关可隔离」；产品上换的是「记忆等可开关，压缩和工具关不掉」。**  
换不到更短的主循环路径，也换不到更少的代码总量——总量会先升后降。

### 11.2 优点

| 维度 | 现在 | 改造后 |
|------|------|--------|
| 核的可读性 | `harness.ts` 同时知道记忆、L1、压缩、图 | 只剩 while + `emit` + `ports.tools`；能力在 catalog |
| 能力组合 | L0 只能粗调监管；记忆关不干净 | 可选模块真开关；评测关记忆、闲聊关图，互不改核 |
| 动态启用 | 改代码或重启才算「装上记忆」 | 设置打开 → 不必重启 → **下一次对话**用上 |
| 故障半径 | 记忆 / Dream throw 可能污染主路径 | 模块失败提示 + 回滚 + 继续；连续失败本对话熔断 |
| 替换实现 | 换压缩器要改 harness import | 改 `catalog.json` 的 `entry` |
| 演进 | 新能力继续往 Harness 里堆 | Learning / 外部记忆 = 新 catalog 条目 |
| 依赖诚实 | `supervisorMode=off` 仍会 new DecisionEngine | 关 L1 则 L2 不激活，UI 写明原因 |
| 安全底线 | 和可选逻辑混在同一文件 | 压缩、工具内置不可关；权限随工具插件 |

产品上多出来的能力：同一套 runtime 可以是「全功能编程助手」或「几乎裸核 + 工具 + 压缩」，用设置切换，而不是 fork 代码。

### 11.3 缺点与代价

| 维度 | 代价 | 有多痛 |
|------|------|--------|
| **抽象税** | 12 钩子、`inject()`、checkpoint 回滚、`bag` 隔离必须一次设计对 | 高。设计错了每个插件都跟着错 |
| **间接性** | bug 要从核 → loader → 适配器 → 旧类跳 | 中。日志必须带 `moduleId` |
| **改造工期** | harness 高密度测试区；去 import 是硬拆 | 高。一期就要 import 图测试防回潮 |
| **代码先变多** | catalog、loader、适配器、sanitize、设置页 | 中。旧类还在，只是多一层皮 |
| **语义两套时钟** | 进程配置 vs 本对话快照 | 中。UI 写不清用户会以为开关坏了 |
| **测试组合** | 开关理论上爆炸 | 中。只能测剖面，测不全就有漏网组合 |
| **假解耦** | 压缩仍可能用 session notes；L2 仍要图 | 中。关记忆 ≠ 压缩行为完全不变 |
| **内置仍必装** | 冷启动照样加载 tools + compaction | 低。解的是耦合，不是「可以不装压缩」 |
| **故障被捂住** | 记忆坏了对话仍在走，用户可能长期无记忆却不察觉 | 中。必须红点 + 熔断文案，尤其内置失败 |
| **性能** | 每轮多次钩子分发 | 低。相对 LLM 可忽略 |
| **动态 import 调试** | 清单路径错了是启动期/加载期才爆 | 低。内置装失败直接拒绝 boot，能早发现 |

另外两条产品上的「不舒服」：

1. **当前对话中途改开关不生效**（有意为之）。用户会觉得迟钝，必须 toast 说明。
2. **不能关压缩去「省事」或做超短会话评测。** 若评测真要裸核无压缩，只能加隐藏环境变量（不进设置页），否则和「内置不可关」打架。

### 11.4 什么时候不值得做

- 只想加一两个 `if (memoryEnabled)`：改这套过重，用开关散落更快，但核会更胖。
- 没有人维护 catalog / 适配器：间接层会腐烂，最后又会有人在 `harness.ts` 里 `import` 回来。
- 期望「改造完主循环明显变快、文件明显变少」：不会。收益在可组合、可隔离、可演进，不在吞吐。

### 11.5 净值判断

值得做，前提是 **分期**（先总线 + 内置适配 + 记忆/L2 开关，再拆其余），并且用测试锁三件事：默认行为 ≡ 今天、核零实现 import、模块 throw 不杀循环。

不值得做成「一次把 100+ harness 文件全搬进 plugins/」。那是把抽象税一次付清，失败成本过高。


---

## 12. 风险与非目标

**非目标（一期不做）：**

- 第三方插件市场、签名商店、按会话安装 `.ice-module`
- 循环中途热替换 L2/记忆
- 把压缩或工具系统做成设置开关
- 在 `harness.ts` 里用静态 import「暂时先接上」内置插件（这是回潮，不是捷径）
- 重写工具框架；只把现有 `ToolExecutor` 适配进 builtin entry

**主要风险：**

| 风险 | 缓解 |
|------|------|
| 钩子里异步互相等待造成死锁 | 单钩子超时（默认 2s）+ **失败隔离**（§5.4） |
| 模块半截 `inject` 污染 messages | 每模块每钩子 checkpoint，失败回滚 |
| 模块连炸刷屏 / 拖慢每轮 | 连续 3 次失败本对话熔断；UI 合并提示 |
| L1 挂了 L2 仍 takeover | 被熔断模块的 `requires` 依赖链本对话一并跳过 |
| 两模块抢着 `inject` 导致 prompt 膨胀 | 每轮注入预算 |
| 关模块后旧会话 checkpoint 含 L2 字段 | restore 时缺模块则忽略该 slice |
| 设置页与侧栏 L0 双入口打架 | `resolveEffectiveModules(l0, overrides)` 单测锁死 |
| 核再次静态 import 压缩/工具 | import 图单测（harness 文件不得出现这些模块路径） |
| 有人 PATCH 关掉 compaction | sanitize 忽略；API 测例 |

---

## 13. 和现状的衔接点（落地时改哪些文件）

| 区域 | 现状 | 一期改法 |
|------|------|----------|
| `src/harness/harness.ts` | 构造函数 import 并 new 记忆/压缩/执行器 | 只收 Registry 注入的 modules + ports；**零实现 import** |
| `src/modules/catalog.json` + `loader.ts` | 无 | 新增；内置/可选统一装载 |
| `harness-round-prep.ts` 等 | 直接调 `memoryIntegration` / compactor | `lifecycle.emit('beforeRound')` |
| `src/web/chat-ws.ts` | 每次 new Harness 并传入 memoryDir | 传入 snapshot；关记忆则不装 memory entry |
| `src/web/routes/config.ts` | 已有 supervisorMode / iceEtlPrefs | 增 `runtimeModules` PATCH（拒内置关闭） |
| `src/public/js/config-page.js` | 通用 / 模型 / MCP 三 Tab | 增「模块」Tab：内置只读 + 可选开关 |
| `src/memory/file-memory/memory-dream-runner.ts` | 随进程活 | `optional/memory-dream` 的 setup/teardown |
| 测试 | harness 密度最高 | 黄金集 + 开关剖面 + **import 图** + 内置不可关 |

---

## 14. 开放问题（落地前需要拍板）

1. **快照粒度：** 严格「新 session」还是「下一句用户消息」？本方案建议前者做产品承诺，实现预留后者。
2. **L0 与模块开关：** 预设+覆盖，还是模块 Tab 完全取代侧栏三档？建议前者，侧栏三档是高频操作。
3. **关记忆是否隐藏记忆页：** 建议页还在，展示 disabled，避免路由两套。
4. **压缩与记忆：** 压缩是内置、不可关。长期记忆关时，**session notes 仍由压缩插件维护**（不跟 `memory` 开关绑死）。
5. **L3 定义：** 模块开关里的 L3 **只指监管升级（force_switch）**。HostGuard 属于内置工具插件，永不进开关。
6. **工具「执行」vs「按需携带」：** 执行器永远在；`lazy-tools` 只决定 schema 是否裁剪。

---

## 15. 建议决策

若认同本方向，建议按下面拍板后开一期：

1. **架构选 D**：最小核 + 生命周期 + **catalog 装载**；核不静态 import 任何插件实现。
2. **生效选对话快照**：可选模块变更不打断当前对话；下一对话用新组合。
3. **工具系统 + 上下文压缩 = 内置插件，不可关**；权限/HostGuard 随工具插件。设置页只读展示。
4. **先改插座，再按模块一天一刀**（§9）：D0 生命周期 → D1 工具 → D2 压缩 → D3 记忆 → D4 L1 → D5 L2。每一刀可合并、可停、默认行为不变。L2 不要硬压一天。
5. **默认（内置 + 可选全开）≡ 今天行为**，用现有测试当黄金集。
6. **模块故障隔离是硬约束：** throw / reject / 超时 → 提示 + 回滚 + 继续。内置 **启动**失败则拒绝 boot；内置 **运行时**失败仍隔离。
7. **装载方式是清单，不是 import。** 禁止为图省事在 `harness.ts` 里 `import { ContextCompactor }`。

---

## 16. 附录：一次「打开记忆」的时序

```text
用户：设置 → 模块 → 打开「长期记忆」→ 保存
  POST /api/config/runtime-modules { memory: { enabled: true } }
  → 写 config.json
  → ModuleRegistry.apply()
       · 注册 MemoryModule（若尚未注册）
       · 若 memory-dream 开：启动 Dream runner
  → WS modules_changed { pendingForNextSession: ['memory'] }
  → Toast：「将在下一次对话生效」

用户：新建对话（或打开新 session），发送「我们上次约定用 pnpm」
  → snapshot 含 memory
  → MemoryModule.onSessionStart：hydrate
  → MemoryModule.onLoopStart：粗召回预取
  → MemoryModule.beforeRound：inject CoN 记忆块
  → 核调 LLM（已带记忆）
  → MemoryModule.onLoopEnd：提取 / notice
```

关记忆则同一条链路全部不注册，核路径无分支。

---

## 17. 附录：模块报错时核仍继续

```text
beforeRound:
  CompactionModule  ok
  MemoryModule      throw  ← checkpoint 回滚已 inject 的记忆块
       → event module_error { moduleId: 'memory', hook: 'beforeRound' }
       → 聊天：「模块「长期记忆」出错，已跳过，对话继续。」
  L1Module          照常 evaluate          ← 不连坐
  TaskGraphModule   照常注入节点上下文
call LLM            ← 核无视刚才的 throw
tool round / stop   ← 正常走完

若 memory 本对话已连续失败 3 次：
  之后所有钩子跳过 MemoryModule
  提示一次：「长期记忆本对话已暂停」
  L2 若 requires memory？本方案记忆不是 L2 依赖，L2 继续
  若 L1 被熔断：L2/L3 本对话一起跳过
```

