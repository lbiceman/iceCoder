/**
 * 记忆卫生 eval：用户库去重、进度 overview 降级、提取 skipReason。
 * 沙箱 + 脚本 LLM，不打外部 API。
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

import { HarnessMemoryIntegration } from '../../src/harness/harness-memory.js';
import { createFileMemoryManager } from '../../src/memory/file-memory/file-memory-manager.js';
import { dedupeUserMemoryDuplicates } from '../../src/memory/file-memory/memory-user-dedup.js';
import { downgradeSessionProgressOverviews } from '../../src/memory/file-memory/memory-progress-overview.js';
import { recallRelevantMemories } from '../../src/memory/file-memory/memory-recall.js';
import {
  getMemoryTelemetry,
  resetMemoryTelemetry,
  type ExtractTelemetry,
} from '../../src/memory/file-memory/memory-telemetry.js';
import {
  createRememberSignalWriteGuard,
  registerAgentMemoryWriteGuard,
  registerLongTermMemoryWriteCap,
  resetSessionLongTermMemoryWriteCaps,
} from '../../src/memory/file-memory/memory-write-pipeline.js';
import { SESSION_PROGRESS_TOOL_SKIP_MESSAGE } from '../../src/memory/file-memory/memory-tool-access.js';
import { createFileTools } from '../../src/tools/builtin/file-tools.js';
import { createPatchTool } from '../../src/tools/builtin/patch-tool.js';
import { createShellTool } from '../../src/tools/builtin/shell-tool.js';
import { markFileRead } from '../../src/tools/read-before-edit.js';
import type { LLMAdapterInterface, LLMResponse, UnifiedMessage } from '../../src/llm/types.js';

let root: string;
let projectDir: string;
let userDir: string;
let evictedDir: string;
const savedEnv: Record<string, string | undefined> = {};
const extractEvents: ExtractTelemetry[] = [];

const dummyUsage = { inputTokens: 0, outputTokens: 0, totalTokens: 0, provider: 'eval' };
const dummyLlm: LLMAdapterInterface = {
  async chat(): Promise<LLMResponse> {
    return { content: '', usage: dummyUsage, finishReason: 'stop' };
  },
  async stream(): Promise<LLMResponse> {
    return { content: '', usage: dummyUsage, finishReason: 'stop' };
  },
  async countTokens(): Promise<number> {
    return 1;
  },
};

async function writeMem(dir: string, filename: string, frontmatter: string, body: string) {
  await fs.writeFile(path.join(dir, filename), `---\n${frontmatter.trim()}\n---\n\n${body}\n`, 'utf-8');
}

beforeEach(async () => {
  root = path.join(os.tmpdir(), `memory-hygiene-eval-${randomUUID()}`);
  projectDir = path.join(root, 'memory-files');
  userDir = path.join(root, 'user-memory');
  evictedDir = path.join(root, 'memory-evicted', 'user-memory');
  await fs.mkdir(projectDir, { recursive: true });
  await fs.mkdir(userDir, { recursive: true });
  await fs.mkdir(evictedDir, { recursive: true });

  for (const key of ['ICE_DATA_DIR', 'ICE_MEMORY_DIR', 'ICE_USER_MEMORY_DIR', 'ICE_EVAL_MODE']) {
    savedEnv[key] = process.env[key];
  }
  process.env.ICE_DATA_DIR = root;
  process.env.ICE_MEMORY_DIR = projectDir;
  process.env.ICE_USER_MEMORY_DIR = userDir;
  delete process.env.ICE_EVAL_MODE;

  extractEvents.length = 0;
  resetMemoryTelemetry();
  getMemoryTelemetry({ enableFileLog: false, enableConsoleLog: false }).on('telemetry', (event) => {
    if (event.type === 'memory_extract') extractEvents.push(event);
  });
});

afterEach(async () => {
  resetMemoryTelemetry();
  registerAgentMemoryWriteGuard(null);
  registerLongTermMemoryWriteCap(null);
  resetSessionLongTermMemoryWriteCaps();
  for (const [key, value] of Object.entries(savedEnv)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  await fs.rm(root, { recursive: true, force: true }).catch(() => {});
});

describe('eval: user-library dedup', () => {
  it('merges true duplicates, archives losers, keeps distinct hygiene facts', async () => {
    const uiQuote = '用户原话：「开始按钮相关的内容都用中文！！！！你写英语谁看得见！」';
    const gitQuote = '「提交所有代码，msg用中文。记得push」';
    const inputQuote = '「楼层加载还是太慢了！按的快就会看不到」';

    await writeMem(userDir, 'user-chinese-ui-text.md', `
name: 游戏UI文本必须使用中文
description: 用户明确要求所有游戏UI文本使用中文，拒绝英文
type: user
level: preference
evidenceStrength: explicit
confidence: 0.95
recallCount: 383
tags: topic:ui, lang:csharp
`.trim(), `${uiQuote}\n规则：面向玩家的 UI 必须中文`);

    await writeMem(userDir, 'user-game-ui-must-be-chinese.md', `
name: 游戏 UI 文字必须使用中文
description: 用户明确要求所有游戏内 UI 文字必须使用中文
type: user
level: preference
evidenceStrength: explicit
confidence: 1
recallCount: 292
tags: topic:game-ui, preference:localization
`.trim(), `${uiQuote}\n注意：编程变量名/方法名仍用英文`);

    await writeMem(userDir, 'user_work_style.md', `
name: git 提交信息使用中文
description: 用户多次要求 commit message 必须用中文，且默认包含 push
type: user
level: preference
evidenceStrength: explicit
confidence: 0.8
recallCount: 70
tags: dimension:git, topic:commit-message
`.trim(), `用户明确要求 git commit message 使用中文（原话${gitQuote}）`);

    await writeMem(userDir, 'user-git-commit-push-style.md', `
name: 中文 commit message + 记得 push
description: commit message 用中文，且每次 commit 后必须 push
type: user
level: preference
evidenceStrength: repeated
confidence: 0.8
recallCount: 66
tags: dimension:git, topic:commit-message, topic:push
`.trim(), `在 iceCoder 开发中，用户多次明确要求${gitQuote}`);

    await writeMem(userDir, 'user-game-input-immediate-response.md', `
name: 游戏输入必须立即响应
description: 禁止输入缓冲，快速操作时前方内容必须充足
type: user
level: preference
evidenceStrength: explicit
confidence: 0.95
recallCount: 183
tags: preference:input-responsiveness, platform:unity
`.trim(), `禁止输入缓冲\n<!-- Consolidated from user-game-input-immediate-response.md + user-game-input-responsiveness.md -->`);

    await writeMem(userDir, 'user-game-input-responsiveness.md', `
name: 用户对游戏响应速度的极致要求
description: 输入必须立即响应，前方楼梯必须充足可见
type: user
level: preference
evidenceStrength: explicit
confidence: 0.95
recallCount: 224
tags: preference:input-responsiveness, platform:unity
`.trim(), `用户原话：${inputQuote}`);

    await writeMem(userDir, 'user_hygiene_cleanup.md', `
name: 代码与任务卫生习惯
description: 任务完成后彻底清理临时文件
type: user
level: preference
evidenceStrength: explicit
confidence: 1
recallCount: 543
tags: hygiene:cleanup
`.trim(), '零残留：删除 debug-*.mjs 和 tmp 文件');

    await writeMem(userDir, 'user-hygiene-cleanup.md', `
name: 禁止修改 Unity ProjectVersion.txt
description: 禁止修改 ProjectVersion.txt 中的 Editor 版本号
type: user
level: preference
evidenceStrength: explicit
confidence: 1
recallCount: 404
tags: platform:unity, topic:project-settings
`.trim(), '绝对不要修改 ProjectSettings/ProjectVersion.txt');

    const result = await dedupeUserMemoryDuplicates(userDir, evictedDir);
    expect(result.archived.sort()).toEqual([
      'user-game-input-responsiveness.md',
      'user-game-ui-must-be-chinese.md',
      'user-git-commit-push-style.md',
    ]);
    expect(result.merged.map(item => `${item.loser}→${item.keeper}`).sort()).toEqual([
      'user-game-input-responsiveness.md→user-game-input-immediate-response.md',
      'user-game-ui-must-be-chinese.md→user-chinese-ui-text.md',
      'user-git-commit-push-style.md→user_work_style.md',
    ]);

    await expect(fs.access(path.join(userDir, 'user-hygiene-cleanup.md'))).resolves.toBeUndefined();
    await expect(fs.access(path.join(userDir, 'user_hygiene_cleanup.md'))).resolves.toBeUndefined();
    await expect(fs.access(path.join(evictedDir, 'user-game-ui-must-be-chinese.md'))).resolves.toBeUndefined();

    const keeper = await fs.readFile(path.join(userDir, 'user-chinese-ui-text.md'), 'utf-8');
    expect(keeper).toContain('编程变量名/方法名仍用英文');
    expect(keeper).toContain('merged-from:');
    expect((keeper.match(/开始按钮相关的内容都用中文/g) ?? []).length).toBe(1);

    const second = await dedupeUserMemoryDuplicates(userDir, evictedDir);
    expect(second.merged).toHaveLength(0);
  });
});

describe('eval: session-progress overview downgrade', () => {
  it('downgrades progress snapshots and drops them from execute recall', async () => {
    await writeMem(projectDir, 'icecoder-chat-page-ws-split-overview.md', `
name: chat-page WS 拆分已全部完成（块1-4）
description: UPDATE 既有条目：块4 已完成并提交；测试全绿
type: project
memoryCategory: project_convention
level: project_fact
evidenceStrength: explicit
confidence: 0.85
tags: project:icecoder, topic:refactor
`.trim(), '块1-4 全部完成并提交，测试 35/35 全绿');

    await writeMem(projectDir, 'icecoder-deep-analysis-overview.md', `
name: iceEtlPrefs 新增字段 checklist 实战验证
description: 按 types.ts 注释 checklist 新增字段的完整同步点清单
type: project
memoryCategory: project_convention
level: project_fact
evidenceStrength: explicit
confidence: 0.85
tags: project:icecoder, topic:testing
`.trim(), '验证结果 45/45 全绿。教训：测试字面量是第 10 个同步点');

    await writeMem(projectDir, 'weekly-report-personal-skill-overview.md', `
name: 个人周报技能使用约定
description: weeklyReportPersonal 技能续用约定
type: project
memoryCategory: project_convention
level: project_fact
evidenceStrength: explicit
confidence: 0.85
tags: topic:weekly-report
`.trim(), 'UPDATE 既有条目（连续实战）');

    const downgraded = await downgradeSessionProgressOverviews(projectDir);
    expect(downgraded.downgraded).toEqual(['icecoder-chat-page-ws-split-overview.md']);
    expect(downgraded.archived).toEqual(['icecoder-chat-page-ws-split-overview.md']);

    await expect(
      fs.access(path.join(projectDir, 'icecoder-chat-page-ws-split-overview.md')),
    ).rejects.toThrow();
    const progress = await fs.readFile(
      path.join(root, 'memory-evicted', 'memory-files', 'icecoder-chat-page-ws-split-overview.md'),
      'utf-8',
    );
    expect(progress).toContain('level: session_state');
    const lesson = await fs.readFile(path.join(projectDir, 'icecoder-deep-analysis-overview.md'), 'utf-8');
    expect(lesson).toContain('level: project_fact');
    const weekly = await fs.readFile(path.join(projectDir, 'weekly-report-personal-skill-overview.md'), 'utf-8');
    expect(weekly).toContain('level: project_fact');

    const executeRecall = await recallRelevantMemories(
      '修复 iceCoder chat-page WS 拆分测试',
      projectDir,
      null,
      new Set(),
      8,
      new Set(),
      false,
      { workspaceRoot: 'D:/work/self/iceCoder' },
    );
    const executeNames = executeRecall.memories.map(m => m.filename);
    expect(executeNames).not.toContain('icecoder-chat-page-ws-split-overview.md');
  });
});

describe('eval: extract skipReason', () => {
  async function extractWith(
    harness: HarnessMemoryIntegration,
    userMessage: string,
    extras: {
      messages?: UnifiedMessage[];
      sessionSuccessfulExtractCount?: number;
    } = {},
  ) {
    harness.onLoopStart(userMessage, dummyLlm, { triggerUserMessage: userMessage });
    if (extras.sessionSuccessfulExtractCount !== undefined) {
      (harness as unknown as { sessionSuccessfulExtractCount: number }).sessionSuccessfulExtractCount =
        extras.sessionSuccessfulExtractCount;
    }
    await (harness as unknown as {
      _extractMemoriesImpl: (ctx: {
        messages: UnifiedMessage[];
        turnCount: number;
        gateUserMessage: string;
        conversationStartIndex: number;
        commandsRun: string[];
      }) => Promise<void>;
    })._extractMemoriesImpl({
      messages: extras.messages ?? [
        { role: 'user', content: userMessage },
        { role: 'assistant', content: 'ok' },
      ],
      turnCount: 5,
      gateUserMessage: userMessage,
      conversationStartIndex: 0,
      commandsRun: [],
    });
  }

  it('records ops_task, session_extract_cap, and agent_wrote', async () => {
    const harness = new HarnessMemoryIntegration({
      memoryDir: projectDir,
      workspaceRoot: projectDir,
    });

    await extractWith(harness, '用 zip 装 mysql');
    expect(extractEvents.at(-1)?.skipReason).toBe('ops_task');

    await extractWith(harness, '记住，commit 用中文', { sessionSuccessfulExtractCount: 1 });
    expect(extractEvents.at(-1)?.skipReason).toBe('session_extract_cap');

    const writeMessages: UnifiedMessage[] = [
      { role: 'user', content: '记住这条项目约定' },
      {
        role: 'assistant',
        content: '',
        toolCalls: [{
          id: 'w1',
          name: 'write_file',
          arguments: { path: 'memory-files/agent-wrote.md', content: 'x' },
        }],
      },
      { role: 'tool', toolCallId: 'w1', content: 'Wrote memory-files/agent-wrote.md' },
    ];
    harness.onLoopStart('记住这条项目约定', dummyLlm, { triggerUserMessage: '记住这条项目约定' });
    await harness.onLoopEnd(writeMessages, 2, undefined, undefined, { stopReason: 'model_done' });
    expect(extractEvents.at(-1)?.skipReason).toBe('agent_wrote');
    expect(getMemoryTelemetry().getSummary().totalExtracts).toBe(0);
    harness.dispose();
  });
});

describe('eval: FileMemoryManager wires hygiene on initialize', () => {
  it('dedupes user library and downgrades progress overviews at init', async () => {
    await writeMem(userDir, 'user-a.md', `
name: 游戏UI文本必须使用中文
description: UI 必须中文
type: user
level: preference
evidenceStrength: explicit
confidence: 0.95
recallCount: 10
tags: topic:ui
`.trim(), '用户原话：「开始按钮相关的内容都用中文！！！！你写英语谁看得见！」');
    await writeMem(userDir, 'user-b.md', `
name: 游戏 UI 文字必须使用中文
description: UI 文字必须中文
type: user
level: preference
evidenceStrength: explicit
confidence: 0.9
recallCount: 3
tags: topic:ui
`.trim(), '用户原话：「开始按钮相关的内容都用中文！！！！你写英语谁看得见！」');
    await writeMem(projectDir, 'feat-overview.md', `
name: 功能已全部完成
description: 已完成并提交，测试全绿
type: project
memoryCategory: project_convention
level: project_fact
evidenceStrength: explicit
confidence: 0.9
tags: topic:feat
`.trim(), 'done');

    const manager = createFileMemoryManager({
      memory: { memoryDir: projectDir },
      enableAsyncPrefetch: false,
    });
    await manager.initialize();

    await expect(fs.access(path.join(userDir, 'user-b.md'))).rejects.toThrow();
    await expect(fs.access(path.join(projectDir, 'feat-overview.md'))).rejects.toThrow();
    const overview = await fs.readFile(
      path.join(root, 'memory-evicted', 'memory-files', 'feat-overview.md'),
      'utf-8',
    );
    expect(overview).toContain('level: session_state');
  });
});

describe('eval: E6a write tools land type:user in user-memory', () => {
  it('write_file / append_file / patch_file 误写 memory-files/user_*.md 后项目库无残留', async () => {
    registerAgentMemoryWriteGuard(createRememberSignalWriteGuard(() => '记住，测试'));
    const tools = createFileTools(root);
    const writeTool = tools.find(t => t.definition.name === 'write_file')!;
    const appendTool = tools.find(t => t.definition.name === 'append_file')!;

    const written = await writeTool.handler({
      path: 'memory-files/user_eval_write.md',
      content: '---\ntype: user\ndescription: eval write\n---\nfrom write_file\n',
    });
    expect(written.success).toBe(true);
    await expect(fs.access(path.join(userDir, 'user_eval_write.md'))).resolves.toBeUndefined();
    await expect(fs.access(path.join(projectDir, 'user_eval_write.md'))).rejects.toThrow();

    const appended = await appendTool.handler({
      path: 'memory-files/user_eval_append.md',
      content: '---\ntype: user\ndescription: eval append\n---\nfrom append_file\n',
    });
    expect(appended.success).toBe(true);
    await expect(fs.access(path.join(userDir, 'user_eval_append.md'))).resolves.toBeUndefined();
    await expect(fs.access(path.join(projectDir, 'user_eval_append.md'))).rejects.toThrow();

    await fs.writeFile(
      path.join(projectDir, 'user_eval_patch.md'),
      '---\ntype: user\ndescription: eval patch\n---\nkeep\n',
      'utf-8',
    );
    markFileRead(root, 'memory-files/user_eval_patch.md');
    const patched = await createPatchTool(root).handler({
      path: 'memory-files/user_eval_patch.md',
      patch: '@@ -5,1 +5,2 @@\n keep\n+patched\n',
    });
    expect(patched.success).toBe(true);
    await expect(fs.access(path.join(userDir, 'user_eval_patch.md'))).resolves.toBeUndefined();
    await expect(fs.access(path.join(projectDir, 'user_eval_patch.md'))).rejects.toThrow();
  });
});

describe('eval: session long-term write cap', () => {
  it('remember 轮主代理写成功后，本会话第二次不同文件写入被拒绝', async () => {
    const harness = new HarnessMemoryIntegration({
      memoryDir: projectDir,
      workspaceRoot: root,
    });
    harness.onLoopStart('记住，commit 用中文', dummyLlm, { triggerUserMessage: '记住，commit 用中文' });
    const tools = createFileTools(root);
    const writeTool = tools.find(t => t.definition.name === 'write_file')!;

    const first = await writeTool.handler({
      path: 'user-memory/user_work_style.md',
      content: '---\ntype: user\n---\ngit commit 用中文\n',
    });
    expect(first.success).toBe(true);

    const second = await writeTool.handler({
      path: 'user-memory/user_other_habit.md',
      content: '---\ntype: user\n---\n另一个习惯\n',
    });
    expect(second.success).toBe(false);
    expect(second.error).toMatch(/session_memory_write_cap/);

    await (harness as unknown as {
      _extractMemoriesImpl: (ctx: {
        messages: UnifiedMessage[];
        turnCount: number;
        gateUserMessage: string;
        conversationStartIndex: number;
        commandsRun: string[];
      }) => Promise<void>;
    })._extractMemoriesImpl({
      messages: [
        { role: 'user', content: '记住，commit 用中文' },
        { role: 'assistant', content: 'ok' },
      ],
      turnCount: 5,
      gateUserMessage: '记住，commit 用中文',
      conversationStartIndex: 0,
      commandsRun: [],
    });
    expect(extractEvents.at(-1)?.skipReason).toBe('session_extract_cap');
    harness.dispose();
  });

  it('每轮 new Harness 后同一 sessionId 仍受写配额约束', async () => {
    const sessionId = `cap-${randomUUID()}`;
    const firstHarness = new HarnessMemoryIntegration({
      memoryDir: projectDir,
      workspaceRoot: root,
      sessionId,
    });
    firstHarness.onLoopStart('记住，commit 用中文', dummyLlm, { triggerUserMessage: '记住，commit 用中文' });
    const writeTool = createFileTools(root, sessionId).find(t => t.definition.name === 'write_file')!;
    const first = await writeTool.handler({
      path: 'user-memory/user_persist_a.md',
      content: '---\ntype: user\n---\nfirst\n',
    });
    expect(first.success).toBe(true);
    firstHarness.dispose();

    const secondHarness = new HarnessMemoryIntegration({
      memoryDir: projectDir,
      workspaceRoot: root,
      sessionId,
    });
    secondHarness.onLoopStart('记住，另一个习惯', dummyLlm, { triggerUserMessage: '记住，另一个习惯' });
    const writeTool2 = createFileTools(root, sessionId).find(t => t.definition.name === 'write_file')!;
    const second = await writeTool2.handler({
      path: 'user-memory/user_persist_b.md',
      content: '---\ntype: user\n---\nsecond\n',
    });
    expect(second.success).toBe(false);
    expect(second.error).toMatch(/session_memory_write_cap/);
    secondHarness.dispose();
  });

  it('并发会话 remember 门控互不覆盖', async () => {
    const sessionA = `rem-a-${randomUUID()}`;
    const sessionB = `rem-b-${randomUUID()}`;
    const harnessA = new HarnessMemoryIntegration({
      memoryDir: projectDir,
      workspaceRoot: root,
      sessionId: sessionA,
    });
    harnessA.onLoopStart('记住，commit 用中文', dummyLlm, { triggerUserMessage: '记住，commit 用中文' });
    const harnessB = new HarnessMemoryIntegration({
      memoryDir: projectDir,
      workspaceRoot: root,
      sessionId: sessionB,
    });
    harnessB.onLoopStart('帮我装 mysql', dummyLlm, { triggerUserMessage: '帮我装 mysql' });

    const writeB = createFileTools(root, sessionB).find(t => t.definition.name === 'write_file')!;
    const blocked = await writeB.handler({
      path: 'user-memory/user_session_b.md',
      content: '---\ntype: user\n---\nshould not write\n',
    });
    expect(blocked.success).toBe(false);
    expect(blocked.error).toMatch(/remember_required/);

    const writeA = createFileTools(root, sessionA).find(t => t.definition.name === 'write_file')!;
    const allowed = await writeA.handler({
      path: 'user-memory/user_session_a.md',
      content: '---\ntype: user\n---\ngit commit 用中文\n',
    });
    expect(allowed.success).toBe(true);
    await expect(fs.access(path.join(userDir, 'user_session_a.md'))).resolves.toBeUndefined();

    harnessA.dispose();
    harnessB.dispose();
  });

  it('前台 run_command 成功写记忆后计入会话 cap；失败不占', async () => {
    const sessionId = `shell-${randomUUID()}`;
    const failHarness = new HarnessMemoryIntegration({
      memoryDir: projectDir,
      workspaceRoot: root,
      sessionId,
    });
    failHarness.onLoopStart('记住，commit 用中文', dummyLlm, { triggerUserMessage: '记住，commit 用中文' });
    const shell = createShellTool(root, sessionId);

    const failed = await shell.handler({
      command: 'echo remembered > user-memory/missing-dir/fail.md',
      background: false,
      timeout: 8_000,
    });
    expect(failed.success).toBe(false);

    const writeTool = createFileTools(root, sessionId).find(t => t.definition.name === 'write_file')!;
    const afterFail = await writeTool.handler({
      path: 'user-memory/user_after_fail.md',
      content: '---\ntype: user\n---\nstill first write\n',
    });
    expect(afterFail.success).toBe(true);
    failHarness.dispose();

    const successSession = `shell-ok-${randomUUID()}`;
    const okHarness = new HarnessMemoryIntegration({
      memoryDir: projectDir,
      workspaceRoot: root,
      sessionId: successSession,
    });
    okHarness.onLoopStart('记住，commit 用中文', dummyLlm, { triggerUserMessage: '记住，commit 用中文' });
    const okShell = createShellTool(root, successSession);
    const written = await okShell.handler({
      command: 'echo remembered > user-memory/from_shell.md',
      background: false,
      timeout: 8_000,
    });
    expect(written.success).toBe(true);
    await expect(fs.access(path.join(userDir, 'from_shell.md'))).resolves.toBeUndefined();

    const writeTool2 = createFileTools(root, successSession).find(t => t.definition.name === 'write_file')!;
    const second = await writeTool2.handler({
      path: 'user-memory/user_after_shell.md',
      content: '---\ntype: user\n---\nshould cap\n',
    });
    expect(second.success).toBe(false);
    expect(second.error).toMatch(/session_memory_write_cap/);
    okHarness.dispose();
  });
});

describe('eval: filename heuristic does not dump docs into user-memory', () => {
  it('user_guide.md 无 type:user 留在项目库；user_hygiene_cleanup.md 仍进用户库', async () => {
    registerAgentMemoryWriteGuard(createRememberSignalWriteGuard(() => '记住，测试'));
    const writeTool = createFileTools(root).find(t => t.definition.name === 'write_file')!;

    const guide = await writeTool.handler({
      path: 'memory-files/user_guide.md',
      content: '---\nname: guide\n---\nhow to use iceCoder\n',
    });
    expect(guide.success).toBe(true);
    await expect(fs.access(path.join(projectDir, 'user_guide.md'))).resolves.toBeUndefined();
    await expect(fs.access(path.join(userDir, 'user_guide.md'))).rejects.toThrow();

    const hygiene = await writeTool.handler({
      path: 'memory-files/user_hygiene_cleanup.md',
      content: '---\nname: hygiene\n---\n零残留：删除临时文件\n',
    });
    expect(hygiene.success).toBe(true);
    await expect(fs.access(path.join(userDir, 'user_hygiene_cleanup.md'))).resolves.toBeUndefined();
    await expect(fs.access(path.join(projectDir, 'user_hygiene_cleanup.md'))).rejects.toThrow();
  });

  it('git 习惯与 pwsh 习惯不得写进同一用户条', async () => {
    registerAgentMemoryWriteGuard(createRememberSignalWriteGuard(() => '记住，测试'));
    const writeTool = createFileTools(root).find(t => t.definition.name === 'write_file')!;
    const mixed = await writeTool.handler({
      path: 'user-memory/user_mixed_shell_git.md',
      content: '---\ntype: user\n---\ngit commit message 必须用中文。命令必须使用 pwsh.exe。\n',
    });
    expect(mixed.success).toBe(false);
    expect(mixed.error).toMatch(/mixed_user_topics/);
  });
});

describe('eval: session_progress is hidden from read_file', () => {
  it('已降级的 *-overview.md 不能再被 read_file 当活跃记忆读到', async () => {
    await writeMem(projectDir, 'icecoder-chat-page-ws-split-overview.md', `
name: chat-page WS 拆分已全部完成（块1-4）
description: 已完成并提交；测试全绿
type: project
memoryCategory: project_convention
level: project_fact
evidenceStrength: explicit
confidence: 0.85
tags: project:icecoder
`.trim(), '块1-4 全部完成并提交');

    await downgradeSessionProgressOverviews(projectDir);

    const tools = createFileTools(root);
    const readTool = tools.find(t => t.definition.name === 'read_file')!;
    const archivedRead = await readTool.handler({
      path: path.join(root, 'memory-evicted', 'memory-files', 'icecoder-chat-page-ws-split-overview.md'),
    });
    expect(archivedRead.success).toBe(true);
    expect(archivedRead.output).toContain('level: session_state');

    await fs.writeFile(
      path.join(projectDir, 'still-active-progress-overview.md'),
      `---
name: 功能已全部完成
description: 已完成并提交，测试全绿
type: project
memoryCategory: session_progress
level: session_state
progressSnapshot: true
tags: status:session_progress
---

stale snapshot
`,
      'utf-8',
    );
    const hidden = await readTool.handler({ path: 'memory-files/still-active-progress-overview.md' });
    expect(hidden.success).toBe(true);
    expect(hidden.output).toBe(SESSION_PROGRESS_TOOL_SKIP_MESSAGE);
    expect(hidden.output).not.toContain('stale snapshot');
  });
});
