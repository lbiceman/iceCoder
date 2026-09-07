import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const publicRoot = path.join(__dirname, '../../src/public');

function readPublic(relativePath: string): string {
  return readFileSync(path.join(publicRoot, relativePath), 'utf-8');
}

describe('规划模式走 / 面板', () => {
  it('slash 列表含 /plan，模式标识在底部工具栏', () => {
    const commands = readPublic('js/chat-commands.js');
    const page = readPublic('js/chat-page.js');
    const main = readPublic('js/main.js');
    const welcome = readPublic('js/chat-welcome.js');

    expect(commands).toContain("name: 'plan'");
    expect(commands).toContain("cmd.name === 'shell' || cmd.name === 'plan'");
    expect(welcome).toContain('/plan');

    expect(page).not.toContain('chip-agent-mode');
    expect(page).not.toContain('ChatAgentModePicker');
    expect(main).not.toContain('chat-agent-mode-picker');

    expect(page).not.toContain('plan-mode-chip-bar');
    expect(page).not.toContain('shell-mode-chip-bar');
    expect(page).toContain('plan-mode-indicator');
    expect(page).toContain('plan模式');
    expect(page).toContain('shell-collab-indicator');
    expect(page).toContain('Shell协作');
  });
});
