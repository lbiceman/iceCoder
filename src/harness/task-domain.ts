import type { TaskIntent } from '../types/runtime-snapshot.js';
import type { TaskDomain } from '../types/supervisor.js';
import { isLongRunningImplementationGoal } from './resume-goal.js';

/**
 * 由 TaskIntent 映射 TaskDomain（§5 / 附录 A）。
 * 仅用于 Supervisor 观测与 takeover 候选；不驱动 ExecutionMode 切换。
 */
export function inferTaskDomain(intent: TaskIntent, goal?: string): TaskDomain {
  if (goal && isLongRunningImplementationGoal(goal)) {
    switch (intent) {
      case 'debug':
        return 'critical_debug';
      case 'test':
        return 'critical_test';
      case 'refactor':
        return 'critical_refactor';
      default:
        return 'critical_edit';
    }
  }

  switch (intent) {
    case 'edit':
      return 'critical_edit';
    case 'debug':
      return 'critical_debug';
    case 'test':
      return 'critical_test';
    case 'refactor':
      return 'critical_refactor';
    case 'docs':
      return 'non_critical_docs';
    case 'inspect':
      return 'non_critical_read';
    case 'question':
    default:
      return 'non_critical_explain';
  }
}
