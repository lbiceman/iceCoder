/**
 * harness-memory 召回遥测：dedupCount 须在会话内去重之后记录。
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { randomUUID } from 'node:crypto';
import { HarnessMemoryIntegration } from '../../src/harness/harness-memory.js';
import {
  getMemoryTelemetry,
  resetMemoryTelemetry,
  type RecallTelemetry,
} from '../../src/memory/file-memory/memory-telemetry.js';

let tempDir: string;
const recallEvents: RecallTelemetry[] = [];

async function writeMemoryFile(
  dir: string,
  filename: string,
  description: string,
  body: string,
) {
  const content = `---
name: ${filename.replace(/\.md$/, '')}
description: ${description}
type: project
confidence: 0.9
tags: icecoder
createdAt: ${new Date().toISOString()}
recallCount: 3
---

${body}`;
  await fs.writeFile(path.join(dir, filename), content, 'utf-8');
}

beforeEach(async () => {
  tempDir = path.join(os.tmpdir(), `harness-recall-telemetry-${randomUUID()}`);
  await fs.mkdir(tempDir, { recursive: true });
  recallEvents.length = 0;
  resetMemoryTelemetry();
  const telemetry = getMemoryTelemetry({ enableFileLog: false, enableConsoleLog: false });
  telemetry.on('telemetry', (event) => {
    if (event.type === 'memory_recall') {
      recallEvents.push(event);
    }
  });
});

afterEach(async () => {
  resetMemoryTelemetry();
  await fs.rm(tempDir, { recursive: true, force: true }).catch(() => {});
});

describe('HarnessMemoryIntegration recall telemetry', () => {
  it('标准召回在去重之后记录 dedupCount', async () => {
    await writeMemoryFile(
      tempDir,
      'icecoder-dedup-target.md',
      'icecoder dedup telemetry target',
      'icecoder harness memory dedup telemetry validation keyword',
    );

    const harness = new HarnessMemoryIntegration({ memoryDir: tempDir });
    (harness as unknown as { injectedMemoryIds: Set<string> }).injectedMemoryIds.add(
      'icecoder-dedup-target.md',
    );

    harness.onLoopStart('icecoder harness memory dedup telemetry validation', null);

    const messages = [{ role: 'user' as const, content: 'icecoder harness memory dedup telemetry validation' }];
    await harness.injectMemoryContext(messages);

    expect(recallEvents).toHaveLength(1);
    expect(recallEvents[0].recallPhase).toBe('standard');
    expect(recallEvents[0].dedupCount).toBe(1);
    expect(recallEvents[0].selectedFiles).not.toContain('icecoder-dedup-target.md');
  });

  it('标准召回异常时仍记录 memory_recall 遥测', async () => {
    await writeMemoryFile(
      tempDir,
      'icecoder-recall-error.md',
      'icecoder recall error telemetry',
      'icecoder recall failure telemetry keyword',
    );

    const harness = new HarnessMemoryIntegration({ memoryDir: tempDir });
    vi.spyOn(
      harness as unknown as { buildStructuredMemoryItems: () => Promise<unknown> },
      'buildStructuredMemoryItems',
    ).mockRejectedValue(new Error('structured build failed'));

    harness.onLoopStart('icecoder recall failure telemetry keyword', null);
    const messages = [{
      role: 'user' as const,
      content: 'icecoder recall failure telemetry keyword',
    }];
    await harness.injectMemoryContext(messages);

    expect(recallEvents).toHaveLength(1);
    expect(recallEvents[0].recallPhase).toBe('standard');
    expect(recallEvents[0].selectedCount).toBe(0);
    expect(recallEvents[0].usedLLM).toBe(false);
  });
});
