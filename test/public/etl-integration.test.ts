import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium, type Browser, type Page } from 'playwright';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PANEL_SOURCE = readFileSync(
  path.join(__dirname, '../../src/public/js/chat-execution-plan.js'),
  'utf-8',
);
const BRIDGE_SOURCE = readFileSync(
  path.join(__dirname, '../../src/public/js/chat-execution-plan-bridge.js'),
  'utf-8',
);
const CONFIG_SOURCE = readFileSync(
  path.join(__dirname, '../../src/public/js/config-page.js'),
  'utf-8',
);
const CONFIG_CSS_SOURCE = readFileSync(
  path.join(__dirname, '../../src/public/css/config.css'),
  'utf-8',
);
const CHAT_PAGE_SOURCE = readFileSync(
  path.join(__dirname, '../../src/public/js/chat-page.js'),
  'utf-8',
);
const APP_SOURCE = readFileSync(
  path.join(__dirname, '../../src/public/js/app.js'),
  'utf-8',
);

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

async function loadObserver(options: {
  showPanel?: boolean;
  mobile?: boolean;
  sessionId?: string | null;
} = {}): Promise<Page> {
  const page = await browser.newPage({ viewport: { width: 1200, height: 844 } });
  openPages.add(page);
  await page.setContent(
    `<html${options.mobile ? ' data-shell="mobile"' : ''}><body>` +
      '<nav id="top-nav"></nav><div id="app"><main id="page-container" class="page-container"></main></div>' +
      '<main id="settings-root"></main><div id="pet-canvas"></div></body></html>',
  );
  await page.evaluate(({ showPanel, sessionId }) => {
    const prefs: Record<string, unknown> = {
      showTransparencyPanel: showPanel,
      panelDefaultExpanded: true,
      showLlmActivity: true,
      showTimeline: true,
      autoScrollActiveStep: false,
      timelineTimeMode: 'absolute',
      timelineGranularity: 'step',
      panelWidth: 360,
    };
    const listeners: Array<() => void> = [];
    let activeSessionId = sessionId;
    const requests: Array<{
      url: string;
      resolve: (response: { ok: boolean; json: () => Promise<unknown> }) => void;
    }> = [];

    (window as any).__prefs = prefs;
    (window as any).__fetchRequests = requests;
    (window as any).__setSessionId = (value: string | null) => { activeSessionId = value; };
    (window as any).__resolveFetch = (index: number, body: unknown, ok = true) => {
      requests[index].resolve({ ok, json: () => Promise.resolve(body) });
    };
    (window as any).EtlPrefs = {
      get: () => ({ ...prefs }),
      getKey: (key: string) => prefs[key],
      set: (patch: Record<string, unknown>) => {
        Object.assign(prefs, patch);
        listeners.slice().forEach((listener) => listener());
      },
      onChange: (listener: () => void) => {
        listeners.push(listener);
        return () => {
          const index = listeners.indexOf(listener);
          if (index >= 0) listeners.splice(index, 1);
        };
      },
    };
    (window as any).ChatSessionStore = {
      getActiveSessionId: () => activeSessionId,
      setActiveSessionId: (value: string | null) => { activeSessionId = value; },
    };
    (window as any).ChatPetBridge = { syncExecPlanFoot: () => {} };
    (window as any).AppShell = { getTheme: () => 'dark' };
    (window as any).AppRouter = { isSetupRequired: () => false };
    (window as any).fetch = (url: string) => new Promise((resolve) => {
      requests.push({ url: String(url), resolve });
    });
  }, {
    showPanel: options.showPanel ?? true,
    sessionId: options.sessionId ?? 'integration-session',
  });
  await page.addScriptTag({ content: PANEL_SOURCE });
  await page.addScriptTag({ content: BRIDGE_SOURCE });
  await page.evaluate(() => {
    (window as any).ChatExecutionPlan.setPageActive(true);
  });
  return page;
}

