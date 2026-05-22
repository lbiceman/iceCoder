/** WebSocket 入口 supervisor runtime 进程级缓存失效注册表。 */

type ResetListener = () => void;

const listeners = new Set<ResetListener>();

export function registerSupervisorRuntimeReset(listener: ResetListener): void {
  listeners.add(listener);
}

export function resetSupervisorRuntimeCache(): void {
  for (const listener of listeners) {
    try {
      listener();
    } catch {
      /* ignore */
    }
  }
}
