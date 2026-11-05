import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(__dirname, '../..');

function read(relativePath: string): string {
  return readFileSync(path.join(root, relativePath), 'utf-8');
}

describe('规划改为 Agent 命令', () => {
  it('slash 列不再内置 /plan，输入栏用 Agent 芯片退出', () => {
    const commands = read('src/public/js/chat-commands.ts');
    const page = read('src/public/js/chat-page.ts');
    const store = read('src/agents/agent-store.ts');

    expect(commands).not.toContain("name: 'plan'");
    expect(commands).toContain('refreshAgents');
    expect(page).toContain('agent-mode-indicator');
    expect(page).toContain("type: 'agent_mode_exit'");
    expect(page).not.toContain('plan-mode-chip-bar');
    expect(page).not.toContain("type: 'plan_mode_exit'");
    expect(store).toContain('PLAN_AGENT_ID');
    expect(store).toContain('ensureDefaultPlanAgent');
  });
});
