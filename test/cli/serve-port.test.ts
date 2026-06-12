import { afterEach, describe, expect, it } from 'vitest';
import {
  DEVELOPMENT_API_PORT,
  PRODUCTION_API_PORT,
  resolveDefaultApiPort,
  shouldUseProductionPortDefaults,
} from '../../src/cli/serve-port.js';

describe('resolveDefaultApiPort', () => {
  const env = process.env;

  afterEach(() => {
    process.env = { ...env };
  });

  it('PORT 环境变量优先', () => {
    process.env.PORT = '9000';
    expect(resolveDefaultApiPort()).toBe(9000);
  });

  it('开发 CLI 默认 3784', () => {
    delete process.env.PORT;
    delete process.env.NODE_ENV;
    const entry = process.argv[1] ?? '';
    process.argv[1] = 'D:/work/self/iceCoder/src/cli/index.ts';
    expect(shouldUseProductionPortDefaults()).toBe(false);
    expect(resolveDefaultApiPort()).toBe(DEVELOPMENT_API_PORT);
    process.argv[1] = entry;
  });

  it('NODE_ENV=production 默认 1024', () => {
    delete process.env.PORT;
    process.env.NODE_ENV = 'production';
    expect(resolveDefaultApiPort()).toBe(PRODUCTION_API_PORT);
  });
});
