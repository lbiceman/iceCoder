import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const publicJs = (...parts: string[]) => path.join(__dirname, '../../src/public/js', ...parts);
const publicCss = (...parts: string[]) => path.join(__dirname, '../../src/public/css', ...parts);

function read(file: string): string {
  return readFileSync(file, 'utf-8');
}

describe('多会话并发切换 · 前端源码约定', () => {
  it('侧栏不再锁切换，并用运行态圆点', () => {
    const sidebar = read(publicJs('chat-session-sidebar.js'));
    expect(sidebar).not.toContain('isSwitchLocked');
    expect(sidebar).not.toContain('syncSwitchLockState');
    expect(sidebar).toContain('chat-sidebar-item-run-dot');
    expect(sidebar).not.toContain('is-switch-locked');
  });

  it('移动端抽屉不再 disabled 锁点击，并用运行态圆点', () => {
    const drawer = read(publicJs('shell', 'mobile-session-drawer.js'));
    expect(drawer).not.toContain('isSwitchLocked');
    expect(drawer).not.toContain('syncSwitchLockState');
    expect(drawer).toContain('mobile-drawer-item-run-dot');
    expect(drawer).not.toMatch(/item\.disabled\s*=/);
  });

  it('侧栏未挂载时 renderList 不访问 DOM', () => {
    const sidebar = read(publicJs('chat-session-sidebar.js'));
    const renderList = sidebar.slice(
      sidebar.indexOf('function renderList()'),
      sidebar.indexOf('function applyWorkspaceForSession'),
    );
    expect(renderList).toMatch(/if\s*\(\s*!sidebar\s*\)\s*return/);
  });

  it('移动端再点当前会话只关抽屉，不 switchSession', () => {
    const drawer = read(publicJs('shell', 'mobile-session-drawer.js'));
    const selectFn = drawer.slice(
      drawer.indexOf('function selectSession'),
      drawer.indexOf('function onOpen'),
    );
    expect(selectFn).toMatch(/sessionId === Store\.getActiveSessionId\(\)/);
    expect(selectFn).toMatch(/closeDrawer/);
    const earlyReturn = selectFn.indexOf('getActiveSessionId()') >= 0
      ? selectFn.indexOf('getActiveSessionId()')
      : -1;
    const switchCall = selectFn.indexOf('Store.switchSession');
    expect(earlyReturn).toBeGreaterThan(-1);
    expect(switchCall).toBeGreaterThan(earlyReturn);
  });

  it('ChatWebSocket processing 按 session，并处理 session_run_state', () => {
    const ws = read(publicJs('chat-websocket.js'));
    expect(ws).toContain('processingBySession');
    expect(ws).toContain('session_run_state');
    expect(ws).toContain('shouldEmitTaskEvent');
    expect(ws).toMatch(/data\.type === 'info' \|\| data\.type === 'error'/);
  });

  it('onSessionSwitched 捕获草稿且不再只清 FileRef', () => {
    const page = read(publicJs('chat-page.js'));
    expect(page).toContain('resetViewportTransientState');
    expect(page).toContain('setComposerSnapshot');
    expect(page).toContain('captureComposerDraft');
    expect(page).toContain('restoreComposerDraft');
    expect(page).toContain('acknowledgeRunPhase');
    expect(page).not.toContain('syncSwitchLockState');
    const switchFn = page.slice(
      page.indexOf('function onSessionSwitched'),
      page.indexOf('function paintInitialChatView'),
    );
    expect(switchFn).not.toContain('FileRef.clearInput');
  });

  it('ChatSessionStore 把 session_switched 的 restore extras 传给 callback', () => {
    const store = read(publicJs('chat-session-store.js'));
    expect(store).toContain('lastRuntime');
    expect(store).toContain('callback(!!ok, lastRunningTurn, lastWorkspace, !!degraded, lastBgTasks, lastRuntime)');
  });

  it('connected 对齐会话时带上 harness restore extras', () => {
    const handlers = read(publicJs('chat-ws-session-handlers.js'));
    expect(handlers).toContain('canRestore: data.canRestore');
    expect(handlers).toContain('checkpointMessageIds: data.checkpointMessageIds');
  });

  it('confirm 切走 dismiss 不 sendConfirmReply', () => {
    const restore = read(publicJs('chat-ws-restore-handlers.js'));
    expect(restore).toContain('dismissConfirmWithoutReply');
    expect(restore).toContain('isForeignSessionEvent');
  });

  it('运行态圆点样式存在且无切换锁样式', () => {
    const css = read(publicCss('chat.css'));
    expect(css).toContain('.chat-sidebar-item-run-dot');
    expect(css).not.toContain('is-switch-locked');
  });

  it('移动端抽屉圆点样式存在', () => {
    const css = read(publicCss('mobile-shell.css'));
    expect(css).toContain('.mobile-drawer-item-run-dot');
  });

  it('扫码不把 PC 当前会话写入 URL sid；远程首屏取列表第一项', () => {
    const qr = read(publicJs('chat-qr.js'));
    expect(qr).not.toContain("params += '&sid='");
    expect(qr).not.toContain('chatSessionId');
    const store = read(publicJs('chat-session-store.js'));
    expect(store).toContain('isRemoteTokenEntry()');
    expect(store).toContain('return sessions[0].id');
    expect(store).not.toContain('readRemoteUrlSessionId');
    expect(store).toContain("type: 'ack_session_run'");
    expect(store).toContain('sessionRunStates');
  });

  it('扫码 WS 不抢 PC 聚焦，connected 用本连接订阅 id', () => {
    const ws = read(path.join(__dirname, '../../src/web/chat-ws.ts'));
    expect(ws).toContain('readFirstSessionIdFromIndex');
    expect(ws).not.toContain('ensureGlobalActiveSessionId');
    expect(ws).toContain('getSubscribedSessionId(ws)');
    const persist = read(path.join(__dirname, '../../src/web/chat-ws-persist.ts'));
    expect(persist).not.toContain('ensureGlobalActiveSessionId');
    const remote = read(path.join(__dirname, '../../src/web/routes/remote.ts'));
    expect(remote).not.toContain('chatSessionId');
    expect(remote).not.toContain('removeSession');
  });
});
