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
const CONFIG_SOURCE = readFileSync(
  path.join(__dirname, '../../src/public/js/config-page.js'),
  'utf-8',
);
const CONFIG_CSS_SOURCE = readFileSync(
  path.join(__dirname, '../../src/public/css/config.css'),
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

async function loadPanel(
  showTransparencyPanel = true,
  mobile = false,
): Promise<Page> {
  const page = await browser.newPage();
  openPages.add(page);
  await page.setContent(
    '<html' + (mobile ? ' data-shell="mobile"' : '') + '><body>' +
      '<nav id="top-nav"></nav><main class="page-container"></main>' +
      '<div id="pet-canvas"></div></body></html>',
  );
  await page.evaluate(({ showPanel }) => {
    const localValues: Record<string, string> = {};
    Object.defineProperty(window, 'localStorage', {
      configurable: true,
      value: {
        getItem: (key: string) => localValues[key] ?? null,
        setItem: (key: string, value: string) => { localValues[key] = String(value); },
        removeItem: (key: string) => { delete localValues[key]; },
        clear: () => { Object.keys(localValues).forEach((key) => delete localValues[key]); },
      },
    });
    const prefs: Record<string, unknown> = {
      showTransparencyPanel: showPanel,
      panelDefaultExpanded: true,
      panelWidth: 360,
    };
    const prefListeners: Array<() => void> = [];
    (window as any).EtlPrefs = {
      get: () => ({ ...prefs }),
      getKey: (key: string) => prefs[key],
      set: (patch: Record<string, unknown>) => {
        Object.assign(prefs, patch);
        prefListeners.slice().forEach((listener) => listener());
        return Promise.resolve(true);
      },
      onChange: (listener: () => void) => {
        prefListeners.push(listener);
        return () => {
          const index = prefListeners.indexOf(listener);
          if (index >= 0) prefListeners.splice(index, 1);
        };
      },
      whenReady: () => Promise.resolve(),
    };
    (window as any).ChatExecutionPlanBridge = { isEnabled: () => true };
    (window as any).ChatPetBridge = { syncExecPlanFoot: () => {} };
  }, { showPanel: showTransparencyPanel });
  await page.addScriptTag({ content: PANEL_SOURCE });
  return page;
}

function makePlan(stepCount = 1) {
  const now = Date.now();
  return {
    planId: 'phase-8-plan',
    progress: 0,
    activeStepId: 'step-0',
    createdAt: now,
    updatedAt: now,
    steps: Array.from({ length: stepCount }, (_, index) => ({
      id: `step-${index}`,
      title: `步骤 ${index}`,
      status: index === 0 ? 'running' : 'pending',
      startedAt: index === 0 ? now : undefined,
    })),
  };
}

describe('phase 8 — 执行透明层 Observer 红线', () => {
  it('主开关关闭时不残留面板 DOM', async () => {
    const page = await loadPanel(false);
    const petHidden = await page.evaluate((plan) => {
      const panel = (window as any).ChatExecutionPlan;
      panel.setPlan(plan);
      panel.requestExpandFromPet();
      return document.body.classList.contains('etl-pet-hidden-by-panel');
    }, makePlan());

    expect(await page.locator('#exec-transparency-panel').count()).toBe(0);
    expect(await page.locator('#pet-canvas').count()).toBe(1);
    expect(petHidden).toBe(false);
    await page.close();
  });

  it('主开关关闭且无列表 DOM 时 applyPatch 仍更新 currentPlan', async () => {
    const page = await loadPanel(false);
    const result = await page.evaluate((plan) => {
      const panel = (window as any).ChatExecutionPlan;
      panel.setPlan(plan);
      panel.applyPatch({
        stepPatches: [{ id: 'step-0', status: 'done', endedAt: 1234 }],
        activeStepId: null,
        progress: 100,
        updatedAt: 1234,
      });
      return {
        domCount: document.querySelectorAll('#exec-transparency-panel').length,
        plan: panel.getPlan(),
      };
    }, makePlan());

    expect(result.domCount).toBe(0);
    expect(result.plan).toMatchObject({
      progress: 100,
      updatedAt: 1234,
      activeStepId: undefined,
      steps: [{ id: 'step-0', status: 'done', endedAt: 1234 }],
    });
    await page.close();
  });

  it('完成后面板、Footer 与 Timeline 定格，当前卡显示完成用时', async () => {
    const page = await loadPanel();
    const result = await page.evaluate(async (plan) => {
      const panel = (window as any).ChatExecutionPlan;
      const completedAt = plan.createdAt + 5000;
      plan.steps[0].startedAt = plan.createdAt;
      panel.beginTurnTimer(plan.createdAt);
      panel.setPlan(plan);
      panel.applyPatch({
        stepPatches: [{ id: 'step-0', status: 'done', endedAt: completedAt }],
        activeStepId: null,
        progress: 100,
        updatedAt: completedAt,
      });
      panel.endTurnTimer(completedAt);
      const read = () => ({
        panelOpen: document.body.classList.contains('etl-panel-open'),
        currentStatus: document.querySelector('#etl-current-step .etl-cs-status')?.textContent,
        footerTime: document.querySelector('.etl-foot-time b')?.textContent,
      });
      const before = read();
      await new Promise((resolve) => setTimeout(resolve, 1100));
      return { before, after: read() };
    }, makePlan());

    expect(result.before).toEqual({
      panelOpen: true,
      currentStatus: '✅ 已完成 · 用时 00:05',
      footerTime: '00:05',
    });
    expect(result.after).toEqual(result.before);
    await page.close();
  });

  it('轮次从中间开始时显示前缀提示，并将「加载更早」置于列表顶部', async () => {
    const page = await loadPanel();
    const result = await page.evaluate(() => {
      const panel = (window as any).ChatExecutionPlan;
      panel.beginTurnTimer(Date.now());
      for (let iteration = 19; iteration <= 29; iteration += 1) {
        panel.applyToolActivity({
          type: 'tool_call',
          iteration,
          toolCallId: 'tool-' + iteration,
          toolName: 'run_command',
          toolArgs: { command: 'check bg_' + iteration },
        });
        panel.applyToolActivity({
          type: 'tool_result',
          iteration,
          toolCallId: 'tool-' + iteration,
          toolName: 'run_command',
          toolSuccess: true,
        });
      }
      const timeline = document.querySelector('#etl-round-timeline');
      const loadMore = document.querySelector('#etl-round-load-more');
      const list = document.querySelector('.etl-round-list');
      const hint = document.querySelector('#etl-round-prefix-hint');
      return {
        hintText: hint?.textContent || '',
        hintHidden: hint?.classList.contains('hidden') ?? true,
        loadMoreHidden: loadMore?.classList.contains('hidden') ?? true,
        loadMoreBeforeList: !!(timeline && loadMore && list
          && loadMore.compareDocumentPosition(list) & Node.DOCUMENT_POSITION_FOLLOWING),
      };
    });

    expect(result.hintHidden).toBe(false);
    expect(result.hintText).toContain('轮次 1–18');
    expect(result.loadMoreHidden).toBe(true);
    expect(result.loadMoreBeforeList).toBe(true);
    await page.close();
  });

  it('model_done 时定格 Footer 模型工作时间，后台仍 processing 也不再累加', async () => {
    const page = await loadPanel();
    const result = await page.evaluate(async () => {
      const panel = (window as any).ChatExecutionPlan;
      const startedAt = 100_000;
      const modelDoneAt = startedAt + 65_000;
      panel.beginTurnTimer(startedAt);
      panel.applyRoundActivity({
        type: 'model_task_final',
        iteration: 1,
        stopReason: 'model_done',
        ts: modelDoneAt,
      });
      const read = () => document.querySelector('.etl-foot-time b')?.textContent;
      const frozen = read();
      await new Promise((resolve) => setTimeout(resolve, 1100));
      return { frozen, afterWait: read() };
    });

    expect(result.frozen).toBe('01:05');
    expect(result.afterWait).toBe('01:05');
    await page.close();
  });

  it('全部步骤进入终态但 patch 无 updatedAt 时按步骤结束时间定格', async () => {
    const page = await loadPanel();
    const result = await page.evaluate((plan) => {
      const panel = (window as any).ChatExecutionPlan;
      plan.steps[0].startedAt = plan.createdAt;
      panel.beginTurnTimer(plan.createdAt);
      panel.setPlan(plan);
      panel.applyPatch({
        stepPatches: [{
          id: 'step-0',
          status: 'done',
          endedAt: plan.createdAt + 4000,
        }],
        activeStepId: null,
      });
      panel.endTurnTimer(plan.createdAt + 4000);
      return {
        progress: panel.getPlan()?.progress,
        open: document.body.classList.contains('etl-panel-open'),
        currentStatus: document.querySelector('#etl-current-step .etl-cs-status')?.textContent,
        footerTime: document.querySelector('.etl-foot-time b')?.textContent,
      };
    }, makePlan());

    expect(result).toEqual({
      progress: 0,
      open: true,
      currentStatus: '✅ 已完成 · 用时 00:04',
      footerTime: '00:04',
    });
    await page.close();
  });

  it('完成态拒绝同 plan patch 与旧 REST 快照倒退，新 planId 才解冻', async () => {
    const page = await loadPanel();
    const result = await page.evaluate((plan) => {
      const panel = (window as any).ChatExecutionPlan;
      const completedAt = plan.createdAt + 5000;
      plan.steps[0].startedAt = plan.createdAt;
      panel.beginTurnTimer(plan.createdAt);
      panel.setPlan(plan);
      panel.applyPatch({
        stepPatches: [{ id: 'step-0', status: 'done', endedAt: completedAt }],
        activeStepId: null,
        progress: 100,
        updatedAt: completedAt,
      });
      panel.endTurnTimer(completedAt);
      const frozenFooter = document.querySelector('.etl-foot-time b')?.textContent;
      panel.applyPatch({
        stepPatches: [{
          id: 'step-0',
          status: 'done',
          endedAt: completedAt + 1000,
        }],
        progress: 100,
        updatedAt: completedAt + 1000,
      });
      panel.applyPatch({
        stepPatches: [{ id: 'step-0', status: 'running', endedAt: null }],
        activeStepId: 'step-0',
        progress: 25,
        updatedAt: plan.createdAt + 1000,
      });
      panel.setPlan({
        ...plan,
        progress: 10,
        activeStepId: 'step-0',
        updatedAt: plan.createdAt + 1000,
        steps: [{ ...plan.steps[0], status: 'running', endedAt: undefined }],
      });
      const frozen = {
        progress: panel.getPlan()?.progress,
        status: panel.getPlan()?.steps[0]?.status,
        updatedAtDelta: panel.getPlan()?.updatedAt - completedAt,
        footerTime: document.querySelector('.etl-foot-time b')?.textContent,
        frozenFooter,
      };
      panel.setPlan({
        ...plan,
        planId: 'next-plan',
        progress: 0,
        activeStepId: 'step-0',
        updatedAt: completedAt + 1000,
        steps: [{
          ...plan.steps[0],
          status: 'running',
          startedAt: completedAt + 1000,
          endedAt: undefined,
        }],
      });
      return {
        frozen,
        next: {
          planId: panel.getPlan()?.planId,
          progress: panel.getPlan()?.progress,
          status: panel.getPlan()?.steps[0]?.status,
        },
      };
    }, makePlan());

    expect(result).toEqual({
      frozen: {
        progress: 100,
        status: 'done',
        updatedAtDelta: 0,
        footerTime: '00:05',
        frozenFooter: '00:05',
      },
      next: {
        planId: 'next-plan',
        progress: 0,
        status: 'running',
      },
    });
    await page.close();
  });

  it('TaskGraph 节点将 progress 推到 100 后同样冻结', async () => {
    const page = await loadPanel();
    const result = await page.evaluate((plan) => {
      const panel = (window as any).ChatExecutionPlan;
      panel.setPlan(plan);
      panel.updateGraphNode({ nodeId: 'step-0', nodeIndex: 3 });
      panel.applyPatch({ progress: 25, updatedAt: plan.updatedAt + 1000 });
      return {
        progress: panel.getPlan()?.progress,
        open: document.body.classList.contains('etl-panel-open'),
      };
    }, makePlan());

    expect(result).toEqual({ progress: 100, open: true });
    await page.close();
  });

  it('聊天页无计划时显示明确问答空态', async () => {
    const page = await loadPanel();
    const result = await page.evaluate(() => {
      const panel = (window as any).ChatExecutionPlan;
      panel.setPageActive(true);
      panel.setVisible(true);
      return {
        open: document.body.classList.contains('etl-panel-open'),
        emptyText: document.querySelector('.etl-plan-empty')?.textContent,
      };
    });

    expect(result).toEqual({
      open: true,
      emptyText: '本次任务无结构化执行计划',
    });
    await page.close();
  });

  it.each([false, true])('跨页隐藏并保留状态，返回聊天页恢复（mobile=%s）', async (mobile) => {
    const page = await loadPanel(true, mobile);
    const result = await page.evaluate((plan) => {
      const panel = (window as any).ChatExecutionPlan;
      panel.setPlan(plan);
      panel.setPageActive(false);
      const away = {
        panelOpen: document.body.classList.contains('etl-panel-open'),
        sheetOpen: document.body.classList.contains('etl-msheet-open'),
        petHidden: document.body.classList.contains('etl-pet-hidden-by-panel'),
        planId: panel.getPlan()?.planId,
      };
      panel.setPageActive(true);
      return {
        away,
        returned: {
          panelOpen: document.body.classList.contains('etl-panel-open'),
          mobileBarOpen: document.querySelector('.etl-mbar')?.classList.contains('etl-mbar--open') || false,
          planId: panel.getPlan()?.planId,
        },
      };
    }, makePlan());

    expect(result.away).toEqual({
      panelOpen: false,
      sheetOpen: false,
      petHidden: false,
      planId: 'phase-8-plan',
    });
    expect(result.returned.planId).toBe('phase-8-plan');
    expect(result.returned.panelOpen || result.returned.mobileBarOpen).toBe(true);
    await page.close();
  });

  it('顶层渲染异常 teardown 并恢复宠物，后续合法事件可重新挂载', async () => {
    const page = await loadPanel();
    const result = await page.evaluate((plan) => {
      const panel = (window as any).ChatExecutionPlan;
      panel.setPlan(plan);
      const current = document.querySelector('#etl-current-step') as HTMLElement;
      Object.defineProperty(current, 'innerHTML', {
        configurable: true,
        set() { throw new Error('fatal render injection'); },
      });

      let escaped = false;
      try {
        panel.applyPatch({ progress: 20, updatedAt: Date.now() });
      } catch {
        escaped = true;
      }
      const afterFatal = {
        escaped,
        panelCount: document.querySelectorAll('#exec-transparency-panel').length,
        petHidden: document.body.classList.contains('etl-pet-hidden-by-panel'),
        layoutOpen: document.body.classList.contains('etl-panel-open'),
      };
      panel.setPlan({ ...plan, progress: 30, updatedAt: Date.now() });
      return {
        afterFatal,
        recoveredPanelCount: document.querySelectorAll('#exec-transparency-panel').length,
        recoveredOpen: document.body.classList.contains('etl-panel-open'),
      };
    }, makePlan());

    expect(result).toEqual({
      afterFatal: {
        escaped: false,
        panelCount: 0,
        petHidden: false,
        layoutOpen: false,
      },
      recoveredPanelCount: 1,
      recoveredOpen: true,
    });
    await page.close();
  });

  it('fatal teardown 后普通合法 patch 可重新挂载并恢复显示', async () => {
    const page = await loadPanel();
    const result = await page.evaluate((plan) => {
      const panel = (window as any).ChatExecutionPlan;
      panel.setPlan(plan);
      const current = document.querySelector('#etl-current-step') as HTMLElement;
      Object.defineProperty(current, 'innerHTML', {
        configurable: true,
        set() { throw new Error('fatal patch injection'); },
      });
      panel.applyPatch({ progress: 20, updatedAt: plan.updatedAt + 1000 });
      const afterFatal = document.querySelectorAll('#exec-transparency-panel').length;
      panel.applyPatch({ progress: 30, updatedAt: plan.updatedAt + 2000 });
      return {
        afterFatal,
        panelCount: document.querySelectorAll('#exec-transparency-panel').length,
        open: document.body.classList.contains('etl-panel-open'),
        progress: panel.getPlan()?.progress,
      };
    }, makePlan());

    expect(result).toEqual({
      afterFatal: 0,
      panelCount: 1,
      open: true,
      progress: 30,
    });
    await page.close();
  });

  it('TaskGraph 顶层渲染异常统一 teardown，且新计划可恢复', async () => {
    const page = await loadPanel();
    const result = await page.evaluate((basePlan) => {
      const panel = (window as any).ChatExecutionPlan;
      const outcomes: Record<string, { count: number; petHidden: boolean }> = {};
      let sequence = 0;
      const recover = () => {
        sequence += 1;
        panel.setPlan({
          ...basePlan,
          planId: `graph-recovery-${sequence}`,
          progress: 0,
          steps: [{ ...basePlan.steps[0], status: 'running', endedAt: undefined }],
        });
      };
      const record = (name: string) => {
        outcomes[name] = {
          count: document.querySelectorAll('#exec-transparency-panel').length,
          petHidden: document.body.classList.contains('etl-pet-hidden-by-panel'),
        };
      };

      recover();
      const currentForUpdate = document.querySelector('#etl-current-step') as HTMLElement;
      Object.defineProperty(currentForUpdate, 'innerHTML', {
        configurable: true,
        set() { throw new Error('updateGraphNode injection'); },
      });
      panel.updateGraphNode({ nodeId: 'step-0', nodeIndex: 0 });
      record('updateGraphNode');
      delete (currentForUpdate as any).innerHTML;

      recover();
      const list = document.querySelector('#exec-plan-list') as HTMLOListElement;
      Object.defineProperty(list, 'querySelectorAll', {
        configurable: true,
        value: () => { throw new Error('highlightGraphBranch injection'); },
      });
      panel.highlightGraphBranch({});
      record('highlightGraphBranch');
      delete (list as any).querySelectorAll;

      recover();
      const currentForComplete = document.querySelector('#etl-current-step') as HTMLElement;
      Object.defineProperty(currentForComplete, 'innerHTML', {
        configurable: true,
        set() { throw new Error('markGraphComplete injection'); },
      });
      panel.markGraphComplete();
      record('markGraphComplete');
      delete (currentForComplete as any).innerHTML;

      recover();
      const currentForRender = document.querySelector('#etl-current-step') as HTMLElement;
      Object.defineProperty(currentForRender, 'innerHTML', {
        configurable: true,
        set() { throw new Error('renderGraph injection'); },
      });
      panel.renderGraph({
        plan: {
          ...basePlan,
          planId: 'graph-render-fatal',
          steps: [{ ...basePlan.steps[0] }],
        },
      });
      record('renderGraph');
      delete (currentForRender as any).innerHTML;

      recover();
      return {
        outcomes,
        recovered: document.body.classList.contains('etl-panel-open'),
      };
    }, makePlan());

    expect(result).toEqual({
      outcomes: {
        updateGraphNode: { count: 0, petHidden: false },
        highlightGraphBranch: { count: 0, petHidden: false },
        markGraphComplete: { count: 0, petHidden: false },
        renderGraph: { count: 0, petHidden: false },
      },
      recovered: true,
    });
    await page.close();
  });

  it.each(['node', 'branch', 'done'] as const)(
    'TaskGraph %s fatal 后下一条同类合法事件自行恢复完整面板',
    async (kind) => {
      const page = await loadPanel();
      const result = await page.evaluate(({ plan, kind }) => {
        const panel = (window as any).ChatExecutionPlan;
        panel.setPlan(plan);

        if (kind === 'node') {
          const current = document.querySelector('#etl-current-step') as HTMLElement;
          Object.defineProperty(current, 'innerHTML', {
            configurable: true,
            set() { throw new Error('node fatal injection'); },
          });
          panel.updateGraphNode({ nodeId: 'step-0', nodeIndex: 0 });
          delete (current as any).innerHTML;
          panel.updateGraphNode({ nodeId: 'step-0', nodeIndex: 1 });
        } else if (kind === 'branch') {
          const list = document.querySelector('#exec-plan-list') as HTMLOListElement;
          Object.defineProperty(list, 'querySelectorAll', {
            configurable: true,
            value: () => { throw new Error('branch fatal injection'); },
          });
          panel.highlightGraphBranch({});
          delete (list as any).querySelectorAll;
          panel.highlightGraphBranch({});
        } else {
          const current = document.querySelector('#etl-current-step') as HTMLElement;
          Object.defineProperty(current, 'innerHTML', {
            configurable: true,
            set() { throw new Error('done fatal injection'); },
          });
          panel.markGraphComplete();
          delete (current as any).innerHTML;
          panel.markGraphComplete();
        }

        return {
          panelCount: document.querySelectorAll('#exec-transparency-panel').length,
          open: document.body.classList.contains('etl-panel-open'),
          petHidden: document.body.classList.contains('etl-pet-hidden-by-panel'),
          stepCount: document.querySelectorAll('.exec-plan-step').length,
          progress: panel.getPlan()?.progress,
          branchMarked: document.querySelector('.exec-plan-step')
            ?.classList.contains('exec-plan-step--fallback') || false,
        };
      }, { plan: makePlan(), kind });

      expect(result.panelCount).toBe(1);
      expect(result.open).toBe(true);
      expect(result.petHidden).toBe(true);
      expect(result.stepCount).toBe(1);
      if (kind === 'node') expect(result.progress).toBe(50);
      if (kind === 'branch') expect(result.branchMarked).toBe(true);
      if (kind === 'done') expect(result.progress).toBe(100);
      await page.close();
    },
  );

  it('主开关关闭不挂面板，但冰豆仍可读取进行中计划摘要', async () => {
    const page = await loadPanel(false);
    const result = await page.evaluate((plan) => {
      const panel = (window as any).ChatExecutionPlan;
      panel.setPlan(plan);
      panel.applyExecutionModeEvent({
        type: 'execution_mode_enter',
        executionMode: { executionMode: 'forced', enteredByPrimary: 'explicit_impl' },
      });
      return {
        panelCount: document.querySelectorAll('#exec-transparency-panel').length,
        live: panel.isPlanLive(),
        summary: panel.formatFootSummary(panel.getPlan()),
        petHidden: document.body.classList.contains('etl-pet-hidden-by-panel'),
      };
    }, makePlan());

    expect(result).toEqual({
      panelCount: 0,
      live: true,
      summary: '0/1 · 进行中 · 步骤 0',
      petHidden: false,
    });
    await page.close();
  });

  it('设置页离开后返回可继续响应 capability 与偏好变化', async () => {
    const page = await browser.newPage();
    openPages.add(page);
    await page.setContent('<html><body><main id="settings-root"></main></body></html>');
    await page.evaluate(() => {
      let enabled = false;
      const prefListeners: Array<() => void> = [];
      const prefs = {
        showTransparencyPanel: false,
        panelDefaultExpanded: true,
        panelWidth: 360,
      };
      (window as any).__setCapability = (value: boolean) => { enabled = value; };
      (window as any).__setShowPanel = (value: boolean) => { prefs.showTransparencyPanel = value; };
      (window as any).__emitPrefs = () => { prefListeners.slice().forEach((fn) => fn()); };
      (window as any).ChatExecutionPlanBridge = { isEnabled: () => enabled };
      (window as any).EtlPrefs = {
        get: () => ({ ...prefs }),
        set: (patch: Record<string, unknown>) => {
          Object.assign(prefs, patch);
          return Promise.resolve(true);
        },
        onChange: (fn: () => void) => {
          prefListeners.push(fn);
          return () => {
            const index = prefListeners.indexOf(fn);
            if (index >= 0) prefListeners.splice(index, 1);
          };
        },
        whenReady: () => Promise.resolve(),
      };
      (window as any).AppShell = { getTheme: () => 'dark' };
      (window as any).AppRouter = { isSetupRequired: () => false };
    });
    await page.addScriptTag({ content: CONFIG_SOURCE });

    const result = await page.evaluate(() => {
      const root = document.querySelector('#settings-root') as HTMLElement;
      const settings = (window as any).SettingsPage;
      settings.render(root);
      const input = () => document.querySelector('#etl-show-panel') as HTMLInputElement;
      const initiallyDisabled = input().disabled;

      (window as any).__setCapability(true);
      window.dispatchEvent(new CustomEvent('etl:capabilitychange', { detail: { enabled: true } }));
      const enabledAfterEvent = !input().disabled;

      settings.onDeactivate();
      (window as any).__setCapability(false);
      window.dispatchEvent(new CustomEvent('etl:capabilitychange', { detail: { enabled: false } }));
      const unchangedWhileInactive = !input().disabled;

      const hasOnActivate = typeof settings.onActivate === 'function';
      if (hasOnActivate) settings.onActivate();
      const disabledAfterReturn = input().disabled;

      (window as any).__setCapability(true);
      window.dispatchEvent(new CustomEvent('etl:capabilitychange', { detail: { enabled: true } }));
      (window as any).__setShowPanel(true);
      (window as any).__emitPrefs();
      return {
        initiallyDisabled,
        enabledAfterEvent,
        unchangedWhileInactive,
        hasOnActivate,
        disabledAfterReturn,
        enabledAfterReactivationEvent: !input().disabled,
        prefCheckedAfterReactivation: input().checked,
      };
    });

    expect(result).toEqual({
      initiallyDisabled: true,
      enabledAfterEvent: true,
      unchangedWhileInactive: true,
      hasOnActivate: true,
      disabledAfterReturn: true,
      enabledAfterReactivationEvent: true,
      prefCheckedAfterReactivation: true,
    });
    await page.close();
  });

  it('AppRouter 返回已挂载桌面或移动设置页时恢复 ConfigPage 生命周期', () => {
    expect(APP_SOURCE).toMatch(/activeSettingsPage\.onActivate\(\)/);
    expect(APP_SOURCE).toMatch(/window\.ConfigPage\.onActivate\(\)/);
  });

  it('桌面面板保留公开契约且仅提供最小化按钮', async () => {
    const page = await loadPanel();
    const result = await page.evaluate((plan) => {
      const panel = (window as any).ChatExecutionPlan;
      panel.setPlan(plan);
      return {
        contract: ['setPlan', 'applyPatch', 'clear', 'setVisible']
          .every((key) => typeof panel[key] === 'function'),
        open: document.body.classList.contains('etl-panel-open'),
        minimizeButtons: document.querySelectorAll('#exec-transparency-panel .etl-minimize').length,
        closeButtons: document.querySelectorAll('#exec-transparency-panel .etl-close').length,
      };
    }, makePlan());

    expect(result).toEqual({
      contract: true,
      open: true,
      minimizeButtons: 1,
      closeButtons: 0,
    });
    await page.close();
  });

  it('最小化回到宠物形态，移动端使用顶部条与底部 sheet', async () => {
    const desktop = await loadPanel();
    const desktopResult = await desktop.evaluate((plan) => {
      const panel = (window as any).ChatExecutionPlan;
      panel.setPlan(plan);
      const petHiddenWhileOpen = document.body.classList.contains('etl-pet-hidden-by-panel');
      panel.minimize();
      return {
        petHiddenWhileOpen,
        petHiddenAfterMinimize: document.body.classList.contains('etl-pet-hidden-by-panel'),
        panelOpen: document.body.classList.contains('etl-panel-open'),
        petExists: !!document.querySelector('#pet-canvas'),
      };
    }, makePlan());
    expect(desktopResult).toEqual({
      petHiddenWhileOpen: true,
      petHiddenAfterMinimize: false,
      panelOpen: false,
      petExists: true,
    });
    await desktop.close();

    const mobile = await loadPanel(true, true);
    const mobileResult = await mobile.evaluate((plan) => {
      const panel = (window as any).ChatExecutionPlan;
      panel.setPlan(plan);
      const petHiddenWhileOpen = document.body.classList.contains('etl-pet-hidden-by-panel');
      panel.minimize();
      return {
        dockedPanelCount: document.querySelectorAll('.etl-panel').length,
        barOpen: document.querySelector('.etl-mbar')?.classList.contains('etl-mbar--open'),
        sheetOpenAfterMinimize: document.querySelector('.etl-msheet')?.classList.contains('etl-msheet--open'),
        petHiddenWhileOpen,
        petHiddenAfterMinimize: document.body.classList.contains('etl-pet-hidden-by-panel'),
        desktopPaddingClass: document.body.classList.contains('etl-panel-open'),
      };
    }, makePlan());
    expect(mobileResult).toEqual({
      dockedPanelCount: 0,
      barOpen: true,
      sheetOpenAfterMinimize: false,
      petHiddenWhileOpen: true,
      petHiddenAfterMinimize: false,
      desktopPaddingClass: false,
    });
    await mobile.close();
  });

  it('打包桌面宠物保持独立，不引用透明层互斥状态', () => {
    const floatingPetSource = readFileSync(
      path.join(__dirname, '../../src/public/js/pet-floating-page.js'),
      'utf-8',
    );
    expect(floatingPetSource).toMatch(/petRequestShowMain/);
    expect(floatingPetSource).not.toMatch(/ChatExecutionPlan|etl-pet-hidden-by-panel/);
  });

  it('缺字段 patch 只跳过坏项，后续合法项仍被消费', async () => {
    const page = await loadPanel();
    const status = await page.evaluate((plan) => {
      const panel = (window as any).ChatExecutionPlan;
      panel.setPlan(plan);
      panel.applyPatch({
        stepPatches: [null, { id: 'step-0', status: 'done', endedAt: Date.now() }],
      });
      return document.querySelector('[data-step-id="step-0"] .exec-plan-step-badge')?.textContent;
    }, makePlan());

    expect(status).toBe('已完成');
    await page.close();
  });

  it('畸形 plan 清空旧 UI，后续合法 plan 仍可处理', async () => {
    const page = await loadPanel();
    const result = await page.evaluate((plan) => {
      const panel = (window as any).ChatExecutionPlan;
      panel.setPlan(plan);
      panel.setPlan({ planId: 'broken', progress: 0, steps: [null] });
      const afterBroken = {
        listCount: document.querySelectorAll('.exec-plan-step').length,
        currentStepHidden: document.querySelector('#etl-current-step')?.classList.contains('hidden'),
      };
      panel.setPlan({ ...plan, planId: 'recovered' });
      return {
        afterBroken,
        recoveredCount: document.querySelectorAll('.exec-plan-step').length,
      };
    }, makePlan());

    expect(result).toEqual({
      afterBroken: { listCount: 0, currentStepHidden: true },
      recoveredCount: 1,
    });
    await page.close();
  });

  it('超大执行计划列表有界，不创建海量步骤节点', async () => {
    const page = await loadPanel();
    const result = await page.evaluate((plan) => {
      (window as any).ChatExecutionPlan.setPlan(plan);
      return {
        listCount: document.querySelectorAll('.exec-plan-step').length,
      };
    }, makePlan(1200));

    expect(result.listCount).toBe(0);
    await page.close();
  });

  it('Footer 展示本轮对话耗时，并接收运行统计', async () => {
    const page = await loadPanel();
    const result = await page.evaluate((plan) => {
      const panel = (window as any).ChatExecutionPlan;
      panel.beginTurnTimer(plan.createdAt);
      panel.setPlan(plan);
      panel.applyRuntimeStats({
        totalTokenUsage: { effectiveUsed: 1200, contextWindow: 8000 },
        totalToolCalls: 3,
      });
      panel.endTurnTimer(plan.createdAt + 5000);
      return {
        footerTime: document.querySelector('.etl-foot-time b')?.textContent,
        contextLabel: document.querySelector('.etl-foot-token')?.textContent,
        token: document.querySelector('.etl-foot-token b')?.textContent,
        tools: document.querySelector('.etl-foot-tool b')?.textContent,
      };
    }, makePlan());

    expect(result.footerTime).toBe('00:05');
    expect(result.contextLabel).toContain('上下文');
    expect(result.token).toBe('1,200/8K (15.0%)');
    expect(result.tools).toBe('3');
    await page.close();
  });

  it('clear 后清除上一轮 Footer 统计，避免污染新任务', async () => {
    const page = await loadPanel();
    const result = await page.evaluate((plan) => {
      const panel = (window as any).ChatExecutionPlan;
      panel.setPlan(plan);
      panel.applyRuntimeStats({
        totalTokenUsage: { effectiveUsed: 1200, contextWindow: 8000 },
        totalToolCalls: 3,
      });
      panel.clear();
      panel.setPlan({ ...plan, planId: 'next-plan' });
      return {
        token: document.querySelector('.etl-foot-token b')?.textContent,
        tools: document.querySelector('.etl-foot-tool b')?.textContent,
      };
    }, makePlan());

    expect(result).toEqual({ token: '—', tools: '—' });
    await page.close();
  });

  it('状态更新在缺少 Tooltip 能力时仍可完成', async () => {
    const page = await loadPanel();
    const result = await page.evaluate((plan) => {
      const title = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'title');
      Object.defineProperty(HTMLElement.prototype, 'title', {
        configurable: true,
        get: title?.get,
        set() { throw new Error('tooltip injection'); },
      });

      const panel = (window as any).ChatExecutionPlan;
      panel.setPlan(plan);
      panel.applyPatch({
        stepPatches: [{ id: 'step-0', status: 'done', endedAt: Date.now() }],
      });
      return {
        hasTimeline: !!document.querySelector('#etl-timeline'),
        status: document.querySelector('[data-step-id="step-0"] .exec-plan-step-badge')?.textContent,
      };
    }, makePlan());

    expect(result).toEqual({ hasTimeline: false, status: '已完成' });
    await page.close();
  });

  it('执行流按 toolCallId 配对并只结束匹配的并发调用', async () => {
    const page = await loadPanel();
    const result = await page.evaluate((plan) => {
      const panel = (window as any).ChatExecutionPlan;
      panel.setPlan(plan);
      panel.applyToolActivity({
        type: 'tool_call', toolCallId: 'call-a', toolName: 'read_file', ts: plan.createdAt + 1000,
      });
      panel.applyToolActivity({
        type: 'tool_call', toolCallId: 'call-b', toolName: 'run_command', ts: plan.createdAt + 3000,
      });
      panel.applyToolActivity({
        type: 'tool_result', toolCallId: 'call-a', toolName: 'read_file',
        ts: plan.createdAt + 5000, status: 'done',
      });
      const read = (id: string) => {
        const node = document.querySelector(`[data-tool-call-id="${id}"]`) as HTMLElement | null;
        return {
          status: node?.dataset.status,
          callTs: node?.dataset.callTs,
          resultTs: node?.dataset.resultTs,
          text: node?.textContent,
        };
      };
      return { a: read('call-a'), b: read('call-b') };
    }, makePlan());

    expect(result.a.status).toBe('done');
    expect(result.a.callTs).toBeTruthy();
    expect(result.a.resultTs).toBeTruthy();
    expect(result.a.text).toMatch(/read_file|Read File/i);
    expect(result.b.status).toBe('running');
    expect(result.b.resultTs).toBeUndefined();
    await page.close();
  });

  it('工具 Footer 按唯一调用实时累计，后端总数到达后权威校准', async () => {
    const page = await loadPanel();
    const values = await page.evaluate((plan) => {
      const panel = (window as any).ChatExecutionPlan;
      panel.setPlan(plan);
      const read = () => document.querySelector('.etl-foot-tool b')?.textContent;
      panel.applyToolActivity({ type: 'tool_call', toolCallId: 'a', toolName: 'read_file' });
      const first = read();
      panel.applyToolActivity({ type: 'tool_call', toolCallId: 'a', toolName: 'read_file' });
      const duplicate = read();
      panel.applyToolActivity({ type: 'tool_call', toolCallId: 'b', toolName: 'run_command' });
      const second = read();
      panel.applyRuntimeStats({ totalToolCalls: 7 });
      return { first, duplicate, second, authoritative: read() };
    }, makePlan());

    expect(values).toEqual({ first: '1', duplicate: '1', second: '2', authoritative: '7' });
    await page.close();
  });

  it('工具历史有界且畸形工具事件安全降级', async () => {
    const page = await loadPanel();
    const result = await page.evaluate((plan) => {
      const panel = (window as any).ChatExecutionPlan;
      panel.setPlan(plan);
      let escaped = false;
      try {
        panel.applyToolActivity({ type: 'tool_call', toolCallId: '', toolName: { broken: true } });
        for (let i = 0; i < 140; i += 1) {
          panel.applyToolActivity({
            type: 'tool_call',
            toolCallId: `bounded-${i}`,
            toolName: `tool-${i}`,
            ts: plan.createdAt + i,
          });
        }
      } catch {
        escaped = true;
      }
      return {
        escaped,
        count: document.querySelectorAll('.etl-round-tool').length,
        latest: document.querySelector('[data-tool-call-id="bounded-139"]')?.textContent,
      };
    }, makePlan());

    expect(result.escaped).toBe(false);
    expect(result.count).toBeGreaterThan(0);
    expect(result.count).toBeLessThanOrEqual(100);
    expect(result.latest).toMatch(/tool-139/i);
    await page.close();
  });

  it('桌面/移动均渲染纵向执行流，无旧横向时间轴', async () => {
    const desktop = await loadPanel();
    const desktopResult = await desktop.evaluate((plan) => {
      const panel = (window as any).ChatExecutionPlan;
      panel.setPlan(plan);
      panel.applyToolActivity({
        type: 'tool_call', toolCallId: 't1', toolName: 'read_file', ts: plan.createdAt + 100,
      });
      return {
        hasLegacyTimeline: !!document.querySelector('#etl-timeline, .etl-tl-track'),
        hasRoundTimeline: !!document.querySelector('#etl-round-timeline'),
        roundCount: document.querySelectorAll('.etl-round-card').length,
      };
    }, makePlan());
    expect(desktopResult).toEqual({
      hasLegacyTimeline: false,
      hasRoundTimeline: true,
      roundCount: 1,
    });
    await desktop.close();

    const mobile = await loadPanel(true, true);
    const mobileVertical = await mobile.evaluate((plan) => {
      const panel = (window as any).ChatExecutionPlan;
      panel.setPlan(plan);
      panel.applyToolActivity({
        type: 'tool_call', toolCallId: 't2', toolName: 'read_file', ts: plan.createdAt + 100,
      });
      return {
        hasLegacyTimeline: !!document.querySelector('#etl-timeline, .etl-tl-track'),
        hasRoundTimeline: !!document.querySelector('#etl-round-timeline'),
        vertical: !!document.querySelector('.etl-round-list'),
      };
    }, makePlan());
    expect(mobileVertical).toEqual({
      hasLegacyTimeline: false,
      hasRoundTimeline: true,
      vertical: true,
    });
    await mobile.close();
  });

  it('面板卸载后重新挂载时执行流轮次仍可点击展开', async () => {
    const page = await loadPanel();
    const result = await page.evaluate((plan) => {
      const panel = (window as any).ChatExecutionPlan;
      const prefs = (window as any).EtlPrefs;
      const ts = plan.createdAt + 100;
      panel.setPlan(plan);
      panel.applyToolActivity({
        type: 'tool_call',
        iteration: 1,
        toolCallId: 'round-1-read',
        toolName: 'read_file',
        ts,
      });
      panel.applyToolActivity({
        type: 'tool_result',
        iteration: 1,
        toolCallId: 'round-1-read',
        toolName: 'read_file',
        toolSuccess: true,
        ts: ts + 500,
      });

      const clickFirstRound = () => {
        const row = document.querySelector('#etl-round-timeline .etl-round-row') as HTMLElement | null;
        row?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      };
      const isExpanded = () => !!document.querySelector('#etl-round-timeline .etl-round-node.is-expanded');

      clickFirstRound();
      const expandedBefore = isExpanded();
      if (!expandedBefore) return { expandedBefore, remounted: false, toggledAfterRemount: false };

      return prefs.set({ showTransparencyPanel: false }).then(() => {
        const removed = !document.querySelector('#exec-transparency-panel');
        return prefs.set({ showTransparencyPanel: true }).then(() => {
          panel.setVisible(true);
          panel.setPlan(plan);
          const before = isExpanded();
          clickFirstRound();
          const after = isExpanded();
          return {
            expandedBefore,
            remounted: removed,
            toggledAfterRemount: before !== after,
          };
        });
      });
    }, makePlan());

    expect(result.expandedBefore).toBe(true);
    expect(result.remounted).toBe(true);
    expect(result.toggledAfterRemount).toBe(true);
    await page.close();
  });

  it('刷新后默认展示执行流 Tab', async () => {
    const page = await loadPanel();
    const switched = await page.evaluate((plan) => {
      const panel = (window as any).ChatExecutionPlan;
      panel.setPlan(plan);
      (document.querySelector('[data-tab="snapshot"]') as HTMLButtonElement).click();
      return document.querySelector('.etl-tab.is-active')?.getAttribute('data-tab');
    }, makePlan());
    expect(switched).toBe('snapshot');
    await page.close();

    const freshPage = await loadPanel();
    const defaultTab = await freshPage.evaluate((plan) => {
      (window as any).ChatExecutionPlan.setPlan(plan);
      return document.querySelector('.etl-tab.is-active')?.getAttribute('data-tab');
    }, makePlan());
    expect(defaultTab).toBe('flow');
    await freshPage.close();
  });

  it('移动端切到桌面专属 Tab 时回退 flow', async () => {
    const page = await loadPanel();
    const result = await page.evaluate((plan) => {
      const panel = (window as any).ChatExecutionPlan;
      panel.setPlan(plan);
      (document.querySelector('[data-tab="snapshot"]') as HTMLButtonElement).click();
      document.documentElement.setAttribute('data-shell', 'mobile');
      panel.setPlan({ ...plan, planId: 'mobile-plan' });
      return {
        active: document.querySelector('.etl-tab.is-active')?.getAttribute('data-tab'),
        flowHidden: document.querySelector('[data-panel="flow"]')?.classList.contains('hidden'),
      };
    }, makePlan());

    expect(result).toEqual({ active: 'flow', flowHidden: false });
    await page.close();
  });

  it('移动 sheet 支持 Escape 收起', async () => {
    const page = await loadPanel(true, true);
    const result = await page.evaluate((plan) => {
      (window as any).ChatExecutionPlan.setPlan(plan);
      const before = document.body.classList.contains('etl-msheet-open');
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
      return { before, after: document.body.classList.contains('etl-msheet-open') };
    }, makePlan());

    expect(result).toEqual({ before: true, after: false });
    await page.close();
  });

  it('LLM 当前动作动态保持单条且不读取 reasoning', async () => {
    const page = await loadPanel();
    const result = await page.evaluate((plan) => {
      const panel = (window as any).ChatExecutionPlan;
      panel.setPlan(plan);
      panel.applyToolActivity({
        type: 'tool_call',
        toolCallId: 'safe-call',
        toolName: 'read_file',
        reasoning: '不应展示的推理',
      });
      const first = document.querySelector('#etl-llm-activity')?.textContent;
      panel.applyToolActivity({
        type: 'tool_result',
        toolCallId: 'safe-call',
        toolName: 'read_file',
        reasoning: '仍不应展示',
      });
      const second = document.querySelector('#etl-llm-activity')?.textContent;
      return {
        activityCount: document.querySelectorAll('#etl-llm-activity').length,
        first,
        second,
      };
    }, makePlan());

    expect(result.activityCount).toBe(1);
    expect(result.first).toContain('正在等待工具返回');
    expect(result.first).not.toContain('不应展示');
    expect(result.second).not.toContain('仍不应展示');
    await page.close();
  });

  it('设置页不再暴露已下线的时间轴选项', async () => {
    const page = await loadPanel();
    await page.evaluate(() => {
      const root = document.createElement('main');
      root.id = 'settings-root';
      document.body.appendChild(root);
      (window as any).AppShell = { getTheme: () => 'dark' };
      (window as any).AppRouter = { isSetupRequired: () => false };
    });
    await page.addScriptTag({ content: CONFIG_SOURCE });

    const missing = await page.evaluate(() => {
      (window as any).SettingsPage.render(document.querySelector('#settings-root'));
      return {
        showTimeline: !!document.querySelector('#etl-show-timeline'),
        autoScroll: !!document.querySelector('#etl-auto-scroll'),
        granularity: !!document.querySelector('#etl-timeline-granularity'),
        timeMode: !!document.querySelector('#etl-timeline-time-mode'),
        hasEnabled: !!document.querySelector('#etl-show-panel'),
        hasExpand: !!document.querySelector('#etl-panel-default-expanded'),
        hasLlm: !!document.querySelector('#etl-show-llm-activity'),
        hasWidth: !!document.querySelector('#etl-panel-width'),
      };
    });
    expect(missing).toEqual({
      showTimeline: false,
      autoScroll: false,
      granularity: false,
      timeMode: false,
      hasEnabled: true,
      hasExpand: true,
      hasLlm: false,
      hasWidth: true,
    });
    await page.close();
  });

  it('设置页按 data-shell=mobile 隐藏宽度行，桌面窄视口仍显示', async () => {
    const page = await browser.newPage({ viewport: { width: 1200, height: 844 } });
    openPages.add(page);
    await page.setContent('<html data-shell="mobile"><body><main id="settings-root"></main></body></html>');
    await page.evaluate(() => {
      const prefs: Record<string, unknown> = {
      showTransparencyPanel: true,
      panelDefaultExpanded: true,
      panelWidth: 360,
      };
      (window as any).__prefs = prefs;
      (window as any).ChatExecutionPlanBridge = { isEnabled: () => true };
      (window as any).EtlPrefs = {
        get: () => ({ ...prefs }),
        set: (patch: Record<string, unknown>) => {
          Object.assign(prefs, patch);
          return Promise.resolve(true);
        },
        onChange: () => () => {},
        whenReady: () => Promise.resolve(),
      };
      (window as any).AppShell = { getTheme: () => 'dark' };
      (window as any).AppRouter = { isSetupRequired: () => false };
    });
    await page.addScriptTag({ content: CONFIG_SOURCE });
    await page.addStyleTag({ content: CONFIG_CSS_SOURCE });
    const mobileWide = await page.evaluate(() => {
      (window as any).SettingsPage.render(document.querySelector('#settings-root'));
      const widthRow = document.querySelector('#etl-panel-width-row') as HTMLElement;
      return {
        widthDisplay: getComputedStyle(widthRow).display,
        timeSettingCount: document.querySelectorAll(
          '#etl-timeline-time-mode, #etl-show-timeline, #etl-timeline-granularity, #etl-auto-scroll',
        ).length,
      };
    });

    expect(mobileWide.widthDisplay).toBe('none');
    expect(mobileWide.timeSettingCount).toBe(0);

    await page.setViewportSize({ width: 390, height: 844 });
    const desktopNarrowDisplay = await page.evaluate(() => {
      document.documentElement.removeAttribute('data-shell');
      const widthRow = document.querySelector('#etl-panel-width-row') as HTMLElement;
      return getComputedStyle(widthRow).display;
    });
    expect(desktopNarrowDisplay).toBe('flex');
    await page.close();
  });

  it('状态快照各节点回滚按钮绑定对应 messageId', async () => {
    const page = await loadPanel();
    const result = await page.evaluate(async (plan) => {
      const panel = (window as any).ChatExecutionPlan;
      const entries = [
        { messageId: 'msg-a', preview: 'first', isCursor: false },
        { messageId: 'msg-b', preview: 'second', isCursor: false },
        { messageId: 'msg-c', preview: 'third', isCursor: true },
      ];
      (window as any).ChatSessionStore = { getActiveSessionId: () => 'sess-1' };
      const restored: string[] = [];
      panel.registerSnapshotHandlers({
        onRestore: (id: string) => { restored.push(id); },
        canRestore: () => true,
      });
      const originalFetch = window.fetch;
      window.fetch = async (url: string) => {
        if (String(url).includes('/checkpoints')) {
          return {
            ok: true,
            json: async () => ({ entries }),
          } as Response;
        }
        return originalFetch(url);
      };
      panel.setPlan(plan);
      (document.querySelector('[data-tab="snapshot"]') as HTMLButtonElement).click();
      await new Promise((r) => setTimeout(r, 50));
      const buttons = Array.from(
        document.querySelectorAll('.etl-snapshot-restore-btn'),
      ) as HTMLButtonElement[];
      const attrs = buttons.map((b) => b.getAttribute('data-message-id'));
      buttons.forEach((b) => b.click());
      window.fetch = originalFetch;
      return { attrs, restored };
    }, makePlan());

    expect(result.attrs).toEqual(['msg-a', 'msg-b']);
    expect(result.restored).toEqual(['msg-a', 'msg-b']);
    await page.close();
  });

});
