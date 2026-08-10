/**
 * 从 data/config.json 读写 iceEtlPrefs（执行透明层前端偏好）。
 */

import { promises as fs } from 'node:fs';
import type { IceCoderConfigFile, IceEtlPrefs } from '../web/types.js';
import { readMainConfigFile } from './main-config-supervisor-mode.js';

export const DEFAULT_ICE_ETL_PREFS: IceEtlPrefs = {
  showTransparencyPanel: true,
  panelDefaultExpanded: true,
  panelWidth: 360,
  taskDoneNotification: false,
};

function clampPanelWidth(value: unknown): number {
  const w = typeof value === 'number' ? value : parseInt(String(value ?? ''), 10);
  if (!Number.isFinite(w)) return DEFAULT_ICE_ETL_PREFS.panelWidth;
  return Math.min(480, Math.max(320, w));
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
  out.panelWidth = clampPanelWidth(input.panelWidth);
  return out;
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
