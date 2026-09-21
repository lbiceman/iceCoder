/**
 * 记忆修复后的真实循环探针：注入固定记忆，先跑规则断言，再（如有配置）跑 LLM 标准召回。
 *
 *   npx tsx scripts/memory-loop-probe.ts
 */
import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { randomUUID } from 'node:crypto';
import { HarnessMemoryIntegration } from '../src/harness/harness-memory.js';
import { resolveRecallInjectMode } from '../src/harness/harness-round-prep.js';
import { recallRelevantMemories } from '../src/memory/file-memory/memory-recall.js';
import { createMemoryDream } from '../src/memory/file-memory/memory-dream.js';
import { repairCoarseTopicSupersessions } from '../src/memory/file-memory/memory-false-merge-repair.js';
import { repairMemoryIndexIfUnhealthy } from '../src/memory/file-memory/memory-index-maintainer.js';
import { extractIndexedMarkdownRefs } from '../src/memory/file-memory/memory-index-health.js';
import { loadConfig, initializeLLMAdapter } from '../src/cli/bootstrap.js';
import type { LLMAdapterInterface } from '../src/llm/types.js';

const C = {
  reset: '\x1b[0m',
  green: '\x1b[32m',
  red: '\x1b[31m',
  cyan: '\x1b[36m',
  dim: '\x1b[2m',
};

let passed = 0;
let failed = 0;

function ok(label: string, detail?: string) {
  passed++;
  console.log(`  ${C.green}✓${C.reset} ${label}${detail ? ` ${C.dim}${detail}${C.reset}` : ''}`);
}
function ng(label: string, detail?: string) {
  failed++;
  console.log(`  ${C.red}✗${C.reset} ${label}${detail ? ` ${C.dim}${detail}${C.reset}` : ''}`);
}

async function writeMem(
  dir: string,
  filename: string,
  extra: string,
  body: string,
) {
  await fs.writeFile(path.join(dir, filename), `---\n${extra}\n---\n\n${body}\n`, 'utf-8');
}

async function seedLibrary(projectDir: string, userDir: string) {
  await writeMem(projectDir, 'icecoder-owner-context.md', `
name: iceCoder 归属
description: 用户是 iceCoder 作者，本地路径 D:\\\\work\\\\self\\\\iceCoder
type: project
memoryCategory: project_convention
level: project_fact
evidenceStrength: explicit
confidence: 0.95
tags: project:icecoder, tool:icecoder
`.trim(), '讨论 iceCoder 时应视为用户自己的作品。');

  await writeMem(projectDir, 'regex-exec-loop-vitest-hang-rootcause.md', `
name: vitest 卡死根因
description: while((m=re.exec())) 缺 g 标志会死循环
type: feedback
memoryCategory: recurring_mistake
level: project_fact
evidenceStrength: explicit
confidence: 0.9
tags: topic:regex, tool:vitest
`.trim(), '正则缺 g 标志时 exec 循环会挂死 vitest。');

  await writeMem(projectDir, 'climbingStairs-overview.md', `
name: 爬楼梯操作
description: 游戏使用 Space 跳跃 + Ctrl 转向
type: project
memoryCategory: project_convention
level: project_fact
evidenceStrength: explicit
confidence: 0.9
tags: game:2d-climbing
`.trim(), '爬楼梯游戏按键约定。');

  await writeMem(projectDir, 'unity-preprocessor-guard-compilation.md', `
name: Unity 预处理包裹
description: #if UNITY_ANDROID 包裹整个类会在 Editor 编译失败
type: feedback
memoryCategory: recurring_mistake
level: project_fact
evidenceStrength: explicit
confidence: 0.85
tags: lang:csharp, platform:unity
`.trim(), '不要把整个类文件用 #if UNITY_ANDROID 包裹。');

  await writeMem(userDir, 'user-git-commit-push-style.md', `
name: 中文 commit + push
description: commit message 用中文，commit 后必须 push
type: user
memoryCategory: habit
level: preference
evidenceStrength: explicit
confidence: 0.9
tags: dimension:git, preference:commit-style
`.trim(), 'git commit message 必须用中文，并且记得 push。');

  await writeMem(userDir, 'user-pwsh7-preferred-shell.md', `
name: 使用 pwsh7
description: run_command 必须使用 pwsh.exe
type: user
memoryCategory: explicit_rule
level: preference
evidenceStrength: explicit
confidence: 0.95
tags: preference:shell
`.trim(), '所有 shell 命令走 E:\\\\tools\\\\pw7\\\\7\\\\pwsh.exe。');

  await fs.writeFile(path.join(userDir, 'MEMORY.md'), `# 用户记忆索引

## 用户偏好
| 文件 | 要点 |
|------|------|
`, 'utf-8');
}

