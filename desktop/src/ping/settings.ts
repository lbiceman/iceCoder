/**
 * 屏幕问号开关和截图边长。跟数据目录指针一样放在共享壳目录，不进模型配置。
 */
import fs from 'node:fs';
import path from 'node:path';
import { ASK_CROP_PX, normalizeCropPx } from './geometry';
import { resolveSharedShellDir } from '../paths';

const FILE_NAME = 'screen-ping.json';

export interface ScreenPingSettings {
  enabled: boolean;
  cropPx: number;
}

function settingsPath(): string {
  return path.join(resolveSharedShellDir(), FILE_NAME);
}

function readRaw(): { enabled?: unknown; cropPx?: unknown } {
  try {
    return JSON.parse(fs.readFileSync(settingsPath(), 'utf8')) as { enabled?: unknown; cropPx?: unknown };
  } catch {
    return {};
  }
}

export function readScreenPingSettings(): ScreenPingSettings {
  const raw = readRaw();
  return {
    enabled: typeof raw.enabled === 'boolean' ? raw.enabled : true,
    cropPx: normalizeCropPx(raw.cropPx, ASK_CROP_PX),
  };
}

export function readScreenPingEnabled(): boolean {
  return readScreenPingSettings().enabled;
}

export function writeScreenPingSettings(patch: Partial<ScreenPingSettings>): ScreenPingSettings {
  const current = readScreenPingSettings();
  const next: ScreenPingSettings = {
    enabled: typeof patch.enabled === 'boolean' ? patch.enabled : current.enabled,
    cropPx: patch.cropPx !== undefined ? normalizeCropPx(patch.cropPx, current.cropPx) : current.cropPx,
  };
  const file = settingsPath();
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(next, null, 2));
  fs.renameSync(tmp, file);
  return next;
}
