/**
 * 等待 Express API 就绪后再启动 Vite dev server，
 * 避免 Vite proxy 在 API 未就绪时报 ECONNREFUSED。
 */
import { execSync } from 'child_process';

const API_URL = `http://localhost:${process.env.PORT ?? 3000}/api/config`;
const MAX_WAIT = 30_000;
const INTERVAL = 500;

async function waitForApi() {
  const start = Date.now();
  while (Date.now() - start < MAX_WAIT) {
    try {
      const res = await fetch(API_URL);
      if (res.ok) return;
    } catch {
      // 还没启动，继续等
    }
    await new Promise(r => setTimeout(r, INTERVAL));
  }
  console.warn('[web] API server did not respond in time, starting Vite anyway');
}

await waitForApi();
console.log('[web] API server is ready, starting Vite...');
execSync('npx vite', { stdio: 'inherit' });
