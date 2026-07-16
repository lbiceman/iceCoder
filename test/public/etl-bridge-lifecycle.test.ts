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
const PET_BRIDGE_SOURCE = readFileSync(
  path.join(__dirname, '../../src/public/js/chat-pet-bridge.js'),
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

async function loadLifecycle(): Promise<Page> {
  const page = await browser.newPage();
  openPages.add(page);
  await page.setContent(
    '<html><body><nav id="top-nav"></nav><main class="page-container"></main>' +
      '<div id="pet-canvas"></div></body></html>',
  );
  await page.evaluate(() => {
    const prefs = {
      showTransparencyPanel: true,
      panelDefaultExpanded: true,
      showLlmActivity: true,
      panelWidth: 360,
    };
    (window as any).EtlPrefs = {
      getKey: (key: keyof typeof prefs) => prefs[key],
      onChange: () => () => {},
    };
    (window as any).ChatPetBridge = { syncExecPlanFoot: () => {} };
    (window as any).ChatSessionStore = { getActiveSessionId: () => 'lifecycle-session' };
    (window as any).fetch = () => new Promise(() => {});
  });
  await page.addScriptTag({ content: PANEL_SOURCE });
  await page.addScriptTag({ content: BRIDGE_SOURCE });
  await page.evaluate(() => {
    (window as any).ChatExecutionPlan.setPageActive(true);
    (window as any).ChatExecutionPlanBridge.notifyConnected({
      features: { executionPlan: true },
    });
  });
  return page;
}

function makePlan() {
  const now = Date.now() - 3000;
  return {
    planId: 'lifecycle-plan',
    progress: 0,
    activeStepId: 'step-0',
    createdAt: now,
    updatedAt: now,
    steps: [{
      id: 'step-0',
      title: '执行修复',
      status: 'running',
      startedAt: now,
    }],
  };
}

describe('ETL bridge 生命周期', () => {
  it('execution_mode_exit 保留计划与面板，不再渲染旧 Supervisor 时间轴节点', async () => {
    const page = await loadLifecycle();
    const result = await page.evaluate((plan) => {
      const bridge = (window as any).ChatExecutionPlanBridge;
      bridge.handleStep({ type: 'execution_plan_init', plan });
      bridge.handleStep({
        type: 'execution_mode_enter',
        ts: plan.createdAt + 500,
        executionMode: {
          executionMode: 'forced',
          primaryReasonHuman: '需要执行修改',
          enteredBy: ['explicit_impl'],
          round: 1,
        },
      });
      bridge.handleStep({
        type: 'execution_mode_exit',
        ts: plan.createdAt + 1000,
        executionMode: {
          executionMode: 'free',
          enteredBy: ['explicit_impl'],
          enteredByPrimary: 'explicit_impl',
          primaryReasonHuman: '恢复模型执行',
          round: 1,
          forcedTaskBearingRoundsSinceEntry: 1,
          forcedMinDwellRounds: 1,
        },
      });
      return {
        planId: (window as any).ChatExecutionPlan.getPlan()?.planId,
        open: document.body.classList.contains('etl-panel-open'),
        hasLegacySupervisor: !!document.querySelector('.etl-tl-node--supervisor'),
      };
    }, makePlan());

    expect(result.planId).toBe('lifecycle-plan');
    expect(result.open).toBe(true);
    expect(result.hasLegacySupervisor).toBe(false);
    await page.close();
  });

  it('capability=false 后 clear 不重显空面板，重新启用后恢复问答空态', async () => {
    const page = await loadLifecycle();
    const result = await page.evaluate(() => {
      const bridge = (window as any).ChatExecutionPlanBridge;
      bridge.notifyConnected({ features: { executionPlan: false } });
      (window as any).ChatExecutionPlan.clear();
      const afterDirectClear = {
        open: document.body.classList.contains('etl-panel-open'),
        petHidden: document.body.classList.contains('etl-pet-hidden-by-panel'),
      };
      bridge.handleStep({ type: 'execution_plan_clear' });
      const disabled = {
        open: document.body.classList.contains('etl-panel-open'),
        petHidden: document.body.classList.contains('etl-pet-hidden-by-panel'),
      };
      bridge.notifyConnected({ features: { executionPlan: true } });
      return {
        afterDirectClear,
        disabled,
        enabled: {
          open: document.body.classList.contains('etl-panel-open'),
          emptyText: document.querySelector('.etl-plan-empty')?.textContent,
        },
      };
    });

    expect(result).toEqual({
      afterDirectClear: { open: false, petHidden: false },
      disabled: { open: false, petHidden: false },
      enabled: {
        open: true,
        emptyText: '本次任务无结构化执行计划',
      },
    });
    await page.close();
  });

  it('task_graph_done 保留完成计划并定格展示', async () => {
    const page = await loadLifecycle();
    const result = await page.evaluate((plan) => {
      const bridge = (window as any).ChatExecutionPlanBridge;
      bridge.handleStep({ type: 'task_graph_init', plan });
      bridge.handleStep({ type: 'task_graph_done', ts: plan.createdAt + 3000 });
      return {
        planId: (window as any).ChatExecutionPlan.getPlan()?.planId,
        progress: (window as any).ChatExecutionPlan.getPlan()?.progress,
        open: document.body.classList.contains('etl-panel-open'),
        status: document.querySelector('#etl-current-step .etl-cs-status')?.textContent,
      };
    }, makePlan());

    expect(result).toEqual({
      planId: 'lifecycle-plan',
      progress: 100,
      open: true,
      status: '✅ 已完成 · 用时 00:03',
    });
    await page.close();
  });

  it('宠物终态通知不清完成计划，仅新任务开始时清旧状态', async () => {
    const page = await browser.newPage();
    openPages.add(page);
    await page.setContent('<html><body></body></html>');
    const result = await page.evaluate((source) => {
      let clearCount = 0;
      (window as any).ChatExecutionPlan = {
        clear: () => { clearCount += 1; },
        getPlan: () => ({ planId: 'done-plan', progress: 100, steps: [] }),
        isPlanComplete: () => true,
        isPlanLive: () => false,
        getExecutionModeChip: () => '',
      };
      window.eval(source);
      const pet = {
        setState: () => {},
        setBubbleText: () => {},
        setTurnLabel: () => {},
        setVisible: () => {},
        isVisible: () => true,
      };
      const bridge = (window as any).ChatPetBridge;
      bridge.init(pet);
      bridge.applyHarnessStepToPet({
        type: 'execution_plan_update',
        patch: { progress: 100 },
      }, false, false);
      bridge.applyHarnessStepToPet({ type: 'task_graph_done' }, false, false);
      bridge.applyHarnessStepToPet({
        type: 'final',
        stopReason: 'model_done',
      }, false, false);
      const afterTerminalEvents = clearCount;
      bridge.showThinking(false);
      return { afterTerminalEvents, afterNewTask: clearCount };
    }, PET_BRIDGE_SOURCE);

    expect(result).toEqual({ afterTerminalEvents: 0, afterNewTask: 1 });
    await page.close();
  });

  it('真实 AppRouter 导航离开聊天页隐藏面板，返回后保留计划并恢复', async () => {
    const page = await browser.newPage();
    openPages.add(page);
    await page.setContent(
      '<html><body><div id="app"><main id="page-container"></main></div>' +
        '<div id="pet-canvas"></div></body></html>',
    );
    await page.evaluate(() => {
      window.location.hash = '#/chat';
      const prefs = {
        showTransparencyPanel: true,
        panelDefaultExpanded: true,
        showLlmActivity: true,
        panelWidth: 360,
      };
      (window as any).EtlPrefs = {
        getKey: (key: keyof typeof prefs) => prefs[key],
      };
      (window as any).ChatExecutionPlanBridge = { isEnabled: () => true };
      (window as any).ChatPetBridge = { syncExecPlanFoot: () => {} };
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
      (window as any).fetch = () => new Promise(() => {});
    });
    await page.addScriptTag({ content: PANEL_SOURCE });
    await page.addScriptTag({ content: APP_SOURCE });
    await page.evaluate(() => {
      (window as any).AppRouter.navigate('chat');
    });

    const result = await page.evaluate((plan) => {
      const panel = (window as any).ChatExecutionPlan;
      const router = (window as any).AppRouter;
      panel.setPlan(plan);
      router.navigate('settings');
      const away = {
        page: document.body.dataset.page,
        open: document.body.classList.contains('etl-panel-open'),
        petHidden: document.body.classList.contains('etl-pet-hidden-by-panel'),
        planId: panel.getPlan()?.planId,
      };
      router.navigate('chat');
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
        planId: 'lifecycle-plan',
      },
      returned: {
        page: 'chat',
        open: true,
        planId: 'lifecycle-plan',
      },
    });
    await page.close();
  });
});
