/**
 * 从 cloudflared metrics 的 /quicktunnel 读取 Quick Tunnel 公网 hostname。
 * 仅本地开发构建（tsconfig.json）；npm pack 使用 tunnel-stubs。
 *
 * 优先级：ICE_TUNNEL_METRICS_QUICKTUNNEL（完整 URL）> ICE_TUNNEL_METRICS_HOST + ICE_TUNNEL_METRICS_PORT（默认 127.0.0.1:20241）
 */

/** cloudflared 文档常用默认端口；开发可与其它实例错位（见 package.json dev 脚本 ICE_TUNNEL_METRICS_PORT） */
export const DEFAULT_TUNNEL_METRICS_PORT = '20241';

function resolveMetricsHostPort(): { host: string; port: string } {
  const port = process.env.ICE_TUNNEL_METRICS_PORT?.trim() ?? DEFAULT_TUNNEL_METRICS_PORT;
  const host = process.env.ICE_TUNNEL_METRICS_HOST?.trim() ?? '127.0.0.1';
  return { host, port };
}

export function resolveQuickTunnelMetricsUrl(): string {
  const explicit = process.env.ICE_TUNNEL_METRICS_QUICKTUNNEL?.trim();
  if (explicit) return explicit;
  const { host, port } = resolveMetricsHostPort();
  return `http://${host}:${port}/quicktunnel`;
}

/** cloudflared `--metrics` 绑定地址，须与 resolveQuickTunnelMetricsUrl 中的 host/port 一致（若未使用 ICE_TUNNEL_METRICS_QUICKTUNNEL） */
export function resolveTunnelMetricsListenAddress(): string {
  const { host, port } = resolveMetricsHostPort();
  return `${host}:${port}`;
}

export async function fetchQuickTunnelPublicUrl(): Promise<string | null> {
  try {
    const metricsUrl = resolveQuickTunnelMetricsUrl();
    const res = await fetch(metricsUrl, { signal: AbortSignal.timeout(2000) });
    if (!res.ok) return null;
    const data = (await res.json()) as { hostname?: string };
    if (!data.hostname || typeof data.hostname !== 'string') return null;
    return `https://${data.hostname}`;
  } catch {
    return null;
  }
}
