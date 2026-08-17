// iceCoder vitest config — last updated 2026-06-01
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    include: ['test/**/*.test.ts'],
    coverage: {
      provider: 'v8',
      reporter: ['text', 'json', 'html'],
    },
  },
  resolve: {
    alias: {
      '@core': './src/core',
      '@parser': './src/parser',
      '@memory': './src/memory',
      '@llm': './src/llm',
      '@web': './src/web',
      // desktop 模块依赖 electron；真实 electron 包在纯 Node 下无法 import，
      // 统一指向测试替身（test/desktop/electron-stub.ts）。
      electron: './test/desktop/electron-stub.ts',
    },
  },
});