async function loadChatPageObserver(): Promise<Page> {
  const page = await loadObserver();
  await page.evaluate(() => {
    const handlers: Record<string, (data: unknown) => void> = {};
    const messages: unknown[] = [];
    let processing = false;
    const noOpProxy = (overrides: Record<string, unknown>) => new Proxy(overrides, {
      get(target, property) {
        if (property in target) return target[property as string];
        return () => undefined;
      },
    });

    (window as any).__wsHandlers = handlers;
    (window as any).__emitWs = (type: string, data: unknown) => {
      if (!handlers[type]) throw new Error(`missing real WS handler: ${type}`);
      handlers[type](data);
    };
    (window as any).__petStepCalls = 0;
    (window as any).__uiToolCalls = 0;

    (window as any).ChatWebSocket = noOpProxy({
      on: (type: string, handler: (data: unknown) => void) => { handlers[type] = handler; },
      connect: () => {},
      isConnected: () => true,
      isProcessing: () => processing,
      setProcessing: (value: boolean) => { processing = value; },
      startSyncPolling: () => {},
      stopSyncPolling: () => {},
    });
    (window as any).ChatSession = noOpProxy({
      getMessages: () => messages,
      getStructuredMessages: () => [],
      getToolTraces: () => [],
      getActiveId: () => 'integration-session',
      getLastMessage: () => messages[messages.length - 1] || null,
      stripStatusTag: (value: string) => value || '',
      fetchServerMessages: (callback: (rows: unknown[], result: { ok: boolean }) => void) => {
        callback([], { ok: true });
      },
      fetchStructuredMessages: (callback: (rows: unknown[]) => void) => callback([]),
      separateToolTraces: (rows: unknown[]) => ({ messages: rows, toolTraces: [] }),
      applyServerChatSnapshot: () => {},
      initSession: () => {},
      loadLiveToolBatch: () => [],
      hasStreamingModelBubble: () => false,
      pushToolBatch: () => {},
    });
    (window as any).ChatUI = noOpProxy({
      init: () => {},
      renderMessagesOnly: () => {},
      setStreamingState: () => {},
      setComposerAction: () => {},
      isLiveToolRoundActive: () => false,
      appendToolAction: () => { (window as any).__uiToolCalls += 1; },
      promoteAssistantBubbleToThinking: () => {},
    });
    (window as any).ChatCommands = noOpProxy({
      init: () => null,
      handleKeydown: () => false,
      setRemoteMode: () => {},
      setAnchor: () => {},
      setInputAnchor: () => {},
    });
    (window as any).ChatFile = noOpProxy({
      init: () => {},
      getUploadedFiles: () => [],
      getPendingImages: () => [],
    });
    (window as any).ChatQR = noOpProxy({});
    (window as any).ChatPetBridge = noOpProxy({
      init: () => {},
      syncExecPlanFoot: () => {},
      isUserCheckpointActive: () => false,
      isModelDoneNoticeActive: () => false,
      applyHarnessStepToPet: () => { (window as any).__petStepCalls += 1; },
    });
    (window as any).SessionPet = {
      create: () => noOpProxy({
        isVisible: () => true,
      }),
    };
  });
  await page.addScriptTag({ content: CHAT_PAGE_SOURCE });
  await page.evaluate(() => {
    (window as any).ChatPage.render(document.querySelector('#page-container'));
  });
  return page;
}

function makePlan(planId = 'integration-plan') {
  const now = Date.now() - 5000;
  return {
    planId,
    progress: 0,
    activeStepId: 'step-0',
    createdAt: now,
    updatedAt: now,
    steps: [{
      id: 'step-0',
      title: '执行集成验证',
      status: 'running',
      startedAt: now,
    }],
  };
}

