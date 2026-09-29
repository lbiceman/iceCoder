import { beforeEach, describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';
import { classicWindowSource } from './classic-window-source.ts';


const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ETL_PREFS_PATH = path.join(__dirname, '../../src/public/js/etl-prefs.ts');

type FetchHandler = (input: string, init?: { method?: string; body?: string }) => Promise<{
  ok: boolean;
  json: () => Promise<Record<string, unknown>>;
}>;

function createFetchMock(initialPrefs: Record<string, unknown>, onPatch?: (body: unknown) => void): FetchHandler {
  let prefs = { ...initialPrefs };
  return async (_input, init) => {
    if (init?.method === 'PATCH') {
      const body = JSON.parse(init.body || '{}') as { iceEtlPrefs?: Record<string, unknown> };
      onPatch?.(body);
      prefs = {
        panelDefaultExpanded: true,
        panelWidth: 320,
        showTransparencyPanel: true,
        ...prefs,
        ...(body.iceEtlPrefs || {}),
      };
      return {
        ok: true,
        json: async () => ({ success: true, iceEtlPrefs: prefs }),
      };
    }
    return {
      ok: true,
      json: async () => ({ iceEtlPrefs: prefs }),
    };
  };
}

function loadEtlPrefs(fetchImpl: FetchHandler, storage?: Storage) {
  const src = classicWindowSource(readFileSync(ETL_PREFS_PATH, 'utf-8'));
  const memory = new Map<string, string>();
  const localStorage = storage || {
    getItem: (key: string) => memory.get(key) ?? null,
    setItem: (key: string, value: string) => { memory.set(key, String(value)); },
    removeItem: (key: string) => { memory.delete(key); },
  };
  const context: Record<string, unknown> = {
    window: {},
    fetch: fetchImpl,
    localStorage,
    console,
  };
  context.window = context;
  vm.createContext(context);
  vm.runInContext(src, context);
  return (context.window as {
    EtlPrefs: {
      get: () => Record<string, unknown>;
      getKey: (key: string) => unknown;
      set: (patch: Record<string, unknown>) => Promise<boolean>;
      onChange: (fn: () => void) => () => void;
      whenReady: () => Promise<void>;
    };
  }).EtlPrefs;
}

describe('etl-prefs', () => {
  it('whenReady 后从 /api/config 读回 iceEtlPrefs', async () => {
    const EtlPrefs = loadEtlPrefs(createFetchMock({
      showTransparencyPanel: false,
      panelDefaultExpanded: true,
      panelWidth: 320,
    }));
    await EtlPrefs.whenReady();
    expect(EtlPrefs.get()).toEqual({
      showTransparencyPanel: false,
      panelDefaultExpanded: true,
      panelWidth: 320,
      sidebarWidth: 256,
      taskDoneNotification: false,
      panelAutoCollapse: false,
      showDesktopPet: true,
    });
  });

  it('set({ panelWidth: 9999 }) PATCH 后读回被夹到 640', async () => {
    let patched: unknown = null;
    const EtlPrefs = loadEtlPrefs(createFetchMock({}, (body) => { patched = body; }));
    await EtlPrefs.whenReady();
    await EtlPrefs.set({ panelWidth: 9999 });
    expect(patched).toEqual({ iceEtlPrefs: { panelWidth: 9999 } });
    expect(EtlPrefs.getKey('panelWidth')).toBe(640);
  });

  it('onChange 仅在实际变化时触发', async () => {
    const EtlPrefs = loadEtlPrefs(createFetchMock({}));
    await EtlPrefs.whenReady();
    let count = 0;
    EtlPrefs.onChange(() => { count += 1; });
    await EtlPrefs.set({ panelWidth: 380 });
    await EtlPrefs.set({ panelWidth: 380 });
    expect(count).toBe(1);
  });

  it('忽略已废弃的时间轴偏好键，不写入当前偏好', async () => {
    const EtlPrefs = loadEtlPrefs(createFetchMock({}));
    await EtlPrefs.whenReady();
    await EtlPrefs.set({
      timelineGranularity: 'step+tool',
      timelineTimeMode: 'relative',
      showTimeline: false,
      autoScrollActiveStep: false,
    } as Record<string, unknown>);
    expect(EtlPrefs.get()).toEqual({
      showTransparencyPanel: true,
      panelDefaultExpanded: true,
      panelWidth: 320,
      sidebarWidth: 256,
      taskDoneNotification: false,
      panelAutoCollapse: false,
      showDesktopPet: true,
    });
  });

  it('服务端把 panelWidth 收成旧档位时，读回仍是拖拽宽度', async () => {
    const EtlPrefs = loadEtlPrefs(async (_input, init) => {
      if (init?.method === 'PATCH') {
        return {
          ok: true,
          json: async () => ({
            success: true,
            iceEtlPrefs: { panelWidth: 380, showTransparencyPanel: true },
          }),
        };
      }
      return { ok: true, json: async () => ({ iceEtlPrefs: { panelWidth: 280 } }) };
    });
    await EtlPrefs.whenReady();
    await EtlPrefs.set({ panelWidth: 395 });
    expect(EtlPrefs.getKey('panelWidth')).toBe(395);
  });

  it('服务端拒绝 sidebarWidth 时，读回仍是拖拽宽度', async () => {
    const memory = new Map<string, string>();
    const storage = {
      getItem: (key: string) => memory.get(key) ?? null,
      setItem: (key: string, value: string) => { memory.set(key, String(value)); },
      removeItem: (key: string) => { memory.delete(key); },
    } as Storage;
    const fetchImpl: FetchHandler = async (_input, init) => {
      if (init?.method === 'PATCH') {
        return { ok: false, json: async () => ({ error: 'iceEtlPrefs 含未知字段：sidebarWidth' }) };
      }
      return { ok: true, json: async () => ({ iceEtlPrefs: {} }) };
    };
    const first = loadEtlPrefs(fetchImpl, storage);
    await first.whenReady();
    await expect(first.set({ sidebarWidth: 331 })).rejects.toThrow(/未知字段/);
    expect(first.getKey('sidebarWidth')).toBe(331);

    const reloaded = loadEtlPrefs(fetchImpl, storage);
    await reloaded.whenReady();
    expect(reloaded.getKey('sidebarWidth')).toBe(331);
  });
});

describe('phase 1-3 wiring', () => {
  it('main.js 在 config-model-panel 之前 import etl-prefs', () => {
    const mainSrc = classicWindowSource(readFileSync(
      path.join(__dirname, '../../src/public/js/main.ts'),
      'utf-8',
    ));
    const etlIdx = mainSrc.indexOf("import './etl-prefs.ts'");
    const configIdx = mainSrc.indexOf("import './config-model-panel.ts'");
    expect(etlIdx).toBeGreaterThan(-1);
    expect(configIdx).toBeGreaterThan(-1);
    expect(etlIdx).toBeLessThan(configIdx);
  });

  it('session-pet 不再绑定 dblclick 复位', () => {
    const src = classicWindowSource(readFileSync(
      path.join(__dirname, '../../src/public/js/session-pet.js'),
      'utf-8',
    ));
    expect(src).not.toMatch(/addEventListener\('dblclick'[\s\S]*clearCustomPosition/);
  });

  it('chat-page 绑定 requestExpandFromPet 并更新 canvas 文案', () => {
    const src = classicWindowSource(readFileSync(
      path.join(__dirname, '../../src/public/js/chat-page.ts'),
      'utf-8',
    ));
    expect(src).toMatch(/requestExpandFromPet/);
    expect(src).toMatch(/双击展开执行透明层/);
  });

  it('chat-page 将后端累计 Token 和工具次数同步到面板 Footer', () => {
    const src = classicWindowSource(readFileSync(
      path.join(__dirname, '../../src/public/js/chat-ws-stream-handlers.ts'),
      'utf-8',
    ));
    expect(src).toMatch(/ChatExecutionPlan\.applyRuntimeStats\(\{[\s\S]*totalTokenUsage:\s*step\.totalTokenUsage[\s\S]*totalToolCalls:\s*step\.totalToolCalls/);
  });
});
