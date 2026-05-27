/**
 * Shell 命令运行时分类器。
 *
 * 把「长命令 / 短命令」分流决策从 LLM 迁移到运行时。
 *
 * - 'long'  → 应当后台启动，hard timeout 给 24h
 * - 'short' → 前台执行，timeout 上限收紧到 10s
 * - 'auto'  → 前台启动，超过 SOFT_TIMEOUT_MS 仍在跑则 escalate（Phase 2）
 *
 * 设计原则：零配置 — 全部白名单写死 const，不读 JSON / env / 命令行参数。
 */

/** 前台软超时：到达此时长仍在跑则 escalate 到后台（Phase 2 接入）。 */
export const SOFT_TIMEOUT_MS = 8_000;

/** 后台默认 hard timeout — 5 分钟，沿用现状以兼容 explicit background:true。 */
export const HARD_TIMEOUT_DEFAULT_MS = 5 * 60 * 1000;

/** classifier 判 long / escalate 后的 hard timeout — 24 小时。 */
export const HARD_TIMEOUT_LONG_MS = 24 * 60 * 60 * 1000;

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
 * 优先级：
 * 1. explicit === 'background' → 沿用 5min（兼容显式 background:true）
 * 2. classifier === 'long' → 24h
 * 3. classifier === 'auto' 但被 escalate → 24h（Phase 2 调用方决定）
 * 4. 其它 → 5min
 */
export function pickBackgroundHardTimeout(
  cls: ShellClass,
  options: { explicitBackground?: boolean } = {},
): number {
  if (cls === 'long') return HARD_TIMEOUT_LONG_MS;
  if (options.explicitBackground) return HARD_TIMEOUT_DEFAULT_MS;
  return HARD_TIMEOUT_DEFAULT_MS;
}

/**
 * 根据分类与显式 args.timeout 决定前台 timeout。
 *
 * - 'short' → min(argsTimeout ?? 30s, 10s)
 * - 其它 → argsTimeout ?? 30s
 */
export function pickForegroundTimeout(
  cls: ShellClass,
  argsTimeout: number | undefined,
  defaultTimeoutMs: number = 30_000,
): number {
  const base = argsTimeout && argsTimeout > 0 ? argsTimeout : defaultTimeoutMs;
  if (cls === 'short') return Math.min(base, SHORT_TIMEOUT_MAX_MS);
  return base;
}