describe('ETL 真实 Observer 链路', () => {
  it('ChatPage 真实会话切换通知 bridge 按新 activeSessionId 重同步并废弃旧响应', async () => {
    const page = await loadChatPageObserver();
    await page.evaluate(() => {
      (window as any).ChatExecutionPlanBridge.notifyConnected({
        features: { executionPlan: true },
      });
      (window as any).ChatSessionStore.setActiveSessionId('session-b');
      (window as any).ChatPage.onSessionSwitched('session-b', null);
    });

    expect(await page.evaluate(() => (
      (window as any).__fetchRequests
        .map((request: { url: string }) => request.url)
        .filter((url: string) => url.endsWith('/plan'))
    ))).toEqual([
      '/api/sessions/integration-session/plan',
      '/api/sessions/session-b/plan',
    ]);

    await page.evaluate(({ oldPlan, newPlan }) => {
      (window as any).__resolveFetch(2, { plan: newPlan });
      (window as any).__resolveFetch(1, { plan: oldPlan });
    }, {
      oldPlan: makePlan('stale-session-plan'),
      newPlan: makePlan('session-b-plan'),
    });
    await page.waitForFunction(() => (
      (window as any).ChatExecutionPlan.getPlan()?.planId === 'session-b-plan'
    ));

    expect(await page.evaluate(() => (
      (window as any).ChatExecutionPlan.getPlan()?.planId
    ))).toBe('session-b-plan');
  });

  it('connected capability=false 后注入计划与执行模式事件仍不挂载', async () => {
    const page = await loadObserver();
    const result = await page.evaluate((plan) => {
      const bridge = (window as any).ChatExecutionPlanBridge;
      bridge.notifyConnected({ features: { executionPlan: false } });
      bridge.handleStep({
        type: 'execution_mode_enter',
        executionMode: { executionMode: 'forced', enteredBy: ['explicit_impl'] },
      });
      bridge.handleStep({ type: 'execution_plan_init', plan });
      bridge.handleStep({ type: 'task_graph_init', plan: { ...plan, planId: 'blocked-graph' } });
      return {
        enabled: bridge.isEnabled(),
        plan: (window as any).ChatExecutionPlan.getPlan(),
        panelCount: document.querySelectorAll('#exec-transparency-panel').length,
        petHidden: document.body.classList.contains('etl-pet-hidden-by-panel'),
      };
    }, makePlan('blocked-plan'));

    expect(result).toEqual({
      enabled: false,
      plan: null,
      panelCount: 0,
      petHidden: false,
    });
    await page.close();
  });

  it('REST 每次读取 active session，乱序响应只应用最新会话', async () => {
    const page = await loadObserver({ sessionId: 'session-a' });
    await page.evaluate(() => {
      (window as any).ChatExecutionPlanBridge.notifyConnected({
        features: { executionPlan: true },
      });
      (window as any).__setSessionId('session-b');
      (window as any).ChatExecutionPlanBridge.fetchAndApply();
    });
    expect(await page.evaluate(() => (
      (window as any).__fetchRequests.map((request: { url: string }) => request.url)
    ))).toEqual([
      '/api/sessions/session-a/plan',
      '/api/sessions/session-b/plan',
    ]);

    await page.evaluate(({ planA, planB }) => {
      (window as any).__resolveFetch(1, { plan: planB });
      (window as any).__resolveFetch(0, { plan: planA });
    }, {
      planA: makePlan('stale-plan-a'),
      planB: makePlan('current-plan-b'),
    });
    await page.waitForFunction(() => (
      (window as any).ChatExecutionPlan.getPlan()?.planId === 'current-plan-b'
    ));

    expect(await page.evaluate(() => (
      (window as any).ChatExecutionPlan.getPlan()?.planId
    ))).toBe('current-plan-b');
    await page.close();
  });

  it('task_graph_update 全量投影保留 Timeline 与 Footer 消费的时间字段', async () => {
    const page = await loadObserver();
    const result = await page.evaluate((plan) => {
      const bridge = (window as any).ChatExecutionPlanBridge;
      bridge.notifyConnected({ features: { executionPlan: true } });
      bridge.handleStep({ type: 'task_graph_update', plan });
      const projected = (window as any).ChatExecutionPlan.getPlan();
      return {
        createdAt: projected?.createdAt,
        updatedAt: projected?.updatedAt,
        planStartedAt: projected?.startedAt,
        planEndedAt: projected?.endedAt,
        footerTime: document.querySelector('.etl-foot-time b')?.textContent,
        timelineTotal: document.querySelector('.etl-tl-total')?.textContent,
      };
    }, {
      ...makePlan('timed-graph-plan'),
      progress: 100,
      activeStepId: null,
      createdAt: 10_000,
      updatedAt: 15_000,
      startedAt: 10_000,
      endedAt: 15_000,
      steps: [{
        id: 'step-0',
        title: '已完成图节点',
        status: 'done',
        startedAt: 10_000,
        endedAt: 15_000,
      }],
    });

    expect(result).toEqual({
      createdAt: 10_000,
      updatedAt: 15_000,
      planStartedAt: 10_000,
      planEndedAt: 15_000,
      footerTime: '00:05',
      timelineTotal: '总时长 00:05',
    });
  });

  it('关闭期间经 bridge 消费 patch，重开后恢复最新完成态', async () => {
    const page = await loadObserver();
    const result = await page.evaluate((plan) => {
      const bridge = (window as any).ChatExecutionPlanBridge;
      bridge.notifyConnected({ features: { executionPlan: true } });
      bridge.handleStep({ type: 'execution_plan_init', plan });
      (window as any).EtlPrefs.set({ showTransparencyPanel: false });
      const hiddenCount = document.querySelectorAll('#exec-transparency-panel').length;
      bridge.handleStep({
        type: 'execution_plan_update',
        planId: plan.planId,
        patch: {
          stepPatches: [{
            id: 'step-0',
            status: 'done',
            endedAt: plan.createdAt + 5000,
          }],
          activeStepId: null,
          progress: 100,
          updatedAt: plan.createdAt + 5000,
        },
      });
      const hiddenProgress = (window as any).ChatExecutionPlan.getPlan()?.progress;
      (window as any).EtlPrefs.set({ showTransparencyPanel: true });
      return {
        hiddenCount,
        hiddenProgress,
        restoredCount: document.querySelectorAll('#exec-transparency-panel').length,
        restoredStatus: document.querySelector('#etl-current-step .etl-cs-status')?.textContent,
        open: document.body.classList.contains('etl-panel-open'),
      };
    }, makePlan());

    expect(result).toEqual({
      hiddenCount: 0,
      hiddenProgress: 100,
      restoredCount: 1,
      restoredStatus: '✅ 已完成 · 用时 00:05',
      open: true,
    });
    await page.close();
  });

  it('真实顺序保留完成态与 exit resume，并按 toolCallId 处理并发工具', async () => {
    const page = await loadObserver();
    const result = await page.evaluate((plan) => {
      const bridge = (window as any).ChatExecutionPlanBridge;
      (window as any).EtlPrefs.set({ timelineGranularity: 'step+tool' });
      bridge.notifyConnected({ features: { executionPlan: true } });
      bridge.handleStep({ type: 'execution_plan_init', plan });
      bridge.handleStep({
        type: 'execution_mode_enter',
        ts: plan.createdAt + 500,
        executionMode: {
          executionMode: 'forced',
          primaryReasonHuman: '执行修改',
          enteredBy: ['explicit_impl'],
          round: 1,
        },
      });
      bridge.handleStep({
        type: 'tool_call',
        toolCallId: 'call-a',
        toolName: 'read_file',
        ts: plan.createdAt + 1000,
      });
      bridge.handleStep({
        type: 'tool_call',
        toolCallId: 'call-b',
        toolName: 'run_command',
        ts: plan.createdAt + 2000,
      });
      bridge.handleStep({
        type: 'tool_result',
        toolCallId: 'call-a',
        toolName: 'read_file',
        status: 'done',
        ts: plan.createdAt + 3000,
      });
      bridge.handleStep({ type: 'task_graph_done', ts: plan.createdAt + 5000 });
      bridge.handleStep({
        type: 'execution_mode_exit',
        ts: plan.createdAt + 5000,
        executionMode: {
          executionMode: 'free',
          primaryReasonHuman: '恢复模型执行',
          enteredBy: ['explicit_impl'],
          round: 1,
        },
      });
      const tool = (id: string) => {
        const node = document.querySelector(`[data-tool-call-id="${id}"]`) as HTMLElement;
        return { status: node?.dataset.status, resultTs: node?.dataset.resultTs };
      };
      return {
        progress: (window as any).ChatExecutionPlan.getPlan()?.progress,
        status: document.querySelector('#etl-current-step .etl-cs-status')?.textContent,
        resume: document.querySelector('.etl-tl-node--supervisor.is-resume')?.textContent,
        toolCount: document.querySelector('.etl-foot-tool b')?.textContent,
        a: tool('call-a'),
        b: tool('call-b'),
      };
    }, makePlan());

    expect(result.progress).toBe(100);
    expect(result.status).toBe('✅ 已完成 · 用时 00:05');
    expect(result.resume).toContain('继续执行');
    expect(result.toolCount).toBe('2');
    expect(result.a.status).toBe('done');
    expect(result.a.resultTs).toBeTruthy();
    expect(result.b).toEqual({ status: 'running', resultTs: undefined });
    await page.close();
  });

  it('真实 AppRouter 跨页隐藏后恢复同一计划', async () => {
    const page = await loadObserver();
    await page.evaluate(() => {
      window.location.hash = '#/chat';
      (window as any).ChatSessionSidebar = { create: () => {} };
      (window as any).ChatPage = { render: () => {}, onActivate: () => {} };
      (window as any).SettingsPage = {
        render: () => {},
        onActivate: () => {},
        onDeactivate: () => {},
      };
      (window as any).matchMedia = () => ({
        matches: false,
        addEventListener: () => {},
        removeEventListener: () => {},
      });
    });
    await page.addScriptTag({ content: APP_SOURCE });
    const result = await page.evaluate((plan) => {
      const bridge = (window as any).ChatExecutionPlanBridge;
      const panel = (window as any).ChatExecutionPlan;
      bridge.notifyConnected({ features: { executionPlan: true } });
      bridge.handleStep({ type: 'execution_plan_init', plan });
      (window as any).AppRouter.navigate('settings');
      const away = {
        page: document.body.dataset.page,
        open: document.body.classList.contains('etl-panel-open'),
        petHidden: document.body.classList.contains('etl-pet-hidden-by-panel'),
        planId: panel.getPlan()?.planId,
      };
      (window as any).AppRouter.navigate('chat');
      return {
        away,
        returned: {
          page: document.body.dataset.page,
          open: document.body.classList.contains('etl-panel-open'),
          planId: panel.getPlan()?.planId,
        },
      };
    }, makePlan());

    expect(result).toEqual({
      away: {
        page: 'settings',
        open: false,
        petHidden: false,
        planId: 'integration-plan',
      },
      returned: {
        page: 'chat',
        open: true,
        planId: 'integration-plan',
      },
    });
    await page.close();
  });

  it('设置页接收晚到 capability，移动 shell 隐藏 panelWidth', async () => {
    const page = await loadObserver({ mobile: true });
    await page.addScriptTag({ content: CONFIG_SOURCE });
    await page.addStyleTag({ content: CONFIG_CSS_SOURCE });
    const result = await page.evaluate(() => {
      (window as any).SettingsPage.render(document.querySelector('#settings-root'));
      const input = document.querySelector('#etl-show-panel') as HTMLInputElement;
      const initiallyDisabled = input.disabled;
      (window as any).ChatExecutionPlanBridge.notifyConnected({
        features: { executionPlan: true },
      });
      return {
        initiallyDisabled,
        enabledAfterConnected: !input.disabled,
        widthDisplay: getComputedStyle(
          document.querySelector('#etl-panel-width-row') as HTMLElement,
        ).display,
      };
    });

    expect(result).toEqual({
      initiallyDisabled: true,
      enabledAfterConnected: true,
      widthDisplay: 'none',
    });
    await page.close();
  });

  it('设置页能力关闭和主开关关闭都会禁用主项及全部子项', async () => {
    const page = await loadObserver({ showPanel: true });
    await page.addScriptTag({ content: CONFIG_SOURCE });
    const result = await page.evaluate(() => {
      (window as any).SettingsPage.render(document.querySelector('#settings-root'));
      const allChildrenDisabled = () => [...document.querySelectorAll(
        '#settings-etl-subgroup input, #settings-etl-subgroup select',
      )].every((node) => (node as HTMLInputElement | HTMLSelectElement).disabled);
      const allChildrenEnabled = () => [...document.querySelectorAll(
        '#settings-etl-subgroup input, #settings-etl-subgroup select',
      )].every((node) => !(node as HTMLInputElement | HTMLSelectElement).disabled);
      const main = document.querySelector('#etl-show-panel') as HTMLInputElement;

      const initial = { mainDisabled: main.disabled, childrenDisabled: allChildrenDisabled() };
      (window as any).ChatExecutionPlanBridge.notifyConnected({
        features: { executionPlan: true },
      });
      const enabled = { mainEnabled: !main.disabled, childrenEnabled: allChildrenEnabled() };
      (window as any).ChatExecutionPlanBridge.notifyConnected({
        features: { executionPlan: false },
      });
      const capabilityOff = {
        mainDisabled: main.disabled,
        childrenDisabled: allChildrenDisabled(),
      };
      (window as any).ChatExecutionPlanBridge.notifyConnected({
        features: { executionPlan: true },
      });
      (window as any).EtlPrefs.set({ showTransparencyPanel: false });
      const mainOff = {
        mainEnabled: !main.disabled,
        childrenDisabled: allChildrenDisabled(),
      };
      return { initial, enabled, capabilityOff, mainOff };
    });

    expect(result).toEqual({
      initial: { mainDisabled: true, childrenDisabled: true },
      enabled: { mainEnabled: true, childrenEnabled: true },
      capabilityOff: { mainDisabled: true, childrenDisabled: true },
      mainOff: { mainEnabled: true, childrenDisabled: true },
    });
  });

  it('执行层 Tabs 具备完整关联并支持桌面与移动键盘导航', async () => {
    const desktop = await loadObserver();
    const desktopResult = await desktop.evaluate((plan) => {
      const bridge = (window as any).ChatExecutionPlanBridge;
      bridge.notifyConnected({ features: { executionPlan: true } });
      bridge.handleStep({ type: 'execution_plan_init', plan });
      const flow = document.querySelector('[data-tab="flow"]') as HTMLButtonElement;
      const read = () => {
        const active = document.activeElement as HTMLElement;
        return {
          tab: active?.dataset.tab,
          activeTab: document.querySelector('.etl-tab.is-active')?.getAttribute('data-tab'),
        };
      };
      const press = (key: string) => {
        (document.activeElement as HTMLElement).dispatchEvent(new KeyboardEvent('keydown', {
          key,
          bubbles: true,
        }));
        return read();
      };
      flow.focus();
      const associations = [...document.querySelectorAll('.etl-tab')].map((node) => {
        const tab = node as HTMLButtonElement;
        const panel = document.getElementById(tab.getAttribute('aria-controls') || '');
        return {
          id: tab.id,
          controls: tab.getAttribute('aria-controls'),
          panelLabelledBy: panel?.getAttribute('aria-labelledby'),
        };
      });
      return {
        associations,
        right: press('ArrowRight'),
        end: press('End'),
        left: press('ArrowLeft'),
        home: press('Home'),
      };
    }, makePlan('desktop-tabs'));

    expect(desktopResult.associations).toHaveLength(5);
    for (const association of desktopResult.associations) {
      expect(association.id).toMatch(/^etl-tab-/);
      expect(association.controls).toMatch(/^etl-panel-/);
      expect(association.panelLabelledBy).toBe(association.id);
    }
    expect(desktopResult.right).toEqual({ tab: 'tools', activeTab: 'tools' });
    expect(desktopResult.end).toEqual({ tab: 'log', activeTab: 'log' });
    expect(desktopResult.left).toEqual({ tab: 'snapshot', activeTab: 'snapshot' });
    expect(desktopResult.home).toEqual({ tab: 'flow', activeTab: 'flow' });

    const mobile = await loadObserver({ mobile: true });
    const mobileResult = await mobile.evaluate((plan) => {
      const bridge = (window as any).ChatExecutionPlanBridge;
      bridge.notifyConnected({ features: { executionPlan: true } });
      bridge.handleStep({ type: 'execution_plan_init', plan });
      const flow = document.querySelector('[data-tab="flow"]') as HTMLButtonElement;
      flow.focus();
      flow.dispatchEvent(new KeyboardEvent('keydown', { key: 'End', bubbles: true }));
      return {
        count: document.querySelectorAll('.etl-tab').length,
        focused: (document.activeElement as HTMLElement)?.dataset.tab,
        active: document.querySelector('.etl-tab.is-active')?.getAttribute('data-tab'),
      };
    }, makePlan('mobile-tabs'));
    expect(mobileResult).toEqual({ count: 2, focused: 'tools', active: 'tools' });
  });

  it('真实 panel render 异常被隔离，bridge 后续事件仍更新并恢复 UI', async () => {
    const page = await loadObserver();
    const result = await page.evaluate((plan) => {
      const bridge = (window as any).ChatExecutionPlanBridge;
      bridge.notifyConnected({ features: { executionPlan: true } });
      bridge.handleStep({ type: 'execution_plan_init', plan });
      const current = document.querySelector('#etl-current-step') as HTMLElement;
      Object.defineProperty(current, 'innerHTML', {
        configurable: true,
        set() { throw new Error('integration render injection'); },
      });

      let escaped = false;
      try {
        bridge.handleStep({
          type: 'execution_plan_update',
          planId: plan.planId,
          patch: { progress: 20, updatedAt: plan.updatedAt + 1000 },
        });
      } catch {
        escaped = true;
      }
      const afterFailureCount = document.querySelectorAll('#exec-transparency-panel').length;
      bridge.handleStep({
        type: 'execution_plan_update',
        planId: plan.planId,
        patch: { progress: 30, updatedAt: plan.updatedAt + 2000 },
      });
      return {
        escaped,
        afterFailureCount,
        recoveredCount: document.querySelectorAll('#exec-transparency-panel').length,
        open: document.body.classList.contains('etl-panel-open'),
        progress: (window as any).ChatExecutionPlan.getPlan()?.progress,
      };
    }, makePlan());

    expect(result).toEqual({
      escaped: false,
      afterFailureCount: 0,
      recoveredCount: 1,
      open: true,
      progress: 30,
    });
    await page.close();
  });

  it('真实 ChatPage WS wiring 在 ETL 异常后继续分发 Panel、Pet 与 UI', async () => {
    const page = await loadChatPageObserver();
    const result = await page.evaluate((plan) => {
      const emit = (window as any).__emitWs;
      emit('connected', { features: { executionPlan: true } });
      emit('step', { step: { type: 'execution_plan_init', plan } });

      const current = document.querySelector('#etl-current-step') as HTMLElement;
      Object.defineProperty(current, 'innerHTML', {
        configurable: true,
        set() { throw new Error('real WS render injection'); },
      });
      emit('step', {
        step: {
          type: 'execution_plan_update',
          planId: plan.planId,
          patch: { progress: 20, updatedAt: plan.updatedAt + 1000 },
        },
      });
      const afterFailureCount = document.querySelectorAll('#exec-transparency-panel').length;

      emit('step', {
        step: {
          type: 'tool_call',
          toolCallId: 'ws-tool',
          toolName: 'read_file',
          toolArgs: { path: 'src/public/js/chat-page.js' },
          ts: plan.createdAt + 1500,
        },
      });
      emit('step', {
        step: {
          type: 'execution_plan_update',
          planId: plan.planId,
          patch: { progress: 30, updatedAt: plan.updatedAt + 2000 },
        },
      });

      return {
        registeredConnected: typeof (window as any).__wsHandlers.connected === 'function',
        registeredStep: typeof (window as any).__wsHandlers.step === 'function',
        enabled: (window as any).ChatExecutionPlanBridge.isEnabled(),
        afterFailureCount,
        recoveredCount: document.querySelectorAll('#exec-transparency-panel').length,
        progress: (window as any).ChatExecutionPlan.getPlan()?.progress,
        toolCount: document.querySelector('.etl-foot-tool b')?.textContent,
        uiToolCalls: (window as any).__uiToolCalls,
        petStepCalls: (window as any).__petStepCalls,
      };
    }, makePlan('real-chat-page-plan'));

    expect(result).toEqual({
      registeredConnected: true,
      registeredStep: true,
      enabled: true,
      afterFailureCount: 0,
      recoveredCount: 1,
      progress: 30,
      toolCount: '1',
      uiToolCalls: 1,
      petStepCalls: 4,
    });
    await page.close();
  });
});
