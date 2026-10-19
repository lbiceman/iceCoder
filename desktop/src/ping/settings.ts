/**
 * 屏幕问号开关，以及截图矩形的宽和高。跟数据目录指针一样放在共享壳目录，不进模型配置。
 */
import fs from 'node:fs';
import path from 'node:path';
import { ASK_CROP_PX, normalizeCropPx } from './geometry';
import { resolveSharedShellDir } from '../paths';

const FILE_NAME = 'screen-ping.json';

export interface ScreenPingSettings {
  enabled: boolean;
  cropWidth: number;
  cropHeight: number;
}

function settingsPath(): string {
  return path.join(resolveSharedShellDir(), FILE_NAME);
}

function readRaw(): { enabled?: unknown; cropPx?: unknown; cropWidth?: unknown; cropHeight?: unknown } {
  try {
    return JSON.parse(fs.readFileSync(settingsPath(), 'utf8')) as {
      enabled?: unknown;
      cropPx?: unknown;
      cropWidth?: unknown;
      cropHeight?: unknown;
    };
  } catch {
    return {};
  }
}

/** 旧配置只有正方形边长 cropPx，宽和高都用它。 */
function readEdge(value: unknown, legacy: unknown): number {
  if (value !== undefined) return normalizeCropPx(value, ASK_CROP_PX);
  if (legacy !== undefined) return normalizeCropPx(legacy, ASK_CROP_PX);
  return ASK_CROP_PX;
}

export function readScreenPingSettings(): ScreenPingSettings {
  const raw = readRaw();
  return {
    enabled: typeof raw.enabled === 'boolean' ? raw.enabled : true,
    cropWidth: readEdge(raw.cropWidth, raw.cropPx),
    cropHeight: readEdge(raw.cropHeight, raw.cropPx),
  };
}

export function readScreenPingEnabled(): boolean {
  return readScreenPingSettings().enabled;
}

export function writeScreenPingSettings(patch: Partial<ScreenPingSettings>): ScreenPingSettings {
  const current = readScreenPingSettings();
  const next: ScreenPingSettings = {
    enabled: typeof patch.enabled === 'boolean' ? patch.enabled : current.enabled,
    cropWidth: patch.cropWidth !== undefined ? normalizeCropPx(patch.cropWidth, current.cropWidth) : current.cropWidth,
    cropHeight: patch.cropHeight !== undefined ? normalizeCropPx(patch.cropHeight, current.cropHeight) : current.cropHeight,
  };
  const file = settingsPath();
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(next, null, 2));
  fs.renameSync(tmp, file);
  return next;
}
