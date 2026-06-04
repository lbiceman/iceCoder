/**
 * Web / API 默认端口：全局安装与生产用 1024；源码开发 CLI 默认 3784（可用 PORT / -p 覆盖）。
 * Vite 开发前端默认 1025（可用 VITE_PORT 覆盖）。
 */

import { usesUserDataRoot } from './paths.js';

export const PRODUCTION_API_PORT = 1024;
export const PRODUCTION_VITE_PORT = 1025;
export const DEVELOPMENT_API_PORT = 3784;

/** 全局安装或 NODE_ENV=production 时使用生产默认端口。 */
export function shouldUseProductionPortDefaults(): boolean {
  return usesUserDataRoot();
}

export { isPackagedCliEntry } from './paths.js';

/** 解析 API/Web 监听端口：显式 PORT / -p 优先，否则按运行环境选默认。 */
export function resolveDefaultApiPort(): number {
  const fromEnv = process.env.PORT?.trim();
  if (fromEnv) {
    const n = parseInt(fromEnv, 10);
    if (Number.isFinite(n) && n > 0) return n;
  }
  return shouldUseProductionPortDefaults() ? PRODUCTION_API_PORT : DEVELOPMENT_API_PORT;
}

export function resolveDefaultVitePort(): number {
  const fromEnv = process.env.VITE_PORT?.trim();
  if (fromEnv) {
    const n = parseInt(fromEnv, 10);
    if (Number.isFinite(n) && n > 0) return n;
  }
  return PRODUCTION_VITE_PORT;
}

export function defaultApiPortHelpText(): string {
  return shouldUseProductionPortDefaults()
    ? String(PRODUCTION_API_PORT)
    : `${DEVELOPMENT_API_PORT}（全局安装默认 ${PRODUCTION_API_PORT}）`;
}
