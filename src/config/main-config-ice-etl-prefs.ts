/**
 * 从 data/config.json 读写 iceEtlPrefs（执行透明层前端偏好）。
 */

import { promises as fs } from 'node:fs';
import type { IceCoderConfigFile, IceEtlPrefs } from '../web/types.js';
import { readMainConfigFile } from './main-config-supervisor-mode.js';

export const DEFAULT_ICE_ETL_PREFS: IceEtlPrefs = {
  showTransparencyPanel: true,
  panelDefaultExpanded: true,
  panelWidth: 320,
  sidebarWidth: 256,
  taskDoneNotification: false,
  panelAutoCollapse: false,
  showDesktopPet: true,
};

const PANEL_WIDTH_MIN = 240;
const PANEL_WIDTH_MAX = 640;
const SIDEBAR_WIDTH_MIN = 200;
const SIDEBAR_WIDTH_MAX = 480;

function clampWidth(value: unknown, fallback: number, min: number, max: number): number {
  const w = typeof value === 'number' ? value : parseInt(String(value ?? ''), 10);
  if (!Number.isFinite(w)) return fallback;
  return Math.round(Math.min(max, Math.max(min, w)));
}

export function sanitizeIceEtlPrefs(raw: unknown): IceEtlPrefs {
  const out: IceEtlPrefs = { ...DEFAULT_ICE_ETL_PREFS };
  if (!raw || typeof raw !== 'object') return out;

  const input = raw as Record<string, unknown>;
  if (typeof input.showTransparencyPanel === 'boolean') {
    out.showTransparencyPanel = input.showTransparencyPanel;
  }
  if (typeof input.panelDefaultExpanded === 'boolean') {
    out.panelDefaultExpanded = input.panelDefaultExpanded;
  }
  if (typeof input.taskDoneNotification === 'boolean') {
    out.taskDoneNotification = input.taskDoneNotification;
  }
  if (typeof input.panelAutoCollapse === 'boolean') {
    out.panelAutoCollapse = input.panelAutoCollapse;
  }
  if (typeof input.showDesktopPet === 'boolean') {
    out.showDesktopPet = input.showDesktopPet;
  }
  out.panelWidth = clampWidth(input.panelWidth, DEFAULT_ICE_ETL_PREFS.panelWidth, PANEL_WIDTH_MIN, PANEL_WIDTH_MAX);
  out.sidebarWidth = clampWidth(input.sidebarWidth, DEFAULT_ICE_ETL_PREFS.sidebarWidth, SIDEBAR_WIDTH_MIN, SIDEBAR_WIDTH_MAX);
  return out;
}

/**
 * 校验 PATCH 载荷（allowedKeys + 类型规则，均由 IceEtlPrefs 派生）。
 * 返回错误文案，合法返回 null。新增字段只需同步 DEFAULT + sanitize + types.ts + 前端，
 * 路由校验自动覆盖。
 */
export function validateIceEtlPrefsPatch(patch: Record<string, unknown>): string | null {
  const allowedKeys = new Set(Object.keys(DEFAULT_ICE_ETL_PREFS));
  for (const key of Object.keys(patch)) {
    if (!allowedKeys.has(key)) {
      return `iceEtlPrefs 含未知字段：${key}`;
    }
  }
  if (patch.showTransparencyPanel !== undefined && typeof patch.showTransparencyPanel !== 'boolean') {
    return 'showTransparencyPanel 须为 boolean';
  }
  if (patch.panelDefaultExpanded !== undefined && typeof patch.panelDefaultExpanded !== 'boolean') {
    return 'panelDefaultExpanded 须为 boolean';
  }
  if (patch.panelWidth !== undefined && typeof patch.panelWidth !== 'number') {
    return 'panelWidth 须为 number';
  }
  if (patch.sidebarWidth !== undefined && typeof patch.sidebarWidth !== 'number') {
    return 'sidebarWidth 须为 number';
  }
  if (patch.taskDoneNotification !== undefined && typeof patch.taskDoneNotification !== 'boolean') {
    return 'taskDoneNotification 须为 boolean';
  }
  if (patch.panelAutoCollapse !== undefined && typeof patch.panelAutoCollapse !== 'boolean') {
    return 'panelAutoCollapse 须为 boolean';
  }
  if (patch.showDesktopPet !== undefined && typeof patch.showDesktopPet !== 'boolean') {
    return 'showDesktopPet 须为 boolean';
  }
  return null;
}

export function resolveIceEtlPrefs(config: Pick<IceCoderConfigFile, 'iceEtlPrefs'>): IceEtlPrefs {
  return sanitizeIceEtlPrefs(config.iceEtlPrefs);
}

export async function readIceEtlPrefsFromMainConfig(configPath: string): Promise<IceEtlPrefs> {
  const config = await readMainConfigFile(configPath);
  return resolveIceEtlPrefs(config);
}

export async function writeIceEtlPrefsToMainConfig(
  configPath: string,
  patch: Partial<IceEtlPrefs>,
): Promise<IceEtlPrefs> {
  const config = await readMainConfigFile(configPath);
  const next = sanitizeIceEtlPrefs({ ...resolveIceEtlPrefs(config), ...patch });
  config.iceEtlPrefs = next;
  await fs.writeFile(configPath, `${JSON.stringify(config, null, 2)}\n`, 'utf-8');
  return next;
}
