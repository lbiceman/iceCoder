/** 发布包 stub：不探测 cloudflared metrics。 */

export const DEFAULT_TUNNEL_METRICS_PORT = '20241';

export function resolveQuickTunnelMetricsUrl(): string {
  return 'http://127.0.0.1:20241/quicktunnel';
}

export function resolveTunnelMetricsListenAddress(): string {
  return '127.0.0.1:20241';
}

export async function fetchQuickTunnelPublicUrl(): Promise<string | null> {
  return null;
}
