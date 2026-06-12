/**
 * Quick Tunnel / cloudflared 仅本地开发使用（ICE_TUNNEL_DEV=1）。
 * npm pack 构建使用 tsconfig.pack.json 的隧道 stub，不包含 dev 实现。
 */
export function isTunnelDevEnabled(): boolean {
  return process.env.ICE_TUNNEL_DEV === '1';
}
