/**
 * 优雅退出管理器。
 *
 * 统一处理 SIGINT/SIGTERM 信号，确保：
 * 1. MCP 子进程全部停止（不残留）
 * 2. WebSocket 连接关闭
 * 3. HTTP 服务器关闭
 * 4. 记忆提取完成（drainExtractions）
 * 5. 遥测日志刷盘
 * 6. 超时后强制退出（防止卡死）
 * 7. 双击 Ctrl+C 立即退出
 */

const SHUTDOWN_TIMEOUT_MS = 8000;

type CleanupFn = () => Promise<void> | void;

interface ShutdownOptions {
  /** 退出前的清理函数列表（按注册顺序执行） */
  cleanups: CleanupFn[];
  /** 超时时间（毫秒），默认 8000 */
  timeout?: number;
  /** 退出时的提示文本 */
  message?: string;
}

let shuttingDown = false;
let forceExitRegistered = false;

/**
 * 注册优雅退出处理器。
 *
 * 首次 Ctrl+C：执行所有清理函数，超时后强制退出。
 * 二次 Ctrl+C：立即退出。
 */
export function registerGracefulShutdown(options: ShutdownOptions): void {
  const { cleanups, timeout = SHUTDOWN_TIMEOUT_MS, message = 'Shutting down...' } = options;

  const shutdown = async (signal: string) => {
    if (shuttingDown) {
      // 二次 Ctrl+C → 立即退出
      console.log('\n强制退出');
      process.exit(1);
    }

    shuttingDown = true;
    console.log(`\n${message}`);

    // 超时保护
    const timer = setTimeout(() => {
      console.error(`清理超时（${timeout}ms），强制退出`);
      process.exit(1);
    }, timeout);
    timer.unref(); // 不阻止进程退出

    // 按顺序执行清理
    for (const cleanup of cleanups) {
      try {
        await cleanup();
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        console.error(`清理失败: ${msg}`);
      }
    }

    clearTimeout(timer);
    process.exit(0);
  };

  // 避免重复注册
  if (!forceExitRegistered) {
    forceExitRegistered = true;
    process.on('SIGINT', () => shutdown('SIGINT'));
    process.on('SIGTERM', () => shutdown('SIGTERM'));
  }
}

/**
 * 重置状态（用于测试）。
 */
export function resetShutdownState(): void {
  shuttingDown = false;
  forceExitRegistered = false;
}
