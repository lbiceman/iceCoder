import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    include: ['src/**/*.test.ts'],
    coverage: {
      provider: 'v8',
      reporter: ['text', 'json', 'html'],
    },
  },
  resolve: {
    alias: {
      '@core': './src/core',
      '@agents': './src/agents',
      '@parser': './src/parser',
      '@memory': './src/memory',
      '@llm': './src/llm',
      '@web': './src/web',
    },
  },
});
