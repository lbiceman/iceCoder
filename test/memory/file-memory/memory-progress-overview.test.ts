import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'os';
import { randomUUID } from 'node:crypto';
import {
  downgradeSessionProgressOverviews,
  isSessionProgressOverview,
  SESSION_PROGRESS_CONFIDENCE_CAP,
} from '../../../src/memory/file-memory/memory-progress-overview.js';

let tempDir: string;

async function writeOverview(
  filename: string,
  opts: { name: string; description: string; body?: string; extra?: string },
) {
  await fs.writeFile(path.join(tempDir, filename), `---
name: ${opts.name}
description: ${opts.description}
type: project
memoryCategory: project_convention
level: project_fact
evidenceStrength: explicit
confidence: 0.85
tags: dimension:project
${opts.extra ?? ''}
---

${opts.body ?? 'body'}
`, 'utf-8');
}

beforeEach(async () => {
  tempDir = path.join(os.tmpdir(), `progress-overview-${randomUUID()}`);
  await fs.mkdir(tempDir, { recursive: true });
});

afterEach(async () => {
  await fs.rm(tempDir, { recursive: true, force: true }).catch(() => {});
});

describe('isSessionProgressOverview', () => {
  it('识别进度快照，放过约定型 overview', () => {
    expect(isSessionProgressOverview({
      filename: 'icecoder-chat-page-ws-split-overview.md',
      name: 'chat-page WS 拆分已全部完成（块1-4）',
      description: 'UPDATE 既有条目：块4 已完成并提交；测试全绿',
    })).toBe(true);

    expect(isSessionProgressOverview({
      filename: 'weekly-report-personal-skill-overview.md',
      name: '个人周报技能（weeklyReportPersonal）使用约定',
      description: '原文未标状态时本周默认「进行中」',
    })).toBe(false);

    expect(isSessionProgressOverview({
      filename: 'icecoder-deep-analysis-overview.md',
      name: 'iceEtlPrefs 新增字段 checklist 实战验证',
      description: '按 types.ts 注释 checklist 新增字段的完整同步点清单',
    })).toBe(false);
  });
});

describe('downgradeSessionProgressOverviews', () => {
  it('只降级进度型 overview，可重复执行', async () => {
    await writeOverview('icecoder-chat-page-ws-split-overview.md', {
      name: 'chat-page WS 拆分已全部完成（块1-4）',
      description: 'UPDATE 既有条目：块4 已完成并提交；测试全绿结果',
    });
    await writeOverview('weekly-report-personal-skill-overview.md', {
      name: '个人周报技能使用约定',
      description: 'weeklyReportPersonal 技能续用约定',
      body: 'UPDATE 既有条目（2026-08-31 起连续实战）',
    });
    await writeOverview('icecoder-deep-analysis-overview.md', {
      name: 'iceEtlPrefs 新增字段 checklist 实战验证',
      description: '按 types.ts 注释 checklist 新增字段的完整同步点清单',
      body: '验证结果 45/45 全绿。教训：测试字面量是第 10 个同步点',
    });

    const first = await downgradeSessionProgressOverviews(tempDir);
    expect(first.downgraded).toEqual(['icecoder-chat-page-ws-split-overview.md']);

    const progress = await fs.readFile(path.join(tempDir, 'icecoder-chat-page-ws-split-overview.md'), 'utf-8');
    expect(progress).toContain('level: session_state');
    expect(progress).toContain('memoryCategory: session_progress');
    expect(progress).toContain(`confidence: ${SESSION_PROGRESS_CONFIDENCE_CAP}`);
    expect(progress).toContain('status:session_progress');

    const weekly = await fs.readFile(path.join(tempDir, 'weekly-report-personal-skill-overview.md'), 'utf-8');
    expect(weekly).toContain('level: project_fact');
    expect(weekly).toContain('memoryCategory: project_convention');

    const lesson = await fs.readFile(path.join(tempDir, 'icecoder-deep-analysis-overview.md'), 'utf-8');
    expect(lesson).toContain('level: project_fact');

    const second = await downgradeSessionProgressOverviews(tempDir);
    expect(second.downgraded).toHaveLength(0);
  });
});
