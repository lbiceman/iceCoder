import { randomUUID } from 'node:crypto';

import type {
  RepoContextSnapshot,
  TaskStateSnapshot,
} from '../../types/runtime-snapshot.js';
import type { WorkspaceSnapshot } from '../../types/supervisor.js';

/**
 * §8.4 WorkspaceStateExtractor —— takeover 前扫描当前工作区。
 *
 * V1：纯启发式拼接（**无 LLM**）。输入是 Harness 已有的 RepoContext / TaskState 摘要
 * 与最近一次工具命令产出，输出 §10 恢复主路径所需 `WorkspaceSnapshot`，供 §8.5
 * SnapshotConfidenceEvaluator、§8.7 RetrospectiveGraphBuilder 与 checkpoint 持久化消费。
 *
 * 实现约束：
 *   - 不发起任何 IO；只接受调用方注入的 build/test/lint 摘要字符串；
 *   - 拼接 `gitSummary` 时仅使用 RepoContext `filesChanged/recentDiagnostics`；
 *   - `snapshotId` 由 `now()` + 短随机串构成，便于 timeline 关联；
 *   - 不读环境变量；mode-controller / bridge 决定何时调用本提取器。
 *
 * V2 可扩展为接入轻量 LLM 写 `semanticSummary`；本类不预绑定该路径。
 */

export interface WorkspaceStateExtractorInput {
  task: TaskStateSnapshot;
  repo: RepoContextSnapshot;
  /** 最近一次构建（`npm run build` / `tsc` 等）摘要；可选。 */
  buildSummary?: string;
  /** 最近一次测试结果摘要；可选。 */
  testSummary?: string;
  /** 最近一次 lint 结果摘要；可选。 */
  lintSummary?: string;
  /** 注入时间戳（测试可控）。 */
  now?: () => number;
  /** 注入 snapshotId（测试可控）。 */
  snapshotId?: string;
  /**
   * Git 工作区简述（如 `clean` / `M src/foo.ts` / `??  new.ts`）；
   * 若未提供，则由 RepoContext.filesChanged 推导一个合并的 `M:n` 字串。
   */
  gitSummary?: string;
  /**
   * 已知存在但本轮未变更的文件，用于 `filesAdded` 的「确实新增」判定；
   * 通常由 RepoContext 与初始任务 snapshot 的差集得出，可选。
   */
  preExistingFiles?: string[];
}

export class WorkspaceStateExtractor {
  /**
   * 同步提取；调用方负责保证输入摘要稳定。
   * 失败也不抛错（返回最小可用 snapshot），由 SnapshotConfidence 自行降分。
   */
  extract(input: WorkspaceStateExtractorInput): WorkspaceSnapshot {
    const now = (input.now ?? Date.now)();
    const snapshotId = input.snapshotId ?? `snap-${now}-${shortRand()}`;
    const { added, modified, deleted } = classifyFiles(input);

    return {
      snapshotId,
      at: now,
      gitSummary: input.gitSummary ?? deriveGitSummary(input.repo),
      filesAdded: added,
      filesModified: modified,
      filesDeleted: deleted,
      buildSummary: input.buildSummary,
      testSummary: input.testSummary ?? deriveTestSummary(input.task),
      lintSummary: input.lintSummary,
    };
  }
}

export function createWorkspaceStateExtractor(): WorkspaceStateExtractor {
  return new WorkspaceStateExtractor();
}

function classifyFiles(input: WorkspaceStateExtractorInput): {
  added: string[];
  modified: string[];
  deleted: string[];
} {
  const changed = new Set([...input.task.filesChanged, ...input.repo.filesChanged]);
  const known = new Set(input.preExistingFiles ?? input.task.filesRead);

  const added: string[] = [];
  const modified: string[] = [];
  for (const file of changed) {
    if (known.size > 0 && !known.has(file)) {
      added.push(file);
    } else {
      modified.push(file);
    }
  }
  // V1 不区分 deleted；保留位以兼容 §8.4 接口。
  return { added, modified, deleted: [] };
}

function deriveGitSummary(repo: RepoContextSnapshot): string {
  if (repo.filesChanged.length === 0 && repo.recentDiagnostics.length === 0) {
    return 'clean';
  }
  const head = repo.filesChanged.length > 0
    ? `M:${repo.filesChanged.length}`
    : 'M:0';
  if (repo.recentDiagnostics.length === 0) return head;
  return `${head} diag:${repo.recentDiagnostics.length}`;
}

function deriveTestSummary(task: TaskStateSnapshot): string | undefined {
  if (task.verificationStatus === 'passed') return 'passed';
  if (task.verificationStatus === 'failed') return 'failed';
  if (task.verificationStatus === 'required') return 'required';
  return undefined;
}

function shortRand(): string {
  // 截短 uuid 仅作 id 拼接用途；不参与签名。
  return randomUUID().slice(0, 8);
}