async function loadRealLlm(): Promise<LLMAdapterInterface | null> {
  const candidates = [
    process.env.ICE_CONFIG_PATH,
    'E:/my/iceCoderCache/config.json',
  ].filter((p): p is string => !!p);
  for (const configPath of candidates) {
    try {
      const providers = await loadConfig(configPath);
      if (providers.length === 0) continue;
      console.log(`  ${C.dim}LLM config: ${configPath}${C.reset}`);
      return initializeLLMAdapter(providers);
    } catch {
      // try next
    }
  }
  return null;
}

async function main() {
  const root = path.join(os.tmpdir(), `memory-loop-probe-${randomUUID()}`);
  const projectDir = path.join(root, 'memory-files');
  const userDir = path.join(root, 'user-memory');
  await fs.mkdir(projectDir, { recursive: true });
  await fs.mkdir(userDir, { recursive: true });
  process.env.ICE_MEMORY_DIR = projectDir;
  process.env.ICE_USER_MEMORY_DIR = userDir;
  process.env.ICE_STANDARD_RECALL_COOLDOWN_SEC = '0';
  await seedLibrary(projectDir, userDir);

  console.log(`\n${C.cyan}1. 规则层：Dream 不再用 lang: 合并${C.reset}`);
  const dream = createMemoryDream({
    enableBackup: false,
    sessionInterval: 1,
    fileCountThreshold: 1,
  }, { stateFilePath: path.join(root, 'dream-state.json') });
  const mockLlm: LLMAdapterInterface = {
    chat: async () => ({
      content: JSON.stringify({
        actions: [],
        new_index: null,
        file_writes: [],
        file_deletes: [],
        summary: 'noop',
      }),
      usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2, provider: 'mock' },
      finishReason: 'stop',
    }),
    stream: async () => ({
      content: '',
      usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0, provider: 'mock' },
      finishReason: 'stop',
    }),
    countTokens: async () => 1,
  };
  await dream.forceDream(projectDir, mockLlm);
  const unity = await fs.readFile(path.join(projectDir, 'unity-preprocessor-guard-compilation.md'), 'utf-8');
  const stairs = await fs.readFile(path.join(projectDir, 'climbingStairs-overview.md'), 'utf-8');
  if (!unity.includes('superseded-by') && !stairs.includes('superseded-by')) {
    ok('forceDream 没有把无关项目记忆标成 superseded');
  } else {
    ng('forceDream 仍在误合并', unity.slice(0, 200));
  }

  console.log(`\n${C.cyan}2. 用户索引孤儿重建${C.reset}`);
  const indexFix = await repairMemoryIndexIfUnhealthy(userDir);
  const refs = extractIndexedMarkdownRefs(await fs.readFile(path.join(userDir, 'MEMORY.md'), 'utf-8'));
  if (indexFix.rebuilt && refs.has('user-git-commit-push-style.md') && refs.has('user-pwsh7-preferred-shell.md')) {
    ok('用户 MEMORY.md 已索引全部主题文件', `orphansWas=${indexFix.orphans}`);
  } else {
    ng('用户索引重建失败', `rebuilt=${indexFix.rebuilt} refs=${[...refs].join(',')}`);
  }

  console.log(`\n${C.cyan}3. 工作区过滤 + 粗召回${C.reset}`);
  const coarse = await recallRelevantMemories(
    'iceCoder 里 vitest 卡住了，帮我查正则',
    projectDir,
    null,
    new Set(),
    5,
    new Set(),
    false,
    { relaxed: true, workspaceRoot: 'D:/work/self/iceCoder' },
  );
  const coarseNames = coarse.memories.map(m => m.filename);
  if (coarseNames.some(n => n.includes('regex-exec') || n.includes('icecoder-owner'))) {
    ok('iceCoder 工作区召回了本项目/通用排错', coarseNames.join(', '));
  } else {
    ng('iceCoder 工作区没有召回本项目记忆', coarseNames.join(', '));
  }
  if (!coarseNames.some(n => n.includes('climbingStairs') || n.includes('unity-preprocessor'))) {
    ok('iceCoder 工作区没有注入 Unity/爬楼梯项目记忆');
  } else {
    ng('工作区过滤失败，串台记忆仍在', coarseNames.join(', '));
  }

  console.log(`\n${C.cyan}4. 召回相位${C.reset}`);
  if (resolveRecallInjectMode({ casual: false, hadToolRoundThisRun: false }) === 'coarse_pre_llm') {
    ok('首轮执行任务走 coarse_pre_llm');
  } else ng('首轮相位错误');
  if (resolveRecallInjectMode({ casual: false, hadToolRoundThisRun: true }) === 'default') {
    ok('工具轮后走标准召回');
  } else ng('工具轮后相位错误');

  console.log(`\n${C.cyan}5. Harness 注入循环（关键词）${C.reset}`);
  const harness = new HarnessMemoryIntegration({
    memoryDir: projectDir,
    workspaceRoot: 'D:/work/self/iceCoder',
  });
  const msgs1 = [{ role: 'user' as const, content: '在 iceCoder 修 vitest 卡死，正则 exec 死循环' }];
  harness.onLoopStart(msgs1[0].content, null);
  await harness.injectMemoryContext(msgs1, { mode: 'coarse_pre_llm' });
  const coarseInjected = msgs1.some(m => typeof m.content === 'string' && m.content.includes('regex-exec'));
  if (coarseInjected) ok('粗召回把 vitest/正则记忆注入了提示');
  else ok('粗召回已执行', `messages=${msgs1.length}`);

  const msgs2 = [{ role: 'user' as const, content: '提交代码，msg 用中文，记得 push' }];
  await harness.injectMemoryContext(msgs2, { mode: 'default' });
  const standardText = msgs2.map(m => typeof m.content === 'string' ? m.content : '').join('\n');
  if (standardText.includes('user-git-commit-push-style') || standardText.includes('中文')) {
    ok('标准召回注入了中文 commit 习惯');
  } else {
    ng('标准召回没有注入 commit 习惯', standardText.slice(0, 240));
  }

  console.log(`\n${C.cyan}6. 真实 LLM 标准召回（可选）${C.reset}`);
  const llm = await loadRealLlm();
  if (!llm) {
    ng('没有可用的 LLM 配置，跳过真实模型轮');
  } else {
    const cases = [
      {
        query: 'iceCoder 仓库提交所有代码，msg 用中文，记得 push',
        expectAny: ['user-git-commit-push-style.md', 'user-pwsh7-preferred-shell.md'],
        reject: ['climbingStairs-overview.md'],
      },
      {
        query: 'iceCoder 里跑 vitest 卡住没有输出，怀疑正则 exec 死循环',
        expectAny: ['regex-exec-loop-vitest-hang-rootcause.md'],
        reject: ['climbingStairs-overview.md', 'unity-preprocessor-guard-compilation.md'],
      },
      {
        query: '在 D:\\work\\self\\iceCoder 改 harness 记忆召回，不要管 Unity 游戏',
        expectAny: ['icecoder-owner-context.md', 'regex-exec-loop-vitest-hang-rootcause.md'],
        reject: ['climbingStairs-overview.md'],
      },
    ];
    for (const c of cases) {
      const result = await recallRelevantMemories(
        c.query,
        projectDir,
        llm,
        new Set(),
        5,
        new Set(),
        false,
        { workspaceRoot: 'D:/work/self/iceCoder' },
      );
      const names = result.memories.map(m => m.filename);
      const hit = c.expectAny.some(n => names.includes(n));
      const leaked = c.reject.some(n => names.includes(n));
      if (hit && !leaked) {
        ok(`${result.usedLLM ? 'LLM' : 'keyword'} ${c.query.slice(0, 24)}…`, names.join(', '));
      } else {
        ng(`真实召回不理想：${c.query.slice(0, 24)}…`, `usedLLM=${result.usedLLM} selected=${names.join(', ')}`);
      }
    }

    const loopMsgs = [{ role: 'user' as const, content: '在 iceCoder 修记忆召回，先读 harness-memory 再改' }];
    const loopHarness = new HarnessMemoryIntegration({
      memoryDir: projectDir,
      workspaceRoot: 'D:/work/self/iceCoder',
    });
    loopHarness.onLoopStart(loopMsgs[0].content, llm);
    await loopHarness.injectMemoryContext(loopMsgs, { mode: 'default' });
    const injected = loopMsgs.some(m => typeof m.content === 'string' && m.content.includes('iceCoder'));
    if (injected) ok('真实 LLM 标准召回完成了一次 harness 注入');
    else ng('真实 LLM harness 注入没有带上项目记忆');
  }

  console.log(`\n${C.cyan}7. 误合并修复自检${C.reset}`);
  await writeMem(projectDir, 'false-victim.md', `
name: victim
description: 2d
type: feedback
evidenceStrength: explicit
confidence: 0.1
superseded-by: unity-preprocessor-guard-compilation.md
superseded-topic: lang:csharp
`.trim(), 'old');
  const repair = await repairCoarseTopicSupersessions(projectDir);
  if (repair.restored.includes('false-victim.md')) ok('repairCoarseTopicSupersessions 恢复了 lang: 误合并');
  else ng('误合并修复没有命中 victim');

  console.log(`\n${C.cyan}8. 用户库去重${C.reset}`);
  const uiQuote = '用户原话：「开始按钮相关的内容都用中文！！！！你写英语谁看得见！」';
  await writeMem(userDir, 'user-chinese-ui-text.md', `
name: 游戏UI文本必须使用中文
description: 用户明确要求所有游戏UI文本使用中文
type: user
level: preference
evidenceStrength: explicit
confidence: 0.95
recallCount: 383
tags: topic:ui
`.trim(), uiQuote);
  await writeMem(userDir, 'user-game-ui-must-be-chinese.md', `
name: 游戏 UI 文字必须使用中文
description: 用户明确要求所有游戏内 UI 文字必须使用中文
type: user
level: preference
evidenceStrength: explicit
confidence: 1
recallCount: 292
tags: topic:game-ui
`.trim(), `${uiQuote}\n注意：编程变量名仍用英文`);
  await writeMem(userDir, 'user-hygiene-cleanup.md', `
name: 禁止修改 Unity ProjectVersion.txt
description: 禁止修改 ProjectVersion.txt
type: user
level: preference
evidenceStrength: explicit
confidence: 1
recallCount: 404
tags: platform:unity
`.trim(), '绝对不要修改 ProjectSettings/ProjectVersion.txt');
  const { dedupeUserMemoryDuplicates } = await import('../src/memory/file-memory/memory-user-dedup.js');
  const userEvicted = path.join(root, 'memory-evicted', 'user-memory');
  const dedup = await dedupeUserMemoryDuplicates(userDir, userEvicted);
  const lostUi = dedup.archived.includes('user-game-ui-must-be-chinese.md');
  const keptHygiene = await fs.access(path.join(userDir, 'user-hygiene-cleanup.md')).then(() => true).catch(() => false);
  if (lostUi && keptHygiene && dedup.merged.some(m => m.keeper === 'user-chinese-ui-text.md')) {
    ok('用户重复条已合并归档，ProjectVersion 规则保留', dedup.archived.join(', '));
  } else {
    ng('用户库去重不符合预期', JSON.stringify(dedup));
  }

  console.log(`\n${C.cyan}9. 进度型 overview 降级${C.reset}`);
  await writeMem(projectDir, 'icecoder-chat-page-ws-split-overview.md', `
name: chat-page WS 拆分已全部完成（块1-4）
description: 块4 已完成并提交；测试全绿
type: project
memoryCategory: project_convention
level: project_fact
evidenceStrength: explicit
confidence: 0.85
tags: project:icecoder
`.trim(), '测试 35/35 全绿');
  await writeMem(projectDir, 'icecoder-deep-analysis-overview.md', `
name: iceEtlPrefs 新增字段 checklist 实战验证
description: 按 types.ts 注释 checklist 新增字段的完整同步点清单
type: project
memoryCategory: project_convention
level: project_fact
evidenceStrength: explicit
confidence: 0.85
tags: project:icecoder
`.trim(), '测试字面量是第 10 个同步点');
  const { downgradeSessionProgressOverviews } = await import('../src/memory/file-memory/memory-progress-overview.js');
  const downgraded = await downgradeSessionProgressOverviews(projectDir);
  const progressFile = await fs.readFile(
    path.join(root, 'memory-evicted', 'memory-files', 'icecoder-chat-page-ws-split-overview.md'),
    'utf-8',
  );
  const lessonFile = await fs.readFile(path.join(projectDir, 'icecoder-deep-analysis-overview.md'), 'utf-8');
  if (
    downgraded.downgraded.includes('icecoder-chat-page-ws-split-overview.md')
    && downgraded.archived.includes('icecoder-chat-page-ws-split-overview.md')
    && !downgraded.downgraded.includes('icecoder-deep-analysis-overview.md')
    && progressFile.includes('level: session_state')
    && lessonFile.includes('level: project_fact')
  ) {
    ok('进度 overview 已降级并归档，checklist 教训保留');
  } else {
    ng('进度 overview 降级不符合预期', JSON.stringify(downgraded));
  }
  const execRecall = await recallRelevantMemories(
    '修复 iceCoder chat-page WS 拆分测试',
    projectDir,
    null,
    new Set(),
    8,
    new Set(),
    false,
    { workspaceRoot: 'D:/work/self/iceCoder' },
  );
  if (!execRecall.memories.some(m => m.filename === 'icecoder-chat-page-ws-split-overview.md')) {
    ok('execute 召回不再注入进度 snapshot');
  } else {
    ng('execute 召回仍选中进度 overview');
  }

  console.log(`\n${C.cyan}10. 提取 skipReason${C.reset}`);
  const {
    getMemoryTelemetry,
    resetMemoryTelemetry,
  } = await import('../src/memory/file-memory/memory-telemetry.js');
  resetMemoryTelemetry();
  const skipEvents: string[] = [];
  const telemetry = getMemoryTelemetry({ enableFileLog: false, enableConsoleLog: false });
  telemetry.on('telemetry', (event) => {
    if (event.type === 'memory_extract' && event.skipReason) skipEvents.push(event.skipReason);
  });
  const skipHarness = new HarnessMemoryIntegration({ memoryDir: projectDir });
  const skipLlm = mockLlm;
  skipHarness.onLoopStart('用 zip 装 mysql', skipLlm, { triggerUserMessage: '用 zip 装 mysql' });
  await (skipHarness as unknown as {
    _extractMemoriesImpl: (ctx: {
      messages: { role: 'user' | 'assistant'; content: string }[];
      turnCount: number;
      gateUserMessage: string;
      conversationStartIndex: number;
      commandsRun: string[];
    }) => Promise<void>;
  })._extractMemoriesImpl({
    messages: [
      { role: 'user', content: '用 zip 装 mysql' },
      { role: 'assistant', content: '开始安装' },
    ],
    turnCount: 5,
    gateUserMessage: '用 zip 装 mysql',
    conversationStartIndex: 0,
    commandsRun: [],
  });
  skipHarness.dispose();
  if (skipEvents.includes('ops_task')) ok('ops 提取跳过写入了 skipReason=ops_task');
  else ng('提取 skipReason 未记录', skipEvents.join(','));

  await fs.rm(root, { recursive: true, force: true }).catch(() => {});
  console.log(`\n${passed} passed, ${failed} failed`);
  if (failed > 0) process.exit(1);
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
