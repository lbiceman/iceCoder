import { beforeEach, describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ETL_PREFS_PATH = path.join(__dirname, '../../src/public/js/etl-prefs.js');

function createMemoryStorage(): Storage {
  const map = new Map<string, string>();
  return {
    get length() { return map.size; },
    clear() { map.clear(); },
    getItem(key: string) { return map.has(key) ? map.get(key)! : null; },
    key(index: number) { return [...map.keys()][index] ?? null; },
    removeItem(key: string) { map.delete(key); },
    setItem(key: string, value: string) { map.set(key, value); },
  };
}

function loadEtlPrefs(storage: Storage) {
  const src = readFileSync(ETL_PREFS_PATH, 'utf-8');
  const context: Record<string, unknown> = {
    window: {},
    localStorage: storage,
    console,
  };
  context.window = context;
  vm.createContext(context);
  vm.runInContext(src, context);
  return (context.window as { EtlPrefs: {
    get: () => Record<string, unknown>;
    getKey: (key: string) => unknown;
    set: (patch: Record<string, unknown>) => void;
    onChange: (fn: () => void) => () => void;
  } }).EtlPrefs;
}

describe('etl-prefs', () => {
  let storage: Storage;

  beforeEach(() => {
    storage = createMemoryStorage();
  });

  it('get() 返回默认对象', () => {
    const EtlPrefs = loadEtlPrefs(storage);
    expect(EtlPrefs.get()).toEqual({
      showTransparencyPanel: false,
      panelDefaultExpanded: true,
      showLlmActivity: true,
      panelWidth: 360,
    });
  });

  it('set({ panelWidth: 9999 }) 后读回被夹到 480', () => {
    const EtlPrefs = loadEtlPrefs(storage);
    EtlPrefs.set({ panelWidth: 9999 });
    expect(EtlPrefs.getKey('panelWidth')).toBe(480);
  });

  it('ICE_PLAN_PANEL=0 且缺失 ICE_ETL_PREFS 时迁移 showTransparencyPanel=false', () => {
    storage.setItem('ICE_PLAN_PANEL', '0');
    const EtlPrefs = loadEtlPrefs(storage);
    expect(EtlPrefs.getKey('showTransparencyPanel')).toBe(false);
  });

  it('onChange 仅在实际变化时触发', () => {
    const EtlPrefs = loadEtlPrefs(storage);
    let count = 0;
    EtlPrefs.onChange(() => { count += 1; });
    EtlPrefs.set({ panelWidth: 420 });
    EtlPrefs.set({ panelWidth: 420 });
    expect(count).toBe(1);
  });

  it('忽略已废弃的时间轴偏好键，不写入当前偏好', () => {
    const EtlPrefs = loadEtlPrefs(storage);
    EtlPrefs.set({
      timelineGranularity: 'step+tool',
      timelineTimeMode: 'relative',
      showTimeline: false,
      autoScrollActiveStep: false,
    } as Record<string, unknown>);
    expect(EtlPrefs.get()).toEqual({
      showTransparencyPanel: false,
      panelDefaultExpanded: true,
      showLlmActivity: true,
      panelWidth: 360,
    });
  });
});

describe('phase 1-3 wiring', () => {
  it('main.js 在 config-model-panel 之前 import etl-prefs', () => {
    const mainSrc = readFileSync(
      path.join(__dirname, '../../src/public/js/main.js'),
      'utf-8',
    );
    const etlIdx = mainSrc.indexOf("import './etl-prefs.js'");
    const configIdx = mainSrc.indexOf("import './config-model-panel.js'");
    expect(etlIdx).toBeGreaterThan(-1);
    expect(configIdx).toBeGreaterThan(-1);
    expect(etlIdx).toBeLessThan(configIdx);
  });

  it('session-pet 不再绑定 dblclick 复位', () => {
    const src = readFileSync(
      path.join(__dirname, '../../src/public/js/session-pet.js'),
      'utf-8',
    );
    expect(src).not.toMatch(/addEventListener\('dblclick'[\s\S]*clearCustomPosition/);
  });

  it('chat-page 绑定 requestExpandFromPet 并更新 canvas 文案', () => {
    const src = readFileSync(
      path.join(__dirname, '../../src/public/js/chat-page.js'),
      'utf-8',
    );
    expect(src).toMatch(/requestExpandFromPet/);
    expect(src).toMatch(/双击展开执行透明层/);
  });

  it('chat-page 将后端累计 Token 和工具次数同步到面板 Footer', () => {
    const src = readFileSync(
      path.join(__dirname, '../../src/public/js/chat-page.js'),
      'utf-8',
    );
    expect(src).toMatch(/ChatExecutionPlan\.applyRuntimeStats\(\{[\s\S]*totalTokenUsage:\s*step\.totalTokenUsage[\s\S]*totalToolCalls:\s*step\.totalToolCalls/);
  });
});
