import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium, type Browser, type Page } from 'playwright';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const publicRoot = path.join(__dirname, '../../src/public');
const CHAT_UI_SOURCE = readFileSync(path.join(publicRoot, 'js/chat-ui.js'), 'utf-8');

let browser: Browser;
const openPages = new Set<Page>();

beforeAll(async () => {
  browser = await chromium.launch({ headless: true });
}, 30_000);

afterAll(async () => {
  await browser.close();
}, 30_000);

afterEach(async () => {
  await Promise.all([...openPages].map(async (page) => {
    try {
      if (!page.isClosed()) await page.close();
    } finally {
      openPages.delete(page);
    }
  }));
});

async function loadChatUi(page: Page) {
  await page.setContent(
    '<!DOCTYPE html><html><body>' +
      '<div id="chat-messages" class="chat-messages">' +
        '<div id="chat-anchor" class="chat-messages-anchor"></div>' +
      '</div>' +
      '<textarea id="chat-input"></textarea>' +
      '<button id="chat-send" type="button">send</button>' +
    '</body></html>',
  );
  await page.addScriptTag({ content: CHAT_UI_SOURCE });
  await page.evaluate(() => {
    const ui = (window as any).ChatUI;
    ui.init({
      elMessages: document.getElementById('chat-messages'),
      elAnchor: document.getElementById('chat-anchor'),
      elInput: document.getElementById('chat-input'),
      elSendBtn: document.getElementById('chat-send'),
    });
  });
}

describe('聊天气泡回滚按钮', () => {
  it('时间轴检查点同步后，气泡回滚应变为可点，且不被空 ID 列表清掉', async () => {
    const page = await browser.newPage();
    openPages.add(page);
    await loadChatUi(page);

    const result = await page.evaluate(async () => {
      const ui = (window as any).ChatUI;
      const messages = [
        { role: 'user', id: 'bubble-1', content: '随便新增两个文件', sentAt: 1_000 },
        { role: 'agent', id: 'a1', content: '已创建' },
        { role: 'user', id: 'bubble-2', content: '再新增十个垃圾文件', sentAt: 2_000 },
      ];
      (window as any).ChatSession = {
        getMessages: () => messages,
        prepareUserMessageForDisplay: (m: unknown) => m,
        stripStatusTag: (t: string) => t,
      };
      (window as any).ChatWebSocket = { canRestoreRuntime: () => true };
      ui.renderMessagesOnly(messages, {}, (t: string) => t, false, {});

      const before = Array.from(document.querySelectorAll('.msg-restore-btn')).map((btn) => ({
        id: (btn as HTMLButtonElement).dataset.messageId || '',
        disabled: (btn as HTMLButtonElement).disabled,
        ready: btn.classList.contains('msg-restore-btn--ready'),
      }));

      (window as any).ChatExecutionPlan = {
        hasSnapshotCheckpoint: (id: string) => id === 'cp-1' || id === 'cp-2',
        getSnapshotCheckpointEntries: () => [
          { messageId: 'cp-1', userMessageTime: 1_000, preview: '随便新增两个文件' },
          { messageId: 'cp-2', userMessageTime: 2_000, preview: '再新增十个垃圾文件' },
        ],
      };
      ui.mergeCheckpointMessageIds(['cp-1', 'cp-2']);
      await new Promise((r) => requestAnimationFrame(() => r(null)));

      const afterSync = Array.from(document.querySelectorAll('.msg-restore-btn')).map((btn) => ({
        id: (btn as HTMLButtonElement).dataset.messageId || '',
        disabled: (btn as HTMLButtonElement).disabled,
        ready: btn.classList.contains('msg-restore-btn--ready'),
        resolved: ui.resolveCheckpointMessageId(
          (btn as HTMLButtonElement).dataset.messageId,
          Number((btn as HTMLButtonElement).dataset.sentAt),
        ),
      }));

      ui.setCheckpointMessageIds([]);
      await new Promise((r) => requestAnimationFrame(() => r(null)));
      const afterWipe = Array.from(document.querySelectorAll('.msg-restore-btn')).map((btn) => ({
        disabled: (btn as HTMLButtonElement).disabled,
        ready: btn.classList.contains('msg-restore-btn--ready'),
      }));

      return { before, afterSync, afterWipe };
    });

    expect(result.before).toEqual([
      { id: 'bubble-1', disabled: true, ready: false },
      { id: 'bubble-2', disabled: true, ready: false },
    ]);
    expect(result.afterSync).toEqual([
      { id: 'bubble-1', disabled: false, ready: true, resolved: 'cp-1' },
      { id: 'bubble-2', disabled: false, ready: true, resolved: 'cp-2' },
    ]);
    expect(result.afterWipe).toEqual([
      { disabled: false, ready: true },
      { disabled: false, ready: true },
    ]);
    await page.close();
  });

  it('乐观消息 _prevId 与检查点 ID 对得上时气泡可回滚', async () => {
    const page = await browser.newPage();
    openPages.add(page);
    await loadChatUi(page);

    const result = await page.evaluate(async () => {
      const ui = (window as any).ChatUI;
      const messages = [
        { role: 'user', id: 'server-id', _prevId: 'optimistic-id', content: 'hi', sentAt: 10 },
      ];
      (window as any).ChatSession = {
        getMessages: () => messages,
        prepareUserMessageForDisplay: (m: unknown) => m,
      };
      (window as any).ChatWebSocket = { canRestoreRuntime: () => true };
      ui.appendMessageEl({
        role: 'user',
        id: 'server-id',
        content: 'hi',
        sentAt: 10,
      }, (t: string) => t);
      ui.setCheckpointMessageIds(['optimistic-id']);
      await new Promise((r) => requestAnimationFrame(() => r(null)));
      const btn = document.querySelector('.msg-restore-btn') as HTMLButtonElement;
      return {
        disabled: btn.disabled,
        ready: btn.classList.contains('msg-restore-btn--ready'),
        resolved: ui.resolveCheckpointMessageId('server-id'),
        has: ui.hasCheckpointForMessage('server-id'),
      };
    });

    expect(result).toEqual({
      disabled: false,
      ready: true,
      resolved: 'optimistic-id',
      has: true,
    });
    await page.close();
  });

  it('运行中时气泡回滚保持禁用，与 canRestoreRuntime 一致', async () => {
    const page = await browser.newPage();
    openPages.add(page);
    await loadChatUi(page);

    const result = await page.evaluate(async () => {
      const ui = (window as any).ChatUI;
      (window as any).ChatSession = {
        getMessages: () => [{ role: 'user', id: 'm1', content: 'x', sentAt: 1 }],
        prepareUserMessageForDisplay: (m: unknown) => m,
      };
      (window as any).ChatWebSocket = { canRestoreRuntime: () => false };
      ui.appendMessageEl({ role: 'user', id: 'm1', content: 'x', sentAt: 1 }, (t: string) => t);
      ui.setCheckpointMessageIds(['m1']);
      await new Promise((r) => requestAnimationFrame(() => r(null)));
      const btn = document.querySelector('.msg-restore-btn') as HTMLButtonElement;
      return {
        disabled: btn.disabled,
        ready: btn.classList.contains('msg-restore-btn--ready'),
        allowed: ui.isChatRestoreAllowed(),
      };
    });

    expect(result).toEqual({ disabled: true, ready: true, allowed: false });
    await page.close();
  });
});
