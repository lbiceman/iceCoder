import type { SupervisorMode } from '../../types/supervisor.js';

/**
 * 三档监管各自做什么。CLI / Web 默认是 adaptive。
 *
 * - off：不切换 free / forced，不建任务图。
 * - adaptive：按进展切换 free / forced，BranchBudget 跟着收紧。不建任务图，
 *   所以进入 forced 后 ToolGate 没有步骤提示，不会按步骤拦工具。
 * - strict：下限就是 forced。工程任务（edit / debug / test / refactor）建任务图，
 *   ToolGate 会按当前步骤拦住不合步骤的工具。
 */
export interface SupervisorModeContract {
  mode: SupervisorMode;
  label: string;
  /** 欢迎页和切换按钮用的一句说明。 */
  summary: string;
  /** 是否启用 ExecutionMode，并让 BranchBudget 跟着模式收紧。 */
  usesExecutionMode: boolean;
  /** 工程任务是否建任务图。没建图时，forced 的 ToolGate 不会按步骤拦工具。 */
  buildsTaskGraph: boolean;
}

export const SUPERVISOR_MODE_CONTRACT: Record<SupervisorMode, SupervisorModeContract> = {
  off: {
    mode: 'off',
    label: '自由',
    summary: '不切换执行档，不建任务图',
    usesExecutionMode: false,
    buildsTaskGraph: false,
  },
  adaptive: {
    mode: 'adaptive',
    label: '自适应',
    summary: '按进展在自由和强制之间切换，并收紧写预算；不建任务图，强制时不按步骤拦工具',
    usesExecutionMode: true,
    buildsTaskGraph: false,
  },
  strict: {
    mode: 'strict',
    label: '严格',
    summary: '保持强制。工程任务会建任务图，不合当前步骤的工具会被拦住',
    usesExecutionMode: true,
    buildsTaskGraph: true,
  },
};

export function supervisorModeContract(mode: SupervisorMode | undefined): SupervisorModeContract {
  if (mode === 'off' || mode === 'adaptive' || mode === 'strict') {
    return SUPERVISOR_MODE_CONTRACT[mode];
  }
  return SUPERVISOR_MODE_CONTRACT.adaptive;
}

export function supervisorModeBuildsTaskGraph(mode: SupervisorMode | undefined): boolean {
  return supervisorModeContract(mode).buildsTaskGraph;
}
