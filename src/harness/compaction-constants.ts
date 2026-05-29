/**
 * 上下文压缩触发常量（全模型通用，写死在代码中）。
 *
 * 窗口来源：readEffectiveContextWindowTokens()（当前 provider 的 maxContextTokens）。
 * 占用来源：max(本地估算 + tools schema, 上一轮 API prompt_tokens)。
 */

/** 硬压缩：占用 ≥ 窗口 × 此比例 */
export const HARD_COMPACTION_RATIO = 0.85;

/** 微压缩：占用 ≥ 窗口 × 此比例（且尚未达到硬压缩线） */
export const MICRO_COMPACTION_RATIO = 0.72;

/** 剩余 token 低于此值时触发硬压缩 */
export const COMPACTION_RESERVE_TOKENS = 18_000;

/** 占用 ≥ 窗口 × 此比例且常规压缩后仍过高 → 主动 aggressive fork */
export const PROACTIVE_FORK_RATIO = 0.93;

/** 每轮 prep 最多 1 次微压缩 */
export const MICRO_MAX_PER_ROUND = 1;

/** 单会话微压缩累计上限 */
export const MICRO_MAX_PER_SESSION = 24;

/** 微压缩节省低于占用 × 此比例 → 同轮升档硬压缩 */
export const MICRO_MIN_SAVINGS_RATIO = 0.05;
