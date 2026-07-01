/**
 * intent-checkpoint 回合快照「按会话隔离」测试（P1-10）。
 *
 * 此前 activeTurn 为单个全局变量：第二个并发会话 begin 后会覆盖第一个，
 * 导致第一个会话的写前快照被丢弃（挂错会话）。改为按 sessionId 维护后，
 * 两个并发会话的写前快照应各自记入正确的归档。
 *
 * 关键：用户消息文本不提及文件名，避免 captureIntentCheckpoint 通过文本提示
 * 预先把文件纳入 workspaceFiles，从而让断言只反映「回合写前快照」的行为。
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';

import { captureIntentCheckpoint } from '../../src/harness/intent-checkpoint-capture.js';
import { loadIntentCheckpoint } from '../../src/harness/intent-checkpoint-store.js';
import {
  beginIntentCheckpointTurn,
  capturePreTurnWriteSnapshot,
  finalizeIntentCheckpointTurn,
  clearIntentCheckpointTurnsForSession,
} from '../../src/harness/intent-checkpoint-turn-snapshot.js';

let tmp: string;

async function setupSessionCheckpoint(sessionId: string, messageId: string): Promise<void> {
  await captureIntentCheckpoint({
    sessionDir: tmp,
    sessionId,
    messageId,
    userMessageTime: 1000,
    workspaceRoot: tmp,
    workspaceState: { referenceReads: [], changeCount: 0 },
    structuredMessages: [{ role: 'user', content: '请处理任务' }],
    uiMessages: [{ role: 'user', content: '请处理任务', id: messageId, sentAt: 1000 }],
  });
}

beforeEach(async () => {
  tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'ice-turn-session-'));
});

afterEach(async () => {
  clearIntentCheckpointTurnsForSession('sessA');
  clearIntentCheckpointTurnsForSession('sessB');
  await fs.rm(tmp, { recursive: true, force: true }).catch(() => {});
});

describe('intent-checkpoint turn snapshot per-session isolation', () => {
  it('captures pre-turn snapshot for the correct session even after another session begins', async () => {
    const fileA = 'out/a.dat';
    const fileB = 'out/b.dat';
    const absA = path.join(tmp, fileA);
    const absB = path.join(tmp, fileB);
    await fs.mkdir(path.join(tmp, 'out'), { recursive: true });
    await fs.writeFile(absA, 'A-old', 'utf-8');
    await fs.writeFile(absB, 'B-old', 'utf-8');

    await setupSessionCheckpoint('sessA', 'msgA');
    await setupSessionCheckpoint('sessB', 'msgB');

    // 两个会话先后开始回合：旧实现下 activeTurn 会被 B 覆盖
    beginIntentCheckpointTurn('sessA', 'msgA', tmp);
    beginIntentCheckpointTurn('sessB', 'msgB', tmp);

    // 在各自会话上下文中记录写前快照（A 在 B begin 之后仍应生效）
    await capturePreTurnWriteSnapshot('sessA', tmp, fileA);
    await capturePreTurnWriteSnapshot('sessB', tmp, fileB);

    await fs.writeFile(absA, 'A-new', 'utf-8');
    await fs.writeFile(absB, 'B-new', 'utf-8');

    await finalizeIntentCheckpointTurn(tmp, 'sessA', 'msgA');
    await finalizeIntentCheckpointTurn(tmp, 'sessB', 'msgB');

    const archiveA = await loadIntentCheckpoint(tmp, 'sessA', 'msgA');
    const archiveB = await loadIntentCheckpoint(tmp, 'sessB', 'msgB');

    // 各自归档应记录到自己文件的写前内容（仅来自回合写前快照）
    expect(archiveA?.workspaceFiles['out/a.dat']).toBe('A-old');
    expect(archiveB?.workspaceFiles['out/b.dat']).toBe('B-old');
    // 不应串入对方的文件
    expect(archiveA?.workspaceFiles['out/b.dat']).toBeUndefined();
    expect(archiveB?.workspaceFiles['out/a.dat']).toBeUndefined();
  });

  it('clearIntentCheckpointTurnsForSession drops buffered turns for that session only', async () => {
    const fileA = 'out/a.dat';
    const absA = path.join(tmp, fileA);
    await fs.mkdir(path.join(tmp, 'out'), { recursive: true });
    await fs.writeFile(absA, 'A-old', 'utf-8');
    await setupSessionCheckpoint('sessA', 'msgA');

    beginIntentCheckpointTurn('sessA', 'msgA', tmp);
    await capturePreTurnWriteSnapshot('sessA', tmp, fileA);
    await fs.writeFile(absA, 'A-new', 'utf-8');

    // 清掉该会话的回合缓冲后再 finalize：不应再合并写前快照
    clearIntentCheckpointTurnsForSession('sessA');
    await finalizeIntentCheckpointTurn(tmp, 'sessA', 'msgA');

    const archiveA = await loadIntentCheckpoint(tmp, 'sessA', 'msgA');
    expect(archiveA?.workspaceFiles['out/a.dat']).toBeUndefined();
  });
});
