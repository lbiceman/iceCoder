/**
 * Shell 命令运行时分类器。
 *
 * 把「长命令 / 短命令」分流决策从 LLM 迁移到运行时。
 *
 * - 'long'  → 应当后台启动，不设 hard timeout（Shell Dock 长驻）
 * - 'short' → 前台执行，timeout 上限收紧到 10s
 * - 'auto'  → 前台启动，超过 SOFT_TIMEOUT_MS 仍在跑则 escalate（Phase 2）
 *
 * 设计原则：零配置 — 全部白名单写死 const，不读 JSON / env / 命令行参数。
 */

/** 前台软超时：到达此时长仍在跑则 escalate 到后台（Phase 2 接入）。 */
export const SOFT_TIMEOUT_MS = 8_000;

/** 后台任务不设 hard timeout（0 = 不限时，仅用户 stop / 进程退出 / 应用关闭时结束）。 */
export const HARD_TIMEOUT_NONE = 0;

/** @deprecated 历史别名；后台任务现统一使用 HARD_TIMEOUT_NONE。 */
export const HARD_TIMEOUT_DEFAULT_MS = HARD_TIMEOUT_NONE;

/** @deprecated 历史别名；后台长驻任务现统一不限时。 */
export const HARD_TIMEOUT_LONG_MS = HARD_TIMEOUT_NONE;

/** 前台一次性命令默认 timeout — 10 分钟。 */
export const FOREGROUND_DEFAULT_TIMEOUT_MS = 10 * 60 * 1000;

/** 短命令前台 timeout 上限 — 10 秒。 */
export const SHORT_TIMEOUT_MAX_MS = 10_000;

/** Harness / chat-ws 推送后台摘要的最小间隔 — 5 分钟（Phase 4a/4b 接入）。 */
export const BG_SUMMARY_INTERVAL_MS = 5 * 60 * 1000;

/** 长命令特征 — 直接后台启动 */
const LONG_RUNNING: RegExp[] = [
  /^(npm|pnpm|yarn|bun)\s+(test|t\b|run\s+(test|dev|start|serve|preview|watch|build))/,
  /^(vitest|jest|playwright|cypress)\b(?!\s+--?(version|help))/,
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
 * 根据分类与显式 args.timeout 决定前台 timeout。
 *
 * - 'short' → min(argsTimeout ?? 10min, 10s)
 * - 其它 → argsTimeout ?? 10min
 */
export function pickForegroundTimeout(
  cls: ShellClass,
  argsTimeout: number | undefined,
  defaultTimeoutMs: number = FOREGROUND_DEFAULT_TIMEOUT_MS,
): number {
  const base = argsTimeout && argsTimeout > 0 ? argsTimeout : defaultTimeoutMs;
  if (cls === 'short') return Math.min(base, SHORT_TIMEOUT_MAX_MS);
  return base;
}
