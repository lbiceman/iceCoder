import { createInterface } from 'node:readline';
import type { ShellMandatoryConfirmRequest } from '../../harness/harness-permission-runtime.js';
import { c } from './terminal-ui.js';

export interface CliConfirmSpinner {
  stop: () => void;
}

function promptYesNo(question: string): Promise<boolean> {
  return new Promise<boolean>((resolve) => {
    const confirmRl = createInterface({ input: process.stdin, output: process.stdout });
    confirmRl.question(question, (answer) => {
      confirmRl.close();
      resolve(answer.toLowerCase() === 'y' || answer.toLowerCase() === 'yes');
    });
  });
}

/** 终端版普通工具确认（destructive / permission confirm）。 */
export function createCliOnConfirm(spinner?: CliConfirmSpinner) {
  return async (toolName: string, toolArgs: Record<string, unknown>): Promise<boolean> => {
    spinner?.stop();
    const detail = toolName.includes('(') ? '' : ` (${JSON.stringify(toolArgs).substring(0, 80)})`;
    console.log(`\n${c.yellow}⚠ 需要确认: ${toolName}${detail}${c.reset}`);
    return promptYesNo(`${c.yellow}允许执行? (y/n) ${c.reset}`);
  };
}

/** 终端版 Shell mandatory confirm（命中强制确认规则，不可被 skip 绕过）。 */
export function createCliOnShellMandatoryConfirm(spinner?: CliConfirmSpinner) {
  return async (request: ShellMandatoryConfirmRequest): Promise<boolean> => {
    spinner?.stop();
    const lines = [
      `Session: ${request.sessionId}`,
      `命令: ${request.commandDisplay}`,
      `命中规则: ${request.risk.matchedPattern}`,
      `风险类别: ${request.risk.category}`,
      `影响: ${request.risk.impact}`,
      '',
      '此确认不会被「跳过权限确认」设置绕过。',
    ];
    console.log(`\n${c.yellow}⚠ Shell 敏感命令确认${c.reset}`);
    console.log(lines.join('\n'));
    return promptYesNo(`${c.yellow}确认执行? (y/n) ${c.reset}`);
  };
}
