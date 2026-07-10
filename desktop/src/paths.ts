/**
 * 桌面端路径解析（与 src/cli/paths.ts 解耦，独立编译）。
 */
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import { app } from 'electron';
import { getServerRoot } from './constants';

const WORKSPACE_FILE = 'workspace.json';
const PET_POS_FILE = 'pet-floating-position.json';
const DATA_DIR_FILE = 'data-directory.json';

/** 用户选定的工作区目录（绝对路径），未设置时返回 null。 */
export function readWorkspace(): string | null {
  const file = path.join(app.getPath('userData'), WORKSPACE_FILE);
  if (!fs.existsSync(file)) return null;
  try {
    const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
    const ws = typeof raw?.workspace === 'string' ? raw.workspace : null;
    if (!ws) return null;
    if (!fs.existsSync(ws)) return null;
    return path.resolve(ws);
  } catch {
    return null;
  }
}

export function writeWorkspace(workspace: string | null): void {
  const file = path.join(app.getPath('userData'), WORKSPACE_FILE);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify({ workspace }, null, 2));
}

/** 用户选择的 iceCoder 数据目录；未设置时返回 null（使用 ~/\.iceCoder）。 */
export function readDataDirectory(): string | null {
  const file = path.join(app.getPath('userData'), DATA_DIR_FILE);
  if (!fs.existsSync(file)) return null;
  try {
    const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
    const dataDir = typeof raw?.dataDir === 'string' ? raw.dataDir.trim() : '';
    if (!dataDir || !path.isAbsolute(dataDir)) return null;
    return path.resolve(dataDir);
  } catch {
    return null;
  }
}

/** 保存用户选择的 iceCoder 数据目录；传 null 可恢复默认 ~/\.iceCoder。 */
export function writeDataDirectory(dataDir: string | null): void {
  const normalized = dataDir?.trim();
  if (normalized && !path.isAbsolute(normalized)) {
    throw new Error('数据目录必须是绝对路径');
  }
  const file = path.join(app.getPath('userData'), DATA_DIR_FILE);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(
    file,
    JSON.stringify({ dataDir: normalized ? path.resolve(normalized) : null }, null, 2),
  );
}

export interface PetFloatingPosition {
  x: number;
  y: number;
  /** 记录时的窗口宽，用于尺寸变更后作废旧坐标 */
  w?: number;
  h?: number;
}

export function readPetFloatingPosition(): PetFloatingPosition | null {
  const file = path.join(app.getPath('userData'), PET_POS_FILE);
  if (!fs.existsSync(file)) return null;
  try {
    const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (typeof raw?.x === 'number' && typeof raw?.y === 'number') {
      return {
        x: raw.x,
        y: raw.y,
        w: typeof raw.w === 'number' ? raw.w : undefined,
        h: typeof raw.h === 'number' ? raw.h : undefined,
      };
    }
  } catch {
    // ignore
  }
  return null;
}

export function writePetFloatingPosition(pos: PetFloatingPosition): void {
  const file = path.join(app.getPath('userData'), PET_POS_FILE);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(pos, null, 2));
}

/** iceCoder 数据目录（设置页配置，未设置时 ~/\.iceCoder）。 */
export function resolveDataDirectory(): string {
  return readDataDirectory() ?? path.join(os.homedir(), '.iceCoder');
}

/** 启动 server 的子进程 cwd：数据目录存在则使用它，否则用用户目录兜底。 */
export function resolveServerCwd(): string {
  const dataDir = resolveDataDirectory();
  try {
    if (fs.statSync(dataDir).isDirectory()) return dataDir;
  } catch {
    // 数据目录不存在或不可访问时，使用稳定存在的用户目录启动 server。
  }
  return os.homedir();
}

/** 复制示例数据文件到用户数据目录（首次启动）。 */
export function ensureDataDirSeeded(): void {
  // 简化：实际配置由 server 子进程通过 ICE_DATA_DIR 控制；此处仅占位。
}

/** server-bundle 是否就绪（dist/index.js 存在）。 */
export function isServerBundleReady(): boolean {
  const entry = path.join(getServerRoot(), 'dist', 'index.js');
  return fs.existsSync(entry);
}
