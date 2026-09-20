import { describe, expect, it } from 'vitest';
import {
  filterMemoriesByWorkspace,
  inferMemoryProjectKeys,
  inferWorkspaceProjectKeys,
} from '../../../src/memory/file-memory/memory-workspace-filter.js';
import type { MemoryHeader } from '../../../src/memory/file-memory/types.js';

function mem(partial: Partial<MemoryHeader> & Pick<MemoryHeader, 'filename'>): MemoryHeader {
  return {
    filePath: `/tmp/${partial.filename}`,
    mtimeMs: 1,
    name: partial.filename,
    description: '',
    type: 'project',
    level: 'project_fact',
    evidenceStrength: 'explicit',
    confidence: 0.9,
    recallCount: 1,
    lastRecalledMs: 0,
    createdMs: 0,
    tags: [],
    source: undefined,
    contentPreview: '',
    eventDateMs: 0,
    ...partial,
  };
}

describe('memory-workspace-filter', () => {
  it('从 iceCoder 路径识别项目键', () => {
    const keys = inferWorkspaceProjectKeys('D:/work/self/iceCoder');
    expect(keys).toContain('icecoder');
  });

  it('unity 文件名抽出 unity 键，git 文件名为通用记忆', () => {
    expect(inferMemoryProjectKeys(mem({
      filename: 'unity-preprocessor-guard-compilation.md',
      tags: ['lang:csharp', 'platform:unity'],
      type: 'feedback',
    }))).toContain('unity');
    expect(inferMemoryProjectKeys(mem({
      filename: 'git-not-in-path-full-path.md',
      tags: ['dimension:git'],
      type: 'feedback',
    }))).toEqual([]);
  });

  it('iceCoder 工作区丢掉其它项目 overview，保留用户偏好和通用排错', () => {
    const pool = [
      mem({ filename: 'icecoder-owner-context.md', tags: ['project:icecoder'], type: 'project' }),
      mem({ filename: 'climbingStairs-overview.md', tags: ['game:2d-climbing'], type: 'project' }),
      mem({ filename: 'unity-manage-build-output-path-gotcha.md', tags: ['platform:unity'], type: 'feedback' }),
      mem({ filename: 'git-not-in-path-full-path.md', tags: ['dimension:git'], type: 'feedback' }),
      mem({ filename: 'user-pwsh7-preferred-shell.md', tags: [], type: 'user' }),
    ];
    const kept = filterMemoriesByWorkspace(pool, 'D:/work/self/iceCoder').map(m => m.filename);
    expect(kept).toContain('icecoder-owner-context.md');
    expect(kept).toContain('git-not-in-path-full-path.md');
    expect(kept).toContain('user-pwsh7-preferred-shell.md');
    expect(kept).not.toContain('climbingStairs-overview.md');
    expect(kept).not.toContain('unity-manage-build-output-path-gotcha.md');
  });
});
