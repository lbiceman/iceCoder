/**
 * 后台探测 Cloudflare Quick Tunnel 是否已就绪（metrics /quicktunnel）。
 * 适用于 cloudflared 由 concurrently 等单独进程启动的场景；就绪后通过回调广播 WS。
 *
 * ICE_TUNNEL_WS_NOTIFY=0 — 关闭探测与推送。
 * ICE_TUNNEL_PROBE_MS — 轮询间隔（毫秒），默认 2500。
 * ICE_TUNNEL_METRICS_PORT / ICE_TUNNEL_METRICS_QUICKTUNNEL — 与 cloudflared --metrics 保持一致。
 */

import { fetchQuickTunnelPublicUrl } from './quicktunnel-url.js';

/** 隧道 metrics 轮询最长持续时间（毫秒），超时则停止探测。 */
const MAX_TUNNEL_WATCH_MS = 600_000;

export interface TunnelReadyWatcherOptions {
  onReady: (publicUrl: string) => void;
}

/**
 * @returns 停止轮询（进程退出时应调用）。
 */
export function startTunnelReadyWatcher(options: TunnelReadyWatcherOptions): () => void {
  if (process.env.ICE_TUNNEL_WS_NOTIFY === '0') {
    return () => {};
  }

  const envUrlEarly = process.env.TUNNEL_URL?.trim();
  if (envUrlEarly) {
    queueMicrotask(() => {
      options.onReady(envUrlEarly);
    });
    return () => {};
  }

  let stopped = false;
  let timeoutId: ReturnType<typeof setTimeout> | null = null;
  const startedAt = Date.now();
  const intervalMs = Math.max(500, parseInt(process.env.ICE_TUNNEL_PROBE_MS ?? '2500', 10) || 2500);

  function clearTimer(): void {
    if (timeoutId !== null) {
      clearTimeout(timeoutId);
      timeoutId = null;
    }
  }

  function schedule(ms: number, fn: () => void): void {
    if (stopped) return;
    clearTimer();
    timeoutId = setTimeout(fn, ms);
  }

  async function tick(): Promise<void> {
    if (stopped) return;

    const url = await fetchQuickTunnelPublicUrl();
    if (url) {
      options.onReady(url);
      return;
    }

    if (Date.now() - startedAt >= MAX_TUNNEL_WATCH_MS) {
      return;
    }

    schedule(intervalMs, () => {
      void tick();
    });
  }

  schedule(800, () => {
    void tick();
  });

  return () => {
    stopped = true;
    clearTimer();
  };
}
