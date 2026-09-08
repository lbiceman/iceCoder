/**
 * 可选分段计时（仅 `ICE_HARNESS_TIMING=1` 时工作）。
 *
 * **硬规则：** 未开启时所有导出函数必须立刻 no-op / 直通，
 * 不得采样、不得写 samples、不得打日志、不得为计时调用 `performance.now()`。
 * 调用方应使用 `markTimingStart` / `endTiming` / `timeSync` / `timeAsync`，
 * 不要在关闭时自行取墙钟再传给 `recordHarnessTiming`。
 */

export interface HarnessTimingSample {
  name: string;
  ms: number;
  round?: number;
}

const samples: HarnessTimingSample[] = [];

export function harnessTimingEnabled(): boolean {
  return process.env.ICE_HARNESS_TIMING === '1';
}

export function resetHarnessTiming(): void {
  if (!harnessTimingEnabled()) return;
  samples.length = 0;
}

/** 开启时返回 `performance.now()`；关闭时返回 0 且不读时钟。 */
export function markTimingStart(): number {
  if (!harnessTimingEnabled()) return 0;
  return performance.now();
}

/** 开启时记录 `now - startedAt`；关闭时整段跳过。 */
export function endTiming(name: string, startedAt: number, round?: number): void {
  if (!harnessTimingEnabled()) return;
  recordHarnessTiming(name, performance.now() - startedAt, round);
}

export function recordHarnessTiming(name: string, ms: number, round?: number): void {
  if (!harnessTimingEnabled()) return;
  const sample: HarnessTimingSample = { name, ms };
  if (round != null) sample.round = round;
  samples.push(sample);
  const roundLabel = round != null ? ` r${round}` : '';
  console.log(`[timing] ${name}${roundLabel}: ${ms.toFixed(1)}ms`);
}

export function timeSync<T>(name: string, fn: () => T, round?: number): T {
  if (!harnessTimingEnabled()) return fn();
  const t0 = performance.now();
  try {
    return fn();
  } finally {
    recordHarnessTiming(name, performance.now() - t0, round);
  }
}

export async function timeAsync<T>(name: string, fn: () => Promise<T>, round?: number): Promise<T> {
  if (!harnessTimingEnabled()) return fn();
  const t0 = performance.now();
  try {
    return await fn();
  } finally {
    recordHarnessTiming(name, performance.now() - t0, round);
  }
}

export function getHarnessTimingSamples(): HarnessTimingSample[] {
  if (!harnessTimingEnabled()) return [];
  return [...samples];
}

/** 本地代码（不含等待 LLM HTTP / 工具执行）相关 phase 名。 */
const CODE_PHASES = new Set([
  'run_init',
  'round_prep',
  'prep_compact',
  'prep_memory',
  'prep_build_msgs',
  'graph_stop_check',
  'mode_eval',
  'context_usage',
  'llm_precheck',
  'llm_serialize',
  'llm_deserialize',
  'llm_stream_filter',
  'post_salvage',
  'post_no_tools',
  'post_supervisor',
]);

export function summarizeHarnessTiming(): {
  samples: HarnessTimingSample[];
  runTotalMs: number;
  roundWallMs: number;
  codeMs: number;
  waitLlmMs: number;
  waitToolMs: number;
  codePctOfRun: number;
  codePctOfRound: number;
} {
  if (!harnessTimingEnabled()) {
    return {
      samples: [],
      runTotalMs: 0,
      roundWallMs: 0,
      codeMs: 0,
      waitLlmMs: 0,
      waitToolMs: 0,
      codePctOfRun: 0,
      codePctOfRound: 0,
    };
  }
  const runTotalMs = sumByName('run_total');
  const roundWallMs = sumByName('round_wall');
  const httpMs = sumByName('llm_http');
  const waitMs = sumByName('llm_wait');
  // 优先用 HTTP 墙钟：适配器序列化算「代码」而不是「等模型」
  const waitLlmMs = httpMs > 0 ? httpMs : waitMs;
  const waitToolMs = sumByName('tool_round');
  const codeFromPhases = samples
    .filter((s) => CODE_PHASES.has(s.name))
    .reduce((acc, s) => acc + s.ms, 0);
  const codeMs = roundWallMs > 0
    ? Math.max(0, roundWallMs - waitLlmMs - waitToolMs)
    : codeFromPhases;
  const denomRun = runTotalMs > 0 ? runTotalMs : roundWallMs;
  const runCodeMs = denomRun > 0 ? Math.max(0, denomRun - waitLlmMs - waitToolMs) : codeMs;
  const codePctOfRun = denomRun > 0 ? (runCodeMs / denomRun) * 100 : 0;
  const codePctOfRound = roundWallMs > 0 ? (codeMs / roundWallMs) * 100 : 0;
  return {
    samples: getHarnessTimingSamples(),
    runTotalMs,
    roundWallMs,
    codeMs,
    waitLlmMs,
    waitToolMs,
    codePctOfRun,
    codePctOfRound,
  };
}

export function dumpHarnessTiming(): void {
  if (!harnessTimingEnabled()) return;
  const s = summarizeHarnessTiming();
  console.log(
    `[timing] summary: run=${s.runTotalMs.toFixed(0)}ms round=${s.roundWallMs.toFixed(0)}ms `
    + `round_code=${s.codeMs.toFixed(1)}ms (${s.codePctOfRound.toFixed(1)}% of round) `
    + `run_code=${(s.runTotalMs - s.waitLlmMs - s.waitToolMs).toFixed(1)}ms (${s.codePctOfRun.toFixed(1)}% of run) `
    + `llm_http=${s.waitLlmMs.toFixed(0)}ms tool=${s.waitToolMs.toFixed(0)}ms`,
  );
}

function sumByName(name: string): number {
  return samples.filter((s) => s.name === name).reduce((acc, s) => acc + s.ms, 0);
}
