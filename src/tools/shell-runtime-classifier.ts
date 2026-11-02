/**
 * Shell 命令运行时分类器。
 *
 * 把「长命令 / 短命令」分流决策从 LLM 迁移到运行时。
 *
 * - 'long'  → 应当后台启动，不设 hard timeout（Shell Dock 长驻）
 * - 'short' → 前台执行，timeout 上限收紧到 10s
 * - 'auto'  → 前台等到进程退出，单次最多 5 分钟（Codex 空轮询上限）。
 *             到点仍在跑则转入后台且不杀进程，下一轮 action:"check" 再等最多 5 分钟。
 *             不再在 8s 软超时切后台；否则 test/build 会变成「启动成功」+ 额外 LLM poll。
 *             旧行为：ICE_SHELL_SOFT_ESCALATE=1 时仍按 SOFT_TIMEOUT_MS escalate
 *
 * 设计原则：分类白名单写死 const，不读 JSON。escalate 开关见 ICE_SHELL_SOFT_ESCALATE。
 */

/** 前台软超时：仅当 ICE_SHELL_SOFT_ESCALATE=1 时，到达此时长仍在跑则 escalate 到后台。 */
export const SOFT_TIMEOUT_MS = 8_000;

/** 默认关闭 auto 命令的 8s 软超时切后台（与 Claude Code Bash 等到 exit 对齐）。 */
export function shellSoftEscalateEnabled(): boolean {
  return process.env.ICE_SHELL_SOFT_ESCALATE === '1';
}

/** 后台任务不设 hard timeout（0 = 不限时，仅用户 stop / 进程退出 / 应用关闭时结束）。 */
export const HARD_TIMEOUT_NONE = 0;

/** @deprecated 历史别名；后台任务现统一使用 HARD_TIMEOUT_NONE。 */
export const HARD_TIMEOUT_DEFAULT_MS = HARD_TIMEOUT_NONE;

/** @deprecated 历史别名；后台长驻任务现统一不限时。 */
export const HARD_TIMEOUT_LONG_MS = HARD_TIMEOUT_NONE;

/**
 * 单次阻塞等待上限 — 5 分钟。
 * 对齐 Codex 空 `write_stdin` 的 `max_write_stdin_yield_time_ms`：
 * 进程先退出就立刻返回；到点还在跑则把控制权交回模型，进程继续活着。
 */
export const MAX_COMMAND_YIELD_MS = 5 * 60 * 1000;

/** 单次 check 等待下限 — 5 秒。对齐 Codex 空轮询，避免模型用几百毫秒的 timeout 打成忙等。 */
export const MIN_COMMAND_YIELD_MS = 5_000;

/** 前台一次性命令默认等待 — 与单次上限相同（5 分钟）。 */
export const FOREGROUND_DEFAULT_TIMEOUT_MS = MAX_COMMAND_YIELD_MS;

/** 短命令前台 timeout 上限 — 10 秒。 */
export const SHORT_TIMEOUT_MAX_MS = 10_000;

/** Harness / chat-ws 推送后台摘要的最小间隔 — 5 分钟（Phase 4a/4b 接入）。 */
export const BG_SUMMARY_INTERVAL_MS = 5 * 60 * 1000;

/** 长命令特征 — 直接后台启动（基础设施；不含测试命令特权） */
const LONG_RUNNING: RegExp[] = [
  /^tsc\s+(--watch|-w)\b/,
  /^docker\s+(build|run|compose\s+up)\b/,
  /^(pip|poetry|conda)\s+install\b/,
  /^git\s+clone\b/,
  /^curl\s+.*-[oO]\s/,
];

/** 短命令特征 — 前台短超时 */
const SHORT_FAST: RegExp[] = [
  /^git\s+(status|diff(?!\s+--stat)|log(\s+|$)|branch(\s+|$)|show\s+--stat|rev-parse|config\s+--get)/,
  /^(ls|dir|pwd|cd|cat|type|head|tail|wc|echo|which|where|whoami|hostname)\b/,
  /^tsc\s+--noEmit\b/,
  /^(node|npm|pnpm|yarn|tsc|git|python|pip)\s+--version\b/,
  /^(node|npm|pnpm|yarn)\s+-v\b/,
];

export type ShellClass = 'short' | 'long' | 'auto';

/**
 * 分类一条 shell 命令。
 *
 * @param command 命令字符串（不需要先 trim，函数内部会处理）
 * @returns 分类结果
 */
export function classifyShellCommand(command: string): ShellClass {
  const trimmed = command.trim();
  if (!trimmed) return 'auto';

  if (LONG_RUNNING.some((re) => re.test(trimmed))) return 'long';
  if (SHORT_FAST.some((re) => re.test(trimmed))) return 'short';
  return 'auto';
}

/**
 * 根据分类返回应使用的 hard timeout。
 *
 * 所有后台任务（含 Shell Dock 长驻）默认不限时；仅 args.timeout > 0 时由调用方覆盖。
 */
export function pickBackgroundHardTimeout(
  _cls: ShellClass,
  _options: { explicitBackground?: boolean } = {},
): number {
  return HARD_TIMEOUT_NONE;
}

/**
 * 根据分类与显式 args.timeout 决定前台本次阻塞多久。
 *
 * - 'short' → min(argsTimeout ?? 5min, 10s)
 * - 其它 → min(argsTimeout ?? 5min, 5min)
 */
export function pickForegroundTimeout(
  cls: ShellClass,
  argsTimeout: number | undefined,
  defaultTimeoutMs: number = FOREGROUND_DEFAULT_TIMEOUT_MS,
): number {
  const base = argsTimeout && argsTimeout > 0 ? argsTimeout : defaultTimeoutMs;
  if (cls === 'short') return Math.min(base, SHORT_TIMEOUT_MAX_MS);
  return Math.min(base, MAX_COMMAND_YIELD_MS);
}

/**
 * 把 action:"check" 的等待时间钳到 Codex 空轮询区间：5 秒～5 分钟。
 * 未传、0 或非数字时用 fallback（默认顶满 5 分钟），这样模型漏写 timeout 也不会几秒轮询一次。
 */
export function clampCommandYieldMs(
  value: unknown,
  fallbackMs: number = MAX_COMMAND_YIELD_MS,
): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) {
    return fallbackMs;
  }
  return Math.min(MAX_COMMAND_YIELD_MS, Math.max(MIN_COMMAND_YIELD_MS, Math.round(value)));
}
