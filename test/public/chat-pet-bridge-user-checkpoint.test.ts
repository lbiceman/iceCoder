import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

describe('chat-pet-bridge user_checkpoint', () => {
  it('final 事件映射为 crying 表情并保持接管提示', () => {
    const bridgePath = path.join(__dirname, '../../src/public/js/chat-pet-bridge.js');
    const src = readFileSync(bridgePath, 'utf-8');
    expect(src).toMatch(/sr === 'user_checkpoint'/);
    expect(src).toMatch(/setState\('crying'\)/);
    expect(src).toMatch(/userCheckpointNoticeActive/);
    expect(src).toMatch(/监管已暂停，需要你介入啦/);
  });
});
