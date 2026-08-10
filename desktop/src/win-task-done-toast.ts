/**
 * win-task-done-toast.ts — Windows 任务完成 toast XML（纯函数，无 Electron 运行时依赖）。
 *
 * 系统通知左上角小图标来自 AppUserModelID 默认图标（开发态常为 Electron 蓝底），
 * 通过 ToastGeneric 的 appLogoOverride + hint-crop="circle" 替换为透明圆形 logo。
 */
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

export interface WindowsTaskDoneToastOptions {
  title: string;
  body: string;
  /** 左上角 appLogoOverride；null 时不注入（仍可能显示系统默认图标）。 */
  appLogoPath?: string | null;
  /** 正文区 hero 大图；null 时不显示。 */
  heroIconPath?: string | null;
}

export function escapeXml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

export function toWindowsFileUri(filePath: string): string {
  return pathToFileURL(path.resolve(filePath)).href;
}

/** Windows toast appLogoOverride 推荐尺寸对应的资源文件名。 */
export const WINDOWS_TOAST_APP_LOGO_CANDIDATES = [
  'notification-app-logo.png',
  'icon.png',
] as const;

export function resolveWindowsToastAppLogoPath(assetsDir: string): string | null {
  for (const name of WINDOWS_TOAST_APP_LOGO_CANDIDATES) {
    const candidate = path.join(assetsDir, name);
    if (fs.existsSync(candidate)) return candidate;
  }
  return null;
}

export function buildWindowsTaskDoneToastXml(options: WindowsTaskDoneToastOptions): string {
  const title = escapeXml(options.title);
  const body = escapeXml(options.body);

  const appLogo =
    options.appLogoPath && options.appLogoPath.trim()
      ? `<image placement="appLogoOverride" hint-crop="circle" src="${escapeXml(toWindowsFileUri(options.appLogoPath))}"/>`
      : '';

  const hero =
    options.heroIconPath && options.heroIconPath.trim()
      ? `<image placement="hero" src="${escapeXml(toWindowsFileUri(options.heroIconPath))}"/>`
      : '';

  return `<toast><visual><binding template="ToastGeneric"><text>${title}</text><text>${body}</text>${appLogo}${hero}</binding></visual></toast>`;
}
