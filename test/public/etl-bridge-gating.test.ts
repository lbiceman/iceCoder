import { beforeEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const BRIDGE_PATH = path.join(__dirname, '../../src/public/js/chat-execution-plan-bridge.js');

interface PanelStub {
  setVisible: ReturnType<typeof vi.fn>;
  minimize: ReturnType<typeof vi.fn>;
  clear: ReturnType<typeof vi.fn>;
  getPlan: ReturnType<typeof vi.fn>;
  setPlan: ReturnType<typeof vi.fn>;
  renderGraph: ReturnType<typeof vi.fn>;
  applyExecutionModeEvent: ReturnType<typeof vi.fn>;
}

interface EtlPrefsStub {
  prefs: Record<string, unknown>;
  getKey: (key: string) => unknown;
  onChange: (fn: () => void) => () => void;
  emit: () => void;
}

interface BridgeApi {
  notifyConnected: (data: unknown) => void;
  notifySessionUpdated: () => void;
  handleStep: (step: unknown) => void;
  fetchAndApply: () => void;
  isEnabled: () => boolean;
}

function makeEtlPrefs(overrides: Record<string, unknown> = {}): EtlPrefsStub {
  const listeners: Array<() => void> = [];
  const prefs: Record<string, unknown> = {
    showTransparencyPanel: false,
    panelDefaultExpanded: true,
    panelWidth: 360,
    ...overrides,
  };
  return {
    prefs,
    getKey: (key: string) => prefs[key],
    onChange: (fn: () => void) => {
      listeners.push(fn);
      return () => {
        const idx = listeners.indexOf(fn);
        if (idx >= 0) listeners.splice(idx, 1);
      };
    },
    emit: () => { listeners.forEach((fn) => fn()); },
  };
}

function loadBridge(
  etlPrefs: EtlPrefsStub,
  panel: PanelStub,
  activeSessionId: { value: string | null } = { value: null },
) {
  const src = readFileSync(BRIDGE_PATH, 'utf-8');
  const fetchSpy = vi.fn(() => Promise.resolve({ ok: false, json: () => Promise.resolve({ plan: null }) }));
  const capabilityEvents: boolean[] = [];
  const context: Record<string, unknown> = {
    console,
    setTimeout,
    encodeURIComponent,
    fetch: fetchSpy,
    CustomEvent: class {
      type: string;
      detail: unknown;
      constructor(type: string, init?: { detail?: unknown }) {
        this.type = type;
        this.detail = init?.detail;
      }
    },
    document: {
      readyState: 'complete',
      documentElement: { getAttribute: () => null },
      addEventListener: () => {},
    },
  };
  const win: Record<string, unknown> = {
    EtlPrefs: etlPrefs,
    ChatExecutionPlan: panel,
    ChatSessionStore: {
      getActiveSessionId: () => activeSessionId.value,
    },
    dispatchEvent: (event: { type: string; detail?: { enabled?: boolean } }) => {
      if (event.type === 'etl:capabilitychange') {
        capabilityEvents.push(!!event.detail?.enabled);
      }
      return true;
    },
  };
  context.window = win;
  Object.assign(context, win);
  vm.createContext(context);
  vm.runInContext(src, context);
  return {
    bridge: win.ChatExecutionPlanBridge as BridgeApi,
    fetchSpy,
    capabilityEvents,
  };
}

function makePanel(): PanelStub {
  return {
    setVisible: vi.fn(),
    minimize: vi.fn(),
    clear: vi.fn(),
    getPlan: vi.fn(() => null),
    setPlan: vi.fn(),
    renderGraph: vi.fn(),
    applyExecutionModeEvent: vi.fn(),
  };
}

describe('phase 6 — 桥接门控与偏好联动', () => {
  let panel: PanelStub;

  beforeEach(() => {
    panel = makePanel();
  });

  it('主开关关时不显示（即使服务端能力开启）', () => {
    const etlPrefs = makeEtlPrefs({ showTransparencyPanel: false });
    const { bridge } = loadBridge(etlPrefs, panel);
    bridge.notifyConnected({ features: { executionPlan: true } });
    expect(panel.setVisible).toHaveBeenLastCalledWith(false);
  });

  it('features.executionPlan=false 时不显示（即使主开关开启）', () => {
    const etlPrefs = makeEtlPrefs({ showTransparencyPanel: true });
    const { bridge } = loadBridge(etlPrefs, panel);
    bridge.notifyConnected({ features: { executionPlan: false } });
    // enabled 为 false 时直接 clear，不会走 ensurePanelVisible
    expect(bridge.isEnabled()).toBe(false);
    expect(panel.setVisible).not.toHaveBeenCalledWith(true);
  });

  it('两层门控同时开启时显示', () => {
    const etlPrefs = makeEtlPrefs({ showTransparencyPanel: true });
    const { bridge } = loadBridge(etlPrefs, panel);
    bridge.notifyConnected({ features: { executionPlan: true } });
    expect(panel.setVisible).toHaveBeenCalledWith(true);
  });

  it('panelDefaultExpanded=false 时初始最小化为宠物形态', () => {
    const etlPrefs = makeEtlPrefs({ showTransparencyPanel: true, panelDefaultExpanded: false });
    const { bridge } = loadBridge(etlPrefs, panel);
    bridge.notifyConnected({ features: { executionPlan: true } });
    expect(panel.minimize).toHaveBeenCalledTimes(1);
  });

  it('panelDefaultExpanded=true 时不最小化', () => {
    const etlPrefs = makeEtlPrefs({ showTransparencyPanel: true, panelDefaultExpanded: true });
    const { bridge } = loadBridge(etlPrefs, panel);
    bridge.notifyConnected({ features: { executionPlan: true } });
    expect(panel.minimize).not.toHaveBeenCalled();
  });

  it('偏好变更即时联动：主开关打开→立即显示', () => {
    const etlPrefs = makeEtlPrefs({ showTransparencyPanel: false });
    const { bridge } = loadBridge(etlPrefs, panel);
    bridge.notifyConnected({ features: { executionPlan: true } });
    panel.setVisible.mockClear();

    etlPrefs.prefs.showTransparencyPanel = true;
    etlPrefs.emit();
    expect(panel.setVisible).toHaveBeenLastCalledWith(true);
  });

  it('偏好变更即时联动：主开关关闭→立即隐藏', () => {
    const etlPrefs = makeEtlPrefs({ showTransparencyPanel: true });
    const { bridge } = loadBridge(etlPrefs, panel);
    bridge.notifyConnected({ features: { executionPlan: true } });
    panel.setVisible.mockClear();

    etlPrefs.prefs.showTransparencyPanel = false;
    etlPrefs.emit();
    expect(panel.setVisible).toHaveBeenLastCalledWith(false);
  });

  it.each([
    { type: 'execution_mode_enter', executionMode: { executionMode: 'forced' } },
    { type: 'execution_plan_init', plan: { planId: 'blocked-plan', steps: [] } },
    { type: 'task_graph_init', plan: { planId: 'blocked-graph', steps: [] } },
  ])('connected 明确关闭能力后 $type 不得反向启用', (step) => {
    const etlPrefs = makeEtlPrefs({ showTransparencyPanel: true });
    const { bridge, capabilityEvents } = loadBridge(etlPrefs, panel);
    bridge.notifyConnected({ features: { executionPlan: false } });

    bridge.handleStep(step);

    expect(bridge.isEnabled()).toBe(false);
    expect(capabilityEvents).toEqual([]);
  });

  it('connected 尚未到达时首个明确计划事件可兼容启用', () => {
    const etlPrefs = makeEtlPrefs({ showTransparencyPanel: true });
    const { bridge, capabilityEvents } = loadBridge(etlPrefs, panel);

    bridge.handleStep({ type: 'execution_plan_init', plan: { planId: 'compat-plan', steps: [] } });

    expect(bridge.isEnabled()).toBe(true);
    expect(panel.setPlan).toHaveBeenCalledTimes(1);
    expect(capabilityEvents).toEqual([true]);
  });

  it('每次 REST 同步读取当前活跃 session，缺失时回退 default', () => {
    const etlPrefs = makeEtlPrefs({ showTransparencyPanel: true });
    const activeSessionId = { value: 'session-a' as string | null };
    const { bridge, fetchSpy } = loadBridge(etlPrefs, panel, activeSessionId);
    bridge.notifyConnected({ features: { executionPlan: true } });
    fetchSpy.mockClear();

    bridge.fetchAndApply();
    activeSessionId.value = 'session-b';
    bridge.fetchAndApply();
    activeSessionId.value = null;
    bridge.fetchAndApply();

    expect(fetchSpy.mock.calls.map((call) => call[0])).toEqual([
      '/api/sessions/session-a/plan',
      '/api/sessions/session-b/plan',
      '/api/sessions/default/plan',
    ]);
  });

  it('跨会话乱序响应不得用旧 session 计划覆盖最新请求', async () => {
    const etlPrefs = makeEtlPrefs({ showTransparencyPanel: true });
    const activeSessionId = { value: 'session-a' as string | null };
    const { bridge, fetchSpy } = loadBridge(etlPrefs, panel, activeSessionId);
    bridge.notifyConnected({ features: { executionPlan: true } });
    fetchSpy.mockClear();
    panel.setPlan.mockClear();

    let resolveA!: (value: { ok: boolean; json: () => Promise<unknown> }) => void;
    let resolveB!: (value: { ok: boolean; json: () => Promise<unknown> }) => void;
    fetchSpy
      .mockImplementationOnce(() => new Promise((resolve) => { resolveA = resolve; }))
      .mockImplementationOnce(() => new Promise((resolve) => { resolveB = resolve; }));

    bridge.fetchAndApply();
    activeSessionId.value = 'session-b';
    bridge.fetchAndApply();

    resolveB({
      ok: true,
      json: () => Promise.resolve({ plan: { planId: 'plan-b', steps: [] } }),
    });
    await new Promise((resolve) => setTimeout(resolve, 0));
    resolveA({
      ok: true,
      json: () => Promise.resolve({ plan: { planId: 'plan-a', steps: [] } }),
    });
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(panel.setPlan.mock.calls.map((call) => call[0].planId)).toEqual(['plan-b']);
  });

  it('请求期间 active session 改变时丢弃该响应', async () => {
    const etlPrefs = makeEtlPrefs({ showTransparencyPanel: true });
    const activeSessionId = { value: 'session-a' as string | null };
    const { bridge, fetchSpy } = loadBridge(etlPrefs, panel, activeSessionId);
    bridge.notifyConnected({ features: { executionPlan: true } });
    fetchSpy.mockClear();
    panel.setPlan.mockClear();

    let resolveRequest!: (value: { ok: boolean; json: () => Promise<unknown> }) => void;
    fetchSpy.mockImplementationOnce(() => new Promise((resolve) => { resolveRequest = resolve; }));
    bridge.fetchAndApply();
    activeSessionId.value = 'session-b';
    resolveRequest({
      ok: true,
      json: () => Promise.resolve({ plan: { planId: 'stale-plan', steps: [] } }),
    });
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(panel.setPlan).not.toHaveBeenCalled();
  });

  it('主开关从关到开时触发 REST 重同步', () => {
    const etlPrefs = makeEtlPrefs({ showTransparencyPanel: false });
    const { bridge, fetchSpy } = loadBridge(etlPrefs, panel);
    bridge.notifyConnected({ features: { executionPlan: true } });
    fetchSpy.mockClear();

    etlPrefs.prefs.showTransparencyPanel = true;
    etlPrefs.emit();

    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });

  it('默认收起对首次开启和每个新 plan 应用一次，同 plan 重连不重复', () => {
    const etlPrefs = makeEtlPrefs({
      showTransparencyPanel: false,
      panelDefaultExpanded: false,
    });
    const { bridge } = loadBridge(etlPrefs, panel, { value: 'session-a' });
    bridge.notifyConnected({ features: { executionPlan: true } });

    etlPrefs.prefs.showTransparencyPanel = true;
    etlPrefs.emit();
    bridge.handleStep({ type: 'execution_plan_init', plan: { planId: 'plan-a', steps: [] } });
    bridge.notifyConnected({ features: { executionPlan: true } });
    bridge.handleStep({ type: 'execution_plan_init', plan: { planId: 'plan-b', steps: [] } });
    bridge.handleStep({ type: 'execution_plan_init', plan: { planId: 'plan-a', steps: [] } });

    expect(panel.minimize).toHaveBeenCalledTimes(3);
  });

  it('新 session 默认收起一次，同 session 重连不重复', () => {
    const etlPrefs = makeEtlPrefs({
      showTransparencyPanel: true,
      panelDefaultExpanded: false,
    });
    const activeSessionId = { value: 'session-a' as string | null };
    const { bridge } = loadBridge(etlPrefs, panel, activeSessionId);
    bridge.notifyConnected({ features: { executionPlan: true } });
    bridge.notifyConnected({ features: { executionPlan: true } });
    activeSessionId.value = 'session-b';
    bridge.notifySessionUpdated();

    expect(panel.minimize).toHaveBeenCalledTimes(2);
  });

  it('capability 改变时广播 UI 事件且相同值不重复广播', () => {
    const etlPrefs = makeEtlPrefs();
    const { bridge, capabilityEvents } = loadBridge(etlPrefs, panel);

    bridge.notifyConnected({ features: { executionPlan: true } });
    bridge.notifyConnected({ features: { executionPlan: true } });
    bridge.notifyConnected({ features: { executionPlan: false } });

    expect(capabilityEvents).toEqual([true, false]);
  });
});
