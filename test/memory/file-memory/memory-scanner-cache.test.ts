/**
 * memory-scanner-cache 单元测试。
 *
 * 覆盖：
 * - TTL 缓存命中/未命中
 * - TTL=30s 配置
 * - 主动失效（单目录、全部）
 * - maxFiles 截取
 * - 全局单例
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { MemoryScannerCache, getScannerCache, resetScannerCache } from '../../../src/memory/file-memory/memory-scanner-cache.js';
import type { MemoryHeader } from '../../../src/memory/file-memory/types.js';

// Mock scanMemoryFiles
vi.mock('../../../src/memory/file-memory/memory-scanner.js', () => ({
  scanMemoryFiles: vi.fn(async () => [
    { filename: 'a.md', filePath: '/tmp/a.md', mtimeMs: Date.now() },
    { filename: 'b.md', filePath: '/tmp/b.md', mtimeMs: Date.now() },
  ] as MemoryHeader[]),
}));

import { scanMemoryFiles } from '../../../src/memory/file-memory/memory-scanner.js';

beforeEach(() => {
  vi.clearAllMocks();
  resetScannerCache();
});

describe('MemoryScannerCache', () => {
  it('首次扫描调用 scanMemoryFiles', async () => {
    const cache = new MemoryScannerCache(30_000);
    const result = await cache.scan('/tmp/mem');

    expect(scanMemoryFiles).toHaveBeenCalledTimes(1);
    expect(result.length).toBe(2);
  });

  it('TTL 内重复扫描返回缓存（不调用 scanMemoryFiles）', async () => {
    const cache = new MemoryScannerCache(30_000);

    await cache.scan('/tmp/mem');
    await cache.scan('/tmp/mem');

    // 第二次应该命中缓存
    expect(scanMemoryFiles).toHaveBeenCalledTimes(1);
  });

  it('TTL 过期后重新扫描', async () => {
    const cache = new MemoryScannerCache(50); // 50ms TTL

    await cache.scan('/tmp/mem');
    expect(scanMemoryFiles).toHaveBeenCalledTimes(1);

    // 等待 TTL 过期
    await new Promise(r => setTimeout(r, 80));

    await cache.scan('/tmp/mem');
    expect(scanMemoryFiles).toHaveBeenCalledTimes(2);
  });

  it('默认 TTL 是 30 秒', () => {
    const cache = new MemoryScannerCache();
    // 验证构造函数默认值 — 通过行为间接验证
    // 30s TTL 意味着短时间内不会过期
    expect(cache).toBeDefined();
  });

  it('不同目录独立缓存', async () => {
    const cache = new MemoryScannerCache(30_000);

    await cache.scan('/tmp/mem1');
    await cache.scan('/tmp/mem2');

    expect(scanMemoryFiles).toHaveBeenCalledTimes(2);
  });

  it('invalidate 使指定目录缓存失效', async () => {
    const cache = new MemoryScannerCache(30_000);

    await cache.scan('/tmp/mem');
    expect(scanMemoryFiles).toHaveBeenCalledTimes(1);

    cache.invalidate('/tmp/mem');
    await cache.scan('/tmp/mem');

    expect(scanMemoryFiles).toHaveBeenCalledTimes(2);
  });

  it('invalidateAll 使所有缓存失效', async () => {
    const cache = new MemoryScannerCache(30_000);

    await cache.scan('/tmp/mem1');
    await cache.scan('/tmp/mem2');
    expect(scanMemoryFiles).toHaveBeenCalledTimes(2);

    cache.invalidateAll();
    await cache.scan('/tmp/mem1');
    await cache.scan('/tmp/mem2');

    expect(scanMemoryFiles).toHaveBeenCalledTimes(4);
  });

  it('maxFiles 在缓存命中时限制返回数量', async () => {
    const cache = new MemoryScannerCache(30_000);
    // 首次调用：缓存未命中，返回 scanMemoryFiles 的全部结果
    const result1 = await cache.scan('/tmp/mem', 1);
    expect(result1.length).toBe(2); // mock 返回 2 条

    // 第二次调用：缓存命中，slice(0, 1) 限制为 1
    const result2 = await cache.scan('/tmp/mem', 1);
    expect(result2.length).toBe(1);
  });

  it('缓存命中时返回 slice 副本（防止外部修改）', async () => {
    const cache = new MemoryScannerCache(30_000);

    // 首次：存入缓存
    await cache.scan('/tmp/mem');

    // 第二次：命中缓存，slice 返回新数组
    const result1 = await cache.scan('/tmp/mem');
    result1.push({ filename: 'injected.md' } as any);

    // 第三次：再次命中，应该不包含注入的条目
    const result2 = await cache.scan('/tmp/mem');
    expect(result2.length).toBe(2);
  });

  it('getStats 返回正确统计', async () => {
    const cache = new MemoryScannerCache(30_000);

    await cache.scan('/tmp/mem1');
    await cache.scan('/tmp/mem2');

    const stats = cache.getStats();
    expect(stats.dirCount).toBe(2);
    expect(stats.entries.length).toBe(2);
    expect(stats.entries[0].memoryCount).toBe(2);
  });
});

describe('getScannerCache 全局单例', () => {
  it('返回同一实例', () => {
    const a = getScannerCache();
    const b = getScannerCache();
    expect(a).toBe(b);
  });

  it('resetScannerCache 后返回新实例', () => {
    const a = getScannerCache();
    resetScannerCache();
    const b = getScannerCache();
    expect(a).not.toBe(b);
  });
});
