/**
 * 防止 data/config*.json 与 {@link ProviderConfig}/{@link IceCoderConfigFile} 漂移，
 * 避免再次出现「读 JSON 时访问了接口未声明字段 → tsc 失败」。
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import type { IceCoderConfigFile, ProviderConfig } from '../../src/web/types.js';
import { resolveDefaultChatModelMeta } from '../../src/web/routes/config.js';

function isProviderShape(p: unknown): p is ProviderConfig {
  if (!p || typeof p !== 'object') return false;
  const o = p as Record<string, unknown>;
  if (typeof o.id !== 'string') return false;
  if (typeof o.apiUrl !== 'string' || typeof o.apiKey !== 'string') return false;
  if (typeof o.modelName !== 'string') return false;
  if (!o.parameters || typeof o.parameters !== 'object') return false;
  return true;
}

function assertIceCoderConfigFile(parsed: unknown): asserts parsed is IceCoderConfigFile {
  if (!parsed || typeof parsed !== 'object') throw new Error('config root must be an object');
  const root = parsed as Record<string, unknown>;
  if (!Array.isArray(root.providers)) throw new Error('providers must be an array');
  for (let i = 0; i < root.providers.length; i++) {
    if (!isProviderShape(root.providers[i])) {
      throw new Error(`providers[${i}] does not satisfy ProviderConfig required fields`);
    }
  }
}

describe('IceCoderConfigFile vs data/config.example.json', () => {
  it('example file parses as IceCoderConfigFile', () => {
    const raw = readFileSync(path.join(process.cwd(), 'data/config.example.json'), 'utf-8');
    const parsed = JSON.parse(raw);
    assertIceCoderConfigFile(parsed);
    expect(parsed.providers.length).toBeGreaterThan(0);
  });

  it('resolveDefaultChatModelMeta succeeds on example path', async () => {
    const meta = await resolveDefaultChatModelMeta(
      path.join(process.cwd(), 'data/config.example.json'),
    );
    expect(meta?.modelName).toBeTruthy();
    expect(meta?.maxContextTokens).toBeGreaterThan(0);
  });
});
