/**
 * win-notification-shortcut.ts — Windows 通知身份：开始菜单快捷方式 + favicon 同源 icon。
 *
 * 开发态若未注册快捷方式，通知左上角会显示 Electron 默认蓝底图标；
 * 注册后改用 desktop/assets/icon.ico（由首页品牌标 src/public/icons/logo.png 生成）。
 */
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { app } from 'electron';
import { APP_NAME, APP_USER_MODEL_ID, NOTIFICATION_APP_NAME } from './constants';

/** 与 generate-icons.mjs 一致：首页 logo.png → icon.ico / icon.png */
export const NOTIFICATION_ICON_CANDIDATES = ['icon.ico', 'icon.png'] as const;

export function resolveNotificationShortcutIconPath(assetsDir: string): string | null {
  for (const name of NOTIFICATION_ICON_CANDIDATES) {
    const candidate = path.join(assetsDir, name);
    if (fs.existsSync(candidate)) return candidate;
  }
  return null;
}

export function resolveWindowsNotificationShortcutPath(appDataDir: string): string {
  return path.join(
    appDataDir,
    'Microsoft',
    'Windows',
    'Start Menu',
    'Programs',
    `${APP_NAME}.lnk`,
  );
}

export interface EnsureWindowsNotificationShortcutOptions {
  assetsDir: string;
  scriptPath: string;
  appDataDir: string;
  execPath: string;
  appUserModelId?: string;
}

/** 创建开始菜单快捷方式并写入 AUMID；失败时返回 false（不阻断启动）。 */
export function ensureWindowsNotificationShortcut(
  options: EnsureWindowsNotificationShortcutOptions,
): boolean {
  const iconPath = resolveNotificationShortcutIconPath(options.assetsDir);
  if (!iconPath) return false;

  if (!fs.existsSync(options.scriptPath)) return false;

  const shortcutPath = resolveWindowsNotificationShortcutPath(options.appDataDir);
  const workingDirectory = path.dirname(options.execPath);
  const iconLocation = `${iconPath},0`;
  const appUserModelId = options.appUserModelId ?? APP_USER_MODEL_ID;

  const result = spawnSync(
    'powershell.exe',
    [
      '-NoProfile',
      '-STA',
      '-ExecutionPolicy',
      'Bypass',
      '-File',
      options.scriptPath,
      '-ShortcutPath',
      shortcutPath,
      '-TargetPath',
      options.execPath,
      '-WorkingDirectory',
      workingDirectory,
      '-IconLocation',
      iconLocation,
      '-AppUserModelId',
      appUserModelId,
      '-Description',
      NOTIFICATION_APP_NAME,
    ],
    { encoding: 'utf8', windowsHide: true },
  );

  return result.status === 0;
}

/** 主进程入口：注册快捷方式并设置 AUMID / 显示名。 */
export function configureWindowsNotificationIdentity(assetsDir: string, scriptPath: string): void {
  if (process.platform !== 'win32') return;

  const ok = ensureWindowsNotificationShortcut({
    assetsDir,
    scriptPath,
    appDataDir: app.getPath('appData'),
    execPath: process.execPath,
  });

  if (!ok) {
    // 快捷方式失败时仍设置 AUMID，打包安装版通常已有安装器创建的快捷方式
    process.stderr.write('[main] Windows 通知快捷方式注册失败，左上角可能仍显示 Electron 默认图标\n');
  }

  app.setAppUserModelId(APP_USER_MODEL_ID);
  app.setName(NOTIFICATION_APP_NAME);
}
