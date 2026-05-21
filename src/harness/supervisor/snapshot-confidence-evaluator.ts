import type {
  SnapshotConfidenceConfig,
  SnapshotConfidenceInput,
} from '../../types/supervisor.js';

/**
 * §8.5 SnapshotConfidenceEvaluator —— 评估 WorkspaceSnapshot 的可信度，结果 ∈ [0, 1]。
 *
 * V1 计算因子（启发式，加权求和；权重写入 supervisor-config.json `snapshotConfidence.*`）：
 *   | 因子                 | 默认权重 | 说明                                                                |
 *   |---------------------|---------|--------------------------------------------------------------------|
 *   | gitClean            | 0.25    | gitSummary 形如 `clean`/`M:0`，或 filesModified/Added 集合为空     |
 *   | snapshotAge         | 0.15    | roundsSinceExtract <= 1 → 满分；线性衰减至 ≥5 轮归零              |
 *   | verifyPassed        | 0.20    | lastVerifyPassed=true 时满分                                       |
 *   | repoContextMatch    | 0.25    | repoFilesChanged ⊆ snapshot.filesModified∪filesAdded 时满分        |
 *   | buildSignal         | 0.15    | buildSummary 不含 fail/error，testSummary 不为 failed              |
 *
 * 阈值：`templateGraphMin`（默认 0.65）。低于阈值由调用方（RecoverySupervisor）禁止
 * 走 §19.2 一级模板图；可走二级强提示（不建图，但 forced 不回落 free）。
 *
 * 实现约束：
 *   - 纯函数；不读环境变量、不读磁盘；
 *   - 权重缺失时回退到上表默认值；权重和被显式归一化到 1，避免配置漂移；
 *   - 任一信号缺失（undefined）按 0.5 中性分计入，避免「无信号 = 一定低分」。
 */

const DEFAULT_WEIGHTS: Required<Omit<SnapshotConfidenceConfig, 'templateGraphMin'>> = {
  weightGitClean: 0.25,
  weightSnapshotAge: 0.15,
  weightVerifyPassed: 0.2,
  weightRepoContextMatch: 0.25,
  weightBuildSignal: 0.15,
};

const NEUTRAL_SCORE = 0.5;

export interface SnapshotConfidenceResult {
  /** 综合分 ∈ [0, 1]。 */
  confidence: number;
  /** 是否达到 `templateGraphMin`，true 即允许走 §19.2 一级模板图。 */
  meetsTemplateGraphThreshold: boolean;
  /** 各因子归一化分；便于 timeline / UI 排查。 */
  factors: {
    gitClean: number;
    snapshotAge: number;
    verifyPassed: number;
    repoContextMatch: number;
    buildSignal: number;
  };
}

export class SnapshotConfidenceEvaluator {
  private readonly config: SnapshotConfidenceConfig;

  constructor(config: SnapshotConfidenceConfig) {
    this.config = config;
  }

  evaluate(input: SnapshotConfidenceInput): SnapshotConfidenceResult {
    const weights = normalizedWeights(this.config);
    const factors = {
      gitClean: scoreGitClean(input),
      snapshotAge: scoreSnapshotAge(input),
      verifyPassed: scoreVerifyPassed(input),
      repoContextMatch: scoreRepoContextMatch(input),
      buildSignal: scoreBuildSignal(input),
    };

    const confidence = clamp01(
      factors.gitClean * weights.weightGitClean +
        factors.snapshotAge * weights.weightSnapshotAge +
        factors.verifyPassed * weights.weightVerifyPassed +
        factors.repoContextMatch * weights.weightRepoContextMatch +
        factors.buildSignal * weights.weightBuildSignal,
    );

    return {
      confidence,
      meetsTemplateGraphThreshold: confidence >= this.config.templateGraphMin,
      factors,
    };
  }

  /** 暴露给外部模块（如 RetrospectiveGraphBuilder）用于复用阈值判断。 */
  getTemplateGraphMin(): number {
    return this.config.templateGraphMin;
  }
}

