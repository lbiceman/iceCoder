/**
 * interactive-shell-prompt-detect 单元测试（任务 1.3）
 */

import { describe, expect, it } from 'vitest';
import {
  detectPromptInTail,
  DEFAULT_PROMPT_PATTERNS,
} from '../../src/tools/interactive-shell-prompt-detect.js';

describe('detectPromptInTail', () => {
  it('检测 Password: 提示', () => {
    const r = detectPromptInTail('Connecting...\r\nuser@host password: ');
    expect(r.awaitingInput).toBe(true);
    expect(r.promptHint).toBe('password');
    expect(r.promptText).toMatch(/password/i);
  });

  it('检测 请输入密码（T3）', () => {
    const r = detectPromptInTail('some output\n请输入密码: ');
    expect(r.awaitingInput).toBe(true);
    expect(r.promptHint).toBe('password');
    expect(r.promptText).toMatch(/请输入密码/);
  });

  it('检测 read -p "请输入密码:" 输出', () => {
    const r = detectPromptInTail('bash$ read -p "请输入密码:" pwd\n请输入密码: ');
    expect(r.awaitingInput).toBe(true);
    expect(r.promptHint).toBe('password');
  });

  it('检测 (yes/no) 提示', () => {
    const r = detectPromptInTail('Proceed with install? (yes/no): ');
    expect(r.awaitingInput).toBe(true);
    expect(r.promptHint).toBe('yes_no');
  });

  it('检测 [sudo] password', () => {
    const r = detectPromptInTail('[sudo] password for alice: ');
    expect(r.awaitingInput).toBe(true);
    expect(r.promptHint).toBe('password');
  });

  it('检测 Passphrase for key', () => {
    const r = detectPromptInTail('Enter passphrase for key \'/home/u/.ssh/id_rsa\': ');
    expect(r.awaitingInput).toBe(true);
    expect(r.promptHint).toBe('passphrase');
  });

  it('普通命令输出不误触', () => {
    const r = detectPromptInTail('total 42\ndrwxr-xr-x  5 user user 4096 Aug  6 10:00 .\n');
    expect(r.awaitingInput).toBe(false);
    expect(r.promptHint).toBeNull();
  });

  it('仅扫描尾部窗口', () => {
    const head = 'x'.repeat(3000);
    const r = detectPromptInTail(`${head}\n请输入密码: `);
    expect(r.awaitingInput).toBe(true);
    expect(r.promptHint).toBe('password');
  });

  it('支持自定义 patterns', () => {
    const r = detectPromptInTail('PIN code:', [{ re: /PIN code:/i, hint: 'pin' }]);
    expect(r.awaitingInput).toBe(true);
    expect(r.promptHint).toBe('pin');
  });

  it('DEFAULT_PROMPT_PATTERNS 非空且有序', () => {
    expect(DEFAULT_PROMPT_PATTERNS.length).toBeGreaterThan(0);
    const passwordIdx = DEFAULT_PROMPT_PATTERNS.findIndex((p) => p.hint === 'password');
    const textIdx = DEFAULT_PROMPT_PATTERNS.findIndex((p) => p.re.source.includes('请输入') && p.hint === 'text');
    expect(passwordIdx).toBeGreaterThanOrEqual(0);
    expect(textIdx).toBeGreaterThan(passwordIdx);
  });
});
