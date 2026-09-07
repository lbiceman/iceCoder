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
  it('slash 列表含 /plan，工具栏不再放模式 chip', () => {
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

    expect(page).toContain('plan-mode-chip-bar');
    expect(page).toContain('btn-plan-mode-exit');
    expect(page).toContain("type: 'plan_mode_exit'");
    expect(page).toContain('shell-mode-chip-bar');
    expect(page).toContain('shell-mode-chip-label');
  });
});