export function createSnapshotConfidenceEvaluator(
  config: SnapshotConfidenceConfig,
): SnapshotConfidenceEvaluator {
  return new SnapshotConfidenceEvaluator(config);
}

function normalizedWeights(
  config: SnapshotConfidenceConfig,
): Required<Omit<SnapshotConfidenceConfig, 'templateGraphMin'>> {
  const raw = {
    weightGitClean: config.weightGitClean ?? DEFAULT_WEIGHTS.weightGitClean,
    weightSnapshotAge: config.weightSnapshotAge ?? DEFAULT_WEIGHTS.weightSnapshotAge,
    weightVerifyPassed: config.weightVerifyPassed ?? DEFAULT_WEIGHTS.weightVerifyPassed,
    weightRepoContextMatch:
      config.weightRepoContextMatch ?? DEFAULT_WEIGHTS.weightRepoContextMatch,
    weightBuildSignal: config.weightBuildSignal ?? DEFAULT_WEIGHTS.weightBuildSignal,
  };
  const sum =
    raw.weightGitClean +
    raw.weightSnapshotAge +
    raw.weightVerifyPassed +
    raw.weightRepoContextMatch +
    raw.weightBuildSignal;
  if (sum <= 0) return { ...DEFAULT_WEIGHTS };
  return {
    weightGitClean: raw.weightGitClean / sum,
    weightSnapshotAge: raw.weightSnapshotAge / sum,
    weightVerifyPassed: raw.weightVerifyPassed / sum,
    weightRepoContextMatch: raw.weightRepoContextMatch / sum,
    weightBuildSignal: raw.weightBuildSignal / sum,
  };
}

function scoreGitClean(input: SnapshotConfidenceInput): number {
  const summary = input.snapshot.gitSummary?.toLowerCase().trim() ?? '';
  if (!summary) return NEUTRAL_SCORE;
  if (summary === 'clean' || summary === 'm:0') return 1;
  const totalChanges = input.snapshot.filesAdded.length + input.snapshot.filesModified.length;
  if (totalChanges === 0) return 0.9;
  if (totalChanges <= 3) return 0.7;
  if (totalChanges <= 8) return 0.4;
  return 0.2;
}

function scoreSnapshotAge(input: SnapshotConfidenceInput): number {
  const r = Math.max(0, input.roundsSinceExtract);
  if (r <= 1) return 1;
  if (r >= 5) return 0;
  return 1 - (r - 1) / 4;
}

function scoreVerifyPassed(input: SnapshotConfidenceInput): number {
  if (input.lastVerifyPassed === true) return 1;
  if (input.snapshot.testSummary === 'passed') return 1;
  if (input.snapshot.testSummary === 'failed') return 0;
  return NEUTRAL_SCORE;
}

function scoreRepoContextMatch(input: SnapshotConfidenceInput): number {
  const repoChanged = input.repoFilesChanged ?? [];
  if (repoChanged.length === 0) return NEUTRAL_SCORE;

  const known = new Set([...input.snapshot.filesAdded, ...input.snapshot.filesModified]);
  let hits = 0;
  for (const file of repoChanged) {
    if (known.has(file)) hits += 1;
  }
  return hits / repoChanged.length;
}

function scoreBuildSignal(input: SnapshotConfidenceInput): number {
  const build = input.snapshot.buildSummary?.toLowerCase() ?? '';
  const test = input.snapshot.testSummary?.toLowerCase() ?? '';
  if (build.includes('fail') || build.includes('error')) return 0;
  if (test === 'failed') return 0;
  if (build.includes('pass') || build.includes('ok')) return 1;
  if (test === 'passed') return 0.9;
  return NEUTRAL_SCORE;
}

function clamp01(v: number): number {
  if (!Number.isFinite(v)) return 0;
  if (v < 0) return 0;
  if (v > 1) return 1;
  return v;
}
