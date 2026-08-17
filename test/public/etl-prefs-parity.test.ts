import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';
import {
  DEFAULT_ICE_ETL_PREFS,
  sanitizeIceEtlPrefs,
} from '../../src/config/main-config-ice-etl-prefs.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ETL_PREFS_PATH = path.join(__dirname, '../../src/public/js/etl-prefs.js');

interface FrontEtlPrefs {
  get: () => Record<string, unknown>;
  set: (patch: Record<string, unknown>) => Promise<boolean>;
}

/**
 * 在无 fetch 的 vm 沙箱中加载前端 etl-prefs.js：
 * - loadFromServer 直接走本地默认（不请求）
 * - set() 走本地 sanitize 路径（fetch 不可用分支）
 */
function loadFrontEtlPrefs(): FrontEtlPrefs {
  const src = readFileSync(ETL_PREFS_PATH, 'utf-8');
  const context: Record<string, unknown> = { window: {}, console };
  context.window = context;
  vm.createContext(context);
  vm.runInContext(src, context);
  return (context.window as { EtlPrefs: FrontEtlPrefs }).EtlPrefs;
}

describe('前后端 iceEtlPrefs 一致性（防漂移）', () => {
  it('默认值完全一致（前端 DEFAULTS == 后端 DEFAULT_ICE_ETL_PREFS）', async () => {
    const front = loadFrontEtlPrefs();
    expect(front.get()).toEqual(DEFAULT_ICE_ETL_PREFS);
  });

  it('超限 panelWidth 两端同样夹紧到 480', async () => {
    const front = loadFrontEtlPrefs();
    await front.set({ panelWidth: 9999 });
    expect(front.get().panelWidth).toBe(480);
    expect(sanitizeIceEtlPrefs({ panelWidth: 9999 }).panelWidth).toBe(480);
  });

  it('过小 panelWidth 两端同样夹紧到 320', async () => {
    const front = loadFrontEtlPrefs();
    await front.set({ panelWidth: 10 });
    expect(front.get().panelWidth).toBe(320);
    expect(sanitizeIceEtlPrefs({ panelWidth: 10 }).panelWidth).toBe(320);
  });

  it('类型不符的字段两端同样回退默认', async () => {
    const patch = {
      showTransparencyPanel: 'yes' as unknown,
      panelDefaultExpanded: 1 as unknown,
      taskDoneNotification: 'true' as unknown,
      panelAutoCollapse: 'yes' as unknown,
      panelWidth: 'abc' as unknown,
    };
    const front = loadFrontEtlPrefs();
    await front.set(patch);
    expect(front.get()).toEqual(sanitizeIceEtlPrefs({ ...DEFAULT_ICE_ETL_PREFS, ...patch }));
  });

  it('合法布尔 patch 两端同样生效', async () => {
    const patch = { showTransparencyPanel: false, taskDoneNotification: true, panelAutoCollapse: true };
    const front = loadFrontEtlPrefs();
    await front.set(patch);
    expect(front.get()).toEqual(sanitizeIceEtlPrefs({ ...DEFAULT_ICE_ETL_PREFS, ...patch }));
  });

  it('null/非对象输入两端同样返回默认', async () => {
    const front = loadFrontEtlPrefs();
    expect(sanitizeIceEtlPrefs(null)).toEqual(DEFAULT_ICE_ETL_PREFS);
    expect(sanitizeIceEtlPrefs('junk')).toEqual(DEFAULT_ICE_ETL_PREFS);
    // 前端本地路径对非对象 patch 拒绝修改
    await expect(front.set(null as never)).resolves.toBe(false);
    expect(front.get()).toEqual(DEFAULT_ICE_ETL_PREFS);
  });
});
