import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const CHAT_PAGE_SOURCE = readFileSync(
  path.join(__dirname, '../../src/public/js/chat-page.js'),
  'utf-8',
);
const STREAM_HANDLERS_SOURCE = readFileSync(
  path.join(__dirname, '../../src/public/js/chat-ws-stream-handlers.js'),
  'utf-8',
);
const SESSION_HANDLERS_SOURCE = readFileSync(
  path.join(__dirname, '../../src/public/js/chat-ws-session-handlers.js'),
  'utf-8',
);
const RESTORE_HANDLERS_SOURCE = readFileSync(
  path.join(__dirname, '../../src/public/js/chat-ws-restore-handlers.js'),
  'utf-8',
);

describe('chat-page WS handler 拆分（块 1-3）', () => {
  it('chat-page.js 不再注册已迁出的流式事件', () => {
    for (const evt of ['stream', 'reasoning_stream', 'stream_end', 'response', 'step', 'status', 'error', 'tool_output']) {
      expect(CHAT_PAGE_SOURCE).not.toMatch(new RegExp(`WS\\.on\\('${evt}'`));
    }
  });

  it('chat-page.js 不再注册已迁出的会话事件', () => {
    for (const evt of ['connected', 'session_cleared', 'session_updated', 'sync', 'user_message_appended', 'workspace_updated']) {
      expect(CHAT_PAGE_SOURCE).not.toMatch(new RegExp(`WS\\.on\\('${evt}'`));
    }
  });

  it('chat-page.js 不再注册已迁出的恢复/确认事件', () => {
    for (const evt of [
      'confirm', 'confirm_resolved', 'confirm_timeout',
      'harness_state', 'checkpoint_message_ids', 'checkpoint_captured',
      'runtime_restored', 'restore_failed', 'message_deleted', 'delete_message_failed',
    ]) {
      expect(CHAT_PAGE_SOURCE).not.toMatch(new RegExp(`WS\\.on\\('${evt}'`));
    }
  });

  it('新模块各自注册对应事件', () => {
    for (const evt of ['stream', 'reasoning_stream', 'stream_end', 'response', 'step', 'status', 'error', 'tool_output']) {
      expect(STREAM_HANDLERS_SOURCE).toMatch(new RegExp(`WS\\.on\\('${evt}'`));
    }
    for (const evt of ['connected', 'session_cleared', 'session_updated', 'sync', 'user_message_appended', 'workspace_updated']) {
      expect(SESSION_HANDLERS_SOURCE).toMatch(new RegExp(`WS\\.on\\('${evt}'`));
    }
    for (const evt of [
      'confirm', 'confirm_resolved', 'confirm_timeout',
      'harness_state', 'checkpoint_message_ids', 'checkpoint_captured',
      'runtime_restored', 'restore_failed', 'message_deleted', 'delete_message_failed',
    ]) {
      expect(RESTORE_HANDLERS_SOURCE).toMatch(new RegExp(`WS\\.on\\('${evt}'`));
    }
  });

  it('restore 模块内 ctx.xxx 调用与 buildRestoreHandlerCtx 提供的键一致', () => {
    const ctxCalls = new Set(
      [...RESTORE_HANDLERS_SOURCE.matchAll(/ctx\.([a-zA-Z]+)/g)].map((m) => m[1]),
    );
    // get/set 是通用访问器，单独校验
    expect(ctxCalls.has('get')).toBe(true);
    expect(ctxCalls.has('set')).toBe(true);
    ctxCalls.delete('get');
    ctxCalls.delete('set');

    // 从 chat-page.js 提取 buildRestoreHandlerCtx 提供的键
    const ctxBlock = CHAT_PAGE_SOURCE.match(
      /function buildRestoreHandlerCtx\(\) \{([\s\S]*?)\n  \}/,
    );
    expect(ctxBlock).not.toBeNull();
    const providedKeys = new Set(
      [...ctxBlock![1].matchAll(/^\s{6}([a-zA-Z]+):/gm)].map((m) => m[1]),
    );
    // 排除 get/set 键本身
    providedKeys.delete('get');
    providedKeys.delete('set');

    for (const key of ctxCalls) {
      expect(providedKeys.has(key), `restore 模块调用 ctx.${key} 但 ctx 未提供`).toBe(true);
    }
  });

  it('main.js 在 chat-page.js 之前 import 全部 handler 模块', () => {
    const mainSource = readFileSync(
      path.join(__dirname, '../../src/public/js/main.js'),
      'utf-8',
    );
    const chatPageIdx = mainSource.indexOf("import './chat-page.js';");
    expect(chatPageIdx).toBeGreaterThan(-1);
    for (const mod of ['chat-ws-stream-handlers', 'chat-ws-session-handlers', 'chat-ws-restore-handlers']) {
      const idx = mainSource.indexOf(`import './${mod}.js';`);
      expect(idx).toBeGreaterThan(-1);
      expect(idx).toBeLessThan(chatPageIdx);
    }
  });
});
