import type { WorkspaceSnapshot } from '../../types/supervisor.js';

/**
 * §8.6 RecoverySafetyChecker —— 判断当前工作区是否可安全恢复。
 *
 * 检查项（规格 §8.6）：
 *   - 关键文件丢失：调用方注入 `criticalFiles` 列表 + `existingFiles` 集合；
 *   - repo 状态损坏：`repoHealthy=false` 或 `gitSummary` 标记冲突；
 *   - branch 异常：调用方 `branchHealthy=false`（合并冲突、detached HEAD 等）；
 *   - 编译基线损坏：`baselineBroken=true` 或 buildSummary 包含 fatal 关键字。
 *
 * 输出 `recoverable`（布尔）+ `reasons[]`（机器可读）+ `humanReason`（一行文本）。
 *
 * V1 约束：
 *   - 不做 IO；由调用方（通常是 RecoverySupervisor / Bridge）从 RepoContext / Git 工具
 *     已有结果中聚合 input；
 *   - `criticalFiles` 缺省（undefined）视为「不做关键文件检查」，避免假阳性。
 */

const REPO_BROKEN_MARKERS = ['conflict', 'detached', 'rebase', 'merge', 'unmerged'];
const BUILD_FATAL_MARKERS = ['fatal', 'crash', 'panic', 'segfault'];

export type RecoverySafetyReason =
  | 'critical_file_missing'
  | 'repo_unhealthy'
  | 'branch_unhealthy'
  | 'baseline_broken';

export interface RecoverySafetyCheckResult {
  recoverable: boolean;
  reasons: RecoverySafetyReason[];
  /** 关键文件缺失时的具体路径，便于 timeline / UI 显示。 */
  missingFiles: string[];
  humanReason: string;
}

export interface RecoverySafetyCheckInput {
  snapshot: WorkspaceSnapshot;
  /** 由调用方裁定的关键文件清单；缺省/空数组表示跳过该检查。 */
  criticalFiles?: string[];
  /** 当前 workspace 仍然存在的文件集合；用于关键文件丢失判定。 */
  existingFiles?: string[];
  /** 显式注入 repo 健康度；默认根据 snapshot.gitSummary 推断。 */
  repoHealthy?: boolean;
  /** 显式注入 branch 健康度；默认 true。 */
  branchHealthy?: boolean;
  /** 显式注入编译基线是否已损坏；默认根据 buildSummary 推断。 */
  baselineBroken?: boolean;
}

export class RecoverySafetyChecker {
  check(input: RecoverySafetyCheckInput): RecoverySafetyCheckResult {
    const reasons: RecoverySafetyReason[] = [];
    const missingFiles = findMissingCriticalFiles(input);
    if (missingFiles.length > 0) reasons.push('critical_file_missing');

    if (!isRepoHealthy(input)) reasons.push('repo_unhealthy');
    if (input.branchHealthy === false) reasons.push('branch_unhealthy');
    if (isBaselineBroken(input)) reasons.push('baseline_broken');

    return {
      recoverable: reasons.length === 0,
      reasons,
      missingFiles,
      humanReason: formatReasons(reasons, missingFiles),
    };
  }
}

export function createRecoverySafetyChecker(): RecoverySafetyChecker {
  return new RecoverySafetyChecker();
}

function findMissingCriticalFiles(input: RecoverySafetyCheckInput): string[] {
  const required = input.criticalFiles;
  if (!required || required.length === 0) return [];
  if (input.existingFiles === undefined) {
    // existingFiles 未注入 → 调用方没准备好做判定，不误报缺失。
    return [];
  }
  const existing = new Set(input.existingFiles);
  const missing: string[] = [];
  for (const file of required) {
    if (!existing.has(file)) missing.push(file);
  }
  return missing;
}

function isRepoHealthy(input: RecoverySafetyCheckInput): boolean {
  if (typeof input.repoHealthy === 'boolean') return input.repoHealthy;
  const summary = (input.snapshot.gitSummary ?? '').toLowerCase();
  if (!summary) return true;
  return !REPO_BROKEN_MARKERS.some((marker) => summary.includes(marker));
}

function isBaselineBroken(input: RecoverySafetyCheckInput): boolean {
  if (typeof input.baselineBroken === 'boolean') return input.baselineBroken;
  const build = (input.snapshot.buildSummary ?? '').toLowerCase();
  if (!build) return false;
  return BUILD_FATAL_MARKERS.some((marker) => build.includes(marker));
}

function formatReasons(
  reasons: RecoverySafetyReason[],
  missingFiles: string[],
): string {
  if (reasons.length === 0) return 'ok';
  const parts = reasons.map((reason) => {
    if (reason === 'critical_file_missing' && missingFiles.length > 0) {
      const list = missingFiles.slice(0, 3).join(',');
      const suffix = missingFiles.length > 3 ? `+${missingFiles.length - 3}` : '';
      return `critical_file_missing:${list}${suffix}`;
    }
    return reason;
  });
  return parts.join('|');
}
