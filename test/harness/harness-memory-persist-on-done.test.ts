import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { HarnessMemoryIntegration } from '../../src/harness/harness-memory.js';
import type { UnifiedMessage } from '../../src/llm/types.js';

describe('onLoopEnd persist only after model_done', () => {
  const messages: UnifiedMessage[] = [{ role: 'user', content: 'fix the failing tests' }];

  function makeIntegration(): HarnessMemoryIntegration {
    return new HarnessMemoryIntegration({
      memoryDir: mkdtempSync(join(tmpdir(), 'ice-mem-persist-')),
    });
  }

  it('skips extract / session-notes / dream on abort, timeout, or missing stopReason', async () => {
    const integration = makeIntegration();
    const extract = vi.spyOn(integration as never, 'sequentialExtract');
    const session = vi.spyOn(integration, 'maybeUpdateSessionMemory');
    const dream = vi.spyOn(integration as never, 'maybeDream');

    await integration.onLoopEnd(messages, 4, 20_000, undefined, { stopReason: 'user_abort' });
    await integration.onLoopEnd(messages, 4, 20_000, undefined, { stopReason: 'timeout' });
    await integration.onLoopEnd(messages, 4, 20_000);

    expect(extract).not.toHaveBeenCalled();
    expect(session).not.toHaveBeenCalled();
    expect(dream).not.toHaveBeenCalled();
    integration.dispose();
  });

  it('starts persist after model_done without blocking the caller on LLM', async () => {
    const integration = makeIntegration();
    const extract = vi.spyOn(integration as never, 'sequentialExtract').mockResolvedValue(undefined);
    const session = vi.spyOn(integration, 'maybeUpdateSessionMemory').mockResolvedValue(undefined);
    vi.spyOn(integration as never, 'maybeDream').mockResolvedValue(undefined);
    vi.spyOn((integration as { memoryDream: { recordSession: () => Promise<void> } }).memoryDream, 'recordSession')
      .mockResolvedValue(undefined);

    await integration.onLoopEnd(messages, 4, 20_000, undefined, { stopReason: 'model_done' });

    expect(extract).toHaveBeenCalledTimes(1);
    expect(session).toHaveBeenCalledTimes(1);
    integration.dispose();
  });
});
