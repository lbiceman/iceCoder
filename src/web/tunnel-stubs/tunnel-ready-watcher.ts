/** 发布包 stub：不轮询 Quick Tunnel。 */

export interface TunnelReadyWatcherOptions {
  onReady: (publicUrl: string) => void;
}

export function startTunnelReadyWatcher(_options: TunnelReadyWatcherOptions): () => void {
  return () => {};
}
