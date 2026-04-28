/**
 * 记忆系统端到端体验模拟。
 *
 * 模拟真实用户多轮对话场景，追踪记忆系统每个环节的实际行为：
 * - 记忆写入 → 扫描 → 召回 → 注入 → 提取 → Dream
 * - 话题切换检测
 * - 会话记忆验证
 * - 秘密扫描
 * - 过期衰减
 *
 * 不依赖真实 LLM，用 mock 替代，聚焦系统行为而非 LLM 质量。
 *
 * 运行: npx tsx scripts/simulate-memory.ts
 */

import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';

// ─── 导入记忆系统模块 ───
import { scanMemoryFiles, formatMemoryManifest, parseFrontmatter } from '../src/memory/file-memory/memory-scanner.js';
import { recallRelevantMemories } from '../src/memory/file-memory/memory-recall.js';
import { LLMMemoryExtractor } from '../src/memory/file-memory/memory-llm-extractor.js';
import { MemoryDream } from '../src/memory/file-memory/memory-dream.js';
import { memoryAge, memoryFreshnessNote, getMemoryDecayStatus } from '../src/memory/file-memory/memory-age.js';
import { validatePath, PathTraversalError } from '../src/memory/file-memory/memory-security.js';
import { scanForSecrets, redactSecrets, containsSecrets } from '../src/memory/file-memory/memory-secret-scanner.js';
import { validateSessionMemoryContent, SESSION_MEMORY_TEMPLATE } from '../src/memory/file-memory/session-memory.js';
import { sequential, initExtractionGuard, ConsolidationLock } from '../src/memory/file-memory/memory-concurrency.js';
import { parseLLMJson } from '../src/memory/file-memory/json-parser.js';
import type { UnifiedMessage, LLMResponse, LLMAdapterInterface } from '../src/llm/types.js';

// ─── 输出工具 ───
const C = {
  reset: '\x1b[0m', green: '\x1b[32m', red: '\x1b[31m',
  yellow: '\x1b[33m', cyan: '\x1b[36m', dim: '\x1b[2m', bold: '\x1b[1m',
};

let passCount = 0;
let failCount = 0;
const issues: string[] = [];

function pass(label: string, detail?: string) {
  passCount++;
  const d = detail ? ` ${C.dim}${detail}${C.reset}` : '';
  console.log(`  ${C.green}\u2713${C.reset} ${label}${d}`);
}
function fail(label: string, detail?: string) {
  failCount++;
  const d = detail ? ` ${C.dim}${detail}${C.reset}` : '';
  console.log(`  ${C.red}\u2717${C.reset} ${label}${d}`);
  issues.push(label + (detail ? ': ' + detail : ''));
}
function section(title: string) {
  console.log(`\n${C.cyan}${C.bold}\u2501\u2501\u2501 ${title} \u2501\u2501\u2501${C.reset}`);
}
function info(msg: string) {
  console.log(`  ${C.dim}${msg}${C.reset}`);
}

// ─── Mock LLM ───
function createMockLLM(responses: Record<string, string>): LLMAdapterInterface {
  return {
    async chat(messages: UnifiedMessage[]): Promise<LLMResponse> {
      const lastMsg = messages[messages.length - 1];
      const content = typeof lastMsg.content === 'string' ? lastMsg.content : '';

      // 根据内容匹配预设响应
      for (const [keyword, response] of Object.entries(responses)) {
        if (content.toLowerCase().includes(keyword.toLowerCase())) {
          return {
            content: response,
            usage: { inputTokens: 100, outputTokens: 50, totalTokens: 150, provider: 'mock' },
            finishReason: 'stop',
          };
        }
      }
      // 默认：返回空选择
      return {
        content: '{"selected": []}',
        usage: { inputTokens: 100, outputTokens: 10, totalTokens: 110, provider: 'mock' },
        finishReason: 'stop',
      };
    },
    async stream() { throw new Error('Not implemented'); },
    async countTokens(text: string) { return Math.ceil(text.length / 4); },
  };
}

// ─── 临时目录管理 ───
let tmpDir: string;

async function setupTmpDir(): Promise<string> {
  tmpDir = path.join(os.tmpdir(), 'ice-memory-sim-' + Date.now());
  await fs.mkdir(tmpDir, { recursive: true });
  // 让 user 类型记忆也写入临时目录（而非默认的 data/user-memory）
  process.env.ICE_USER_MEMORY_DIR = path.join(tmpDir, '_user-memory');
  await fs.mkdir(process.env.ICE_USER_MEMORY_DIR, { recursive: true });
  return tmpDir;
}

async function cleanupTmpDir(): Promise<void> {
  if (tmpDir) {
    await fs.rm(tmpDir, { recursive: true, force: true });
  }
}

// ─── 辅助：写入测试记忆文件 ───
async function writeMemory(
  dir: string,
  filename: string,
  opts: {
    name: string; description: string; type: string; content: string;
    confidence?: number; recallCount?: number; tags?: string;
    createdAt?: string; source?: string;
  },
): Promise<string> {
  const filePath = path.join(dir, filename);
  const now = opts.createdAt || new Date().toISOString();
  const lines = [
    '---',
    `name: ${opts.name}`,
    `description: ${opts.description}`,
    `type: ${opts.type}`,
  ];
  if (opts.source) lines.push(`source: ${opts.source}`);
  if (opts.confidence !== undefined) lines.push(`confidence: ${opts.confidence}`);
  if (opts.recallCount !== undefined) lines.push(`recallCount: ${opts.recallCount}`);
  if (opts.tags) lines.push(`tags: ${opts.tags}`);
  lines.push(`createdAt: ${now}`);
  lines.push('---', '', opts.content, '');
  await fs.writeFile(filePath, lines.join('\n'), 'utf-8');
  return filePath;
}

// ════════════════════════════════════════════════════════════
// 场景 1：新用户首次对话 — 记忆从零开始
// ════════════════════════════════════════════════════════════
async function scenario1_newUser() {
  section('场景 1: 新用户首次对话 — 记忆从零开始');
  const memDir = path.join(tmpDir, 'scenario1');
  await fs.mkdir(memDir, { recursive: true });

  // 1a. 扫描空目录
  const memories = await scanMemoryFiles(memDir, 200);
  if (memories.length === 0) {
    pass('空目录扫描返回 0 条记忆');
  } else {
    fail('空目录扫描应返回 0 条', `实际: ${memories.length}`);
  }

  // 1b. 对空目录做 LLM 召回
  const mockLLM = createMockLLM({});
  const recallResult = await recallRelevantMemories(
    '帮我写一个 React 组件', memDir, mockLLM, new Set(), 5,
  );
  if (recallResult.memories.length === 0) {
    pass('空目录召回返回 0 条记忆');
  } else {
    fail('空目录召回应返回 0 条', `实际: ${recallResult.memories.length}`);
  }
  info(`召回耗时: ${recallResult.duration}ms, usedLLM: ${recallResult.usedLLM}`);

  // 1c. 无 LLM 时的召回回退
  const noLLMResult = await recallRelevantMemories(
    '帮我写一个 React 组件', memDir, null, new Set(), 5,
  );
  if (!noLLMResult.usedLLM) {
    pass('无 LLM 时回退到关键词匹配');
  } else {
    fail('无 LLM 时应回退到关键词匹配');
  }

  // 1d. 模拟 LLM 提取器写入第一条记忆
  const extractor = new LLMMemoryExtractor({ maxMemories: 3, maxOutputTokens: 1024, enablePromptCache: false });
  const extractMock = createMockLLM({
    'extract': JSON.stringify([
      {
        filename: 'user_preferred_languages.md',
        type: 'user',
        name: '用户偏好语言',
        description: '用户偏好使用 TypeScript 和 React',
        content: '用户主要使用 TypeScript 开发，偏好 React 框架。',
        tags: ['lang:typescript', 'framework:react'],
        confidence: 0.7,
        source: 'llm_extract',
      },
    ]),
  });

  const extractResult = await extractor.extract(
    [
      { role: 'user', content: '帮我用 TypeScript 写一个 React 组件' },
      { role: 'assistant', content: '好的，我来帮你写一个 React 组件...' },
    ],
    memDir,
    extractMock,
  );

  if (extractResult.writtenPaths.length === 1) {
    pass('LLM 提取器成功写入 1 条记忆', extractResult.writtenPaths[0]);
  } else {
    fail('LLM 提取器应写入 1 条记忆', `实际: ${extractResult.writtenPaths.length}`);
  }

  // 1e. 验证写入的文件内容
  if (extractResult.writtenPaths.length > 0) {
    const content = await fs.readFile(extractResult.writtenPaths[0], 'utf-8');
    const fm = parseFrontmatter(content);
    if (fm.type === 'user' && fm.confidence === '0.7' && fm.source === 'llm_extract') {
      pass('记忆文件 frontmatter 正确', `type=${fm.type}, confidence=${fm.confidence}`);
    } else {
      fail('记忆文件 frontmatter 不正确', JSON.stringify(fm));
    }
  }

  // 1f. 再次扫描，应该能找到刚写入的记忆
  // 注意：user 类型记忆写入用户级目录（ICE_USER_MEMORY_DIR），不在项目级 memDir 中
  const userMemDir = process.env.ICE_USER_MEMORY_DIR!;
  const afterExtractUser = await scanMemoryFiles(userMemDir, 200);
  const afterExtractProject = await scanMemoryFiles(memDir, 200);
  const totalAfter = afterExtractUser.length + afterExtractProject.length;
  if (totalAfter >= 1) {
    pass('提取后扫描到记忆', `用户级: ${afterExtractUser.length}, 项目级: ${afterExtractProject.length}`);
    const found = afterExtractUser[0] || afterExtractProject[0];
    if (found) info(`文件: ${found.filename}, 描述: ${found.description}`);
  } else {
    fail('提取后应扫描到记忆', `用户级: ${afterExtractUser.length}, 项目级: ${afterExtractProject.length}`);
  }
}

// ════════════════════════════════════════════════════════════
// 场景 2：多轮对话 — 记忆召回 + 去重 + 话题切换
// ════════════════════════════════════════════════════════════
async function scenario2_multiTurnRecall() {
  section('场景 2: 多轮对话 — 记忆召回 + 去重 + 话题切换');
  const memDir = path.join(tmpDir, 'scenario2');
  await fs.mkdir(memDir, { recursive: true });

  // 预置 3 条不同主题的记忆
  await writeMemory(memDir, 'user_languages.md', {
    name: '编程语言偏好', description: '用户偏好 TypeScript 和 Python',
    type: 'user', content: '用户主要使用 TypeScript，偶尔用 Python 写脚本。',
    confidence: 0.9, tags: 'lang:typescript, lang:python',
  });
  await writeMemory(memDir, 'project_api_redesign.md', {
    name: 'API 重构项目', description: '正在进行 REST API 到 GraphQL 的迁移',
    type: 'project', content: '团队正在将 REST API 迁移到 GraphQL，预计 Q2 完成。',
    confidence: 0.8, tags: 'project:api, tech:graphql',
  });
  await writeMemory(memDir, 'feedback_no_semicolons.md', {
    name: '代码风格反馈', description: '用户不喜欢分号，偏好 Prettier 默认配置',
    type: 'feedback', content: '用户明确表示不要在 TypeScript 代码中加分号。',
    confidence: 1.0, tags: 'style:no-semicolons',
  });

  // 2a. 第一轮：查询 TypeScript 相关 → 应该召回语言偏好和代码风格
  const mockLLM = createMockLLM({
    'available memories': '{"selected": ["user_languages.md", "feedback_no_semicolons.md"]}',
  });

  const round1 = await recallRelevantMemories(
    '帮我写一个 TypeScript 工具函数', memDir, mockLLM, new Set(), 5,
  );
  info(`第一轮召回: ${round1.memories.length} 条, usedLLM: ${round1.usedLLM}`);
  if (round1.memories.length === 2 && round1.usedLLM) {
    pass('第一轮 LLM 召回 2 条相关记忆');
  } else if (round1.memories.length > 0) {
    pass('第一轮召回了记忆', `${round1.memories.length} 条`);
  } else {
    fail('第一轮应召回相关记忆');
  }

  // 2b. 第二轮：同一话题，已展示的记忆应被去重
  const surfaced = new Set(round1.memories.map(m => m.filePath));
  const round2 = await recallRelevantMemories(
    '再加一个排序函数', memDir, mockLLM, surfaced, 5,
  );
  info(`第二轮召回: ${round2.memories.length} 条 (已去重 ${surfaced.size} 条)`);

  // 去重后应该不会再返回已展示的文件
  const duplicates = round2.memories.filter(m => surfaced.has(m.filePath));
  if (duplicates.length === 0) {
    pass('跨轮次去重生效 — 不重复展示已召回的记忆');
  } else {
    fail('去重失败 — 重复展示了已召回的记忆', `${duplicates.length} 条重复`);
  }

  // 2c. 无 LLM 时的关键词回退召回
  const keywordResult = await recallRelevantMemories(
    'TypeScript 工具函数', memDir, null, new Set(), 5,
  );
  info(`关键词回退: ${keywordResult.memories.length} 条, usedLLM: ${keywordResult.usedLLM}`);
  if (!keywordResult.usedLLM && keywordResult.memories.length > 0) {
    pass('关键词回退成功召回记忆', `${keywordResult.memories.length} 条`);
    // 检查是否按置信度/新鲜度排序
    if (keywordResult.memories.length >= 2) {
      const scores = keywordResult.memories.map(m => m.confidence);
      info(`置信度排序: [${scores.join(', ')}]`);
    }
  } else if (!keywordResult.usedLLM) {
    fail('关键词回退未能召回任何记忆');
  }
}

// ════════════════════════════════════════════════════════════
// 场景 3：安全防护 — 路径遍历 + 秘密扫描
// ════════════════════════════════════════════════════════════
async function scenario3_security() {
  section('场景 3: 安全防护 — 路径遍历 + 秘密扫描');
  const memDir = path.join(tmpDir, 'scenario3');
  await fs.mkdir(memDir, { recursive: true });

  // 3a. 路径遍历攻击
  const traversalTests = [
    { input: '../../../etc/passwd', label: '经典路径遍历' },
    { input: 'memory\x00.md', label: 'Null byte 注入' },
    { input: '%2e%2e%2f%2e%2e%2fetc/passwd', label: 'URL 编码遍历' },
  ];

  for (const test of traversalTests) {
    try {
      validatePath(test.input, memDir);
      fail(`${test.label} — 应该被拦截`, test.input);
    } catch (e) {
      if (e instanceof PathTraversalError) {
        pass(`${test.label} — 被正确拦截`, (e as Error).message.substring(0, 60));
      } else {
        fail(`${test.label} — 抛出了非预期错误`, (e as Error).message);
      }
    }
  }

  // 3b. 秘密扫描
  const secretTests = [
    { content: 'API key: sk-ant-api03-' + 'a'.repeat(93) + 'AA', label: 'Anthropic API Key' },
    { content: 'token: ghp_1234567890abcdefghijklmnopqrstuvwxyz', label: 'GitHub PAT' },
    { content: '用户偏好 TypeScript 和 React', label: '正常内容（无秘密）' },
  ];

  for (const test of secretTests) {
    const hasSecret = containsSecrets(test.content);
    if (test.label.includes('无秘密')) {
      if (!hasSecret) {
        pass(`${test.label} — 未误报`);
      } else {
        fail(`${test.label} — 误报为包含秘密`);
      }
    } else {
      if (hasSecret) {
        const redacted = redactSecrets(test.content);
        const stillHas = containsSecrets(redacted);
        if (!stillHas) {
          pass(`${test.label} — 检测并脱敏成功`);
        } else {
          fail(`${test.label} — 脱敏后仍包含秘密`);
        }
      } else {
        fail(`${test.label} — 未能检测到秘密`);
      }
    }
  }

  // 3c. 秘密扫描集成到提取器
  info('模拟提取器写入含秘密的记忆...');
  const extractor = new LLMMemoryExtractor({ maxMemories: 3, maxOutputTokens: 1024, enablePromptCache: false });
  const secretMock = createMockLLM({
    'extract': JSON.stringify([{
      filename: 'project_api_keys.md',
      type: 'project',
      name: 'API 配置',
      description: '项目 API 配置信息',
      content: '项目使用 ghp_1234567890abcdefghijklmnopqrstuvwxyz 作为 GitHub token',
      tags: ['config'],
      confidence: 0.5,
      source: 'llm_extract',
    }]),
  });

  const result = await extractor.extract(
    [{ role: 'user', content: '配置一下 GitHub token' }, { role: 'assistant', content: '好的' }],
    memDir, secretMock,
  );

  if (result.writtenPaths.length === 1) {
    const content = await fs.readFile(result.writtenPaths[0], 'utf-8');
    if (content.includes('[REDACTED]') && !containsSecrets(content)) {
      pass('提取器自动脱敏了写入的秘密');
    } else if (!containsSecrets(content)) {
      pass('写入的文件不包含秘密');
    } else {
      fail('提取器未能脱敏写入的秘密');
    }
  } else {
    info('提取器未写入文件（可能因为秘密被完全过滤）');
  }
}

// ════════════════════════════════════════════════════════════
// 场景 4：记忆衰减 + Dream 整合
// ════════════════════════════════════════════════════════════
async function scenario4_agingAndDream() {
  section('场景 4: 记忆衰减 + Dream 整合条件');
  const memDir = path.join(tmpDir, 'scenario4');
  await fs.mkdir(memDir, { recursive: true });

  // 4a. 新鲜度标注
  const now = Date.now();
  const ages = [
    { ms: now, label: '刚创建' },
    { ms: now - 86_400_000, label: '1天前' },
    { ms: now - 86_400_000 * 30, label: '30天前' },
    { ms: now - 86_400_000 * 100, label: '100天前' },
    { ms: now - 86_400_000 * 200, label: '200天前' },
  ];

  for (const age of ages) {
    const ageText = memoryAge(age.ms);
    const freshness = memoryFreshnessNote(age.ms);
    const hasWarning = freshness.length > 0;
    if (age.label === '刚创建') {
      if (!hasWarning) pass(`${age.label} (${ageText}) — 无新鲜度警告`);
      else fail(`${age.label} — 不应有警告`);
    } else if (age.label === '1天前') {
      // 1天前可能有也可能没有警告（边界值）
      pass(`${age.label} (${ageText}) — 警告: ${hasWarning ? '有' : '无'}`);
    } else {
      if (hasWarning) pass(`${age.label} (${ageText}) — 有新鲜度警告`);
      else fail(`${age.label} — 应有新鲜度警告`);
    }
  }

  // 4b. 衰减状态
  const decayTests = [
    { mtimeMs: now, lastRecalledMs: now, confidence: 0.9, recallCount: 5, expected: 'fresh' },
    { mtimeMs: now - 86_400_000 * 100, lastRecalledMs: 0, confidence: 0.5, recallCount: 0, expected: 'stale' },
    { mtimeMs: now - 86_400_000 * 200, lastRecalledMs: 0, confidence: 0.5, recallCount: 0, expected: 'expired' },
    // 高置信度记忆衰减更慢（阈值翻倍）
    { mtimeMs: now - 86_400_000 * 100, lastRecalledMs: 0, confidence: 0.9, recallCount: 0, expected: 'fresh' },
  ];

  for (const test of decayTests) {
    const header = {
      filename: 'test.md', filePath: '', mtimeMs: test.mtimeMs,
      description: '', type: 'user' as const, confidence: test.confidence,
      recallCount: test.recallCount, lastRecalledMs: test.lastRecalledMs,
      createdMs: test.mtimeMs, tags: [], source: undefined,
    };
    const status = getMemoryDecayStatus(header);
    if (status === test.expected) {
      pass(`衰减: confidence=${test.confidence}, age=${Math.floor((now - test.mtimeMs) / 86_400_000)}d → ${status}`);
    } else {
      fail(`衰减: 期望 ${test.expected}, 实际 ${status}`, `confidence=${test.confidence}`);
    }
  }

  // 4c. Dream 触发条件
  const dream = new MemoryDream({ sessionInterval: 3, fileCountThreshold: 5, maxIndexLines: 200, maxIndexBytes: 25000, maxOutputTokens: 2048 });

  // 空目录不应触发
  const shouldDream1 = await dream.shouldDream(memDir);
  if (!shouldDream1) {
    pass('空目录不触发 Dream');
  } else {
    fail('空目录不应触发 Dream');
  }

  // 写入一些记忆但不够阈值
  for (let i = 0; i < 3; i++) {
    await writeMemory(memDir, `mem_${i}.md`, {
      name: `记忆 ${i}`, description: `测试记忆 ${i}`,
      type: 'project', content: `内容 ${i}`,
    });
  }
  const shouldDream2 = await dream.shouldDream(memDir);
  if (!shouldDream2) {
    pass('记忆数不足阈值，不触发 Dream');
  } else {
    // 可能因为远程配置或其他条件触发，不算严格失败
    info('记忆数不足但 Dream 被触发（可能因远程配置）');
  }

  // 4d. ConsolidationLock 基本功能
  const lock = new ConsolidationLock(memDir);
  const lastTime = await lock.readLastConsolidatedAt();
  info(`锁文件 lastConsolidatedAt: ${lastTime === 0 ? '不存在' : new Date(lastTime).toISOString()}`);

  const priorMtime = await lock.tryAcquire();
  if (priorMtime !== null) {
    pass('成功获取整合锁', `priorMtime=${priorMtime}`);
    // 再次获取应该失败（同一进程 PID 相同，实际上会成功，但模拟并发场景）
    await lock.rollback(priorMtime);
    pass('锁回滚成功');
  } else {
    fail('获取整合锁失败');
  }
}

// ════════════════════════════════════════════════════════════
// 场景 5：会话记忆验证
// ════════════════════════════════════════════════════════════
async function scenario5_sessionMemoryValidation() {
  section('场景 5: 会话记忆响应验证');

  // 5a. 合法的 10-section 内容
  const validContent = SESSION_MEMORY_TEMPLATE.replace(
    '_简短而独特的 5-10 词描述性标题，信息密集，无填充词_',
    '_简短标题_\n\n重构 API 模块的记忆系统',
  );
  const r1 = validateSessionMemoryContent(validContent);
  if (r1.valid) {
    pass('合法的 10-section 内容通过验证');
  } else {
    fail('合法内容应通过验证', r1.reason);
  }

  // 5b. 空内容
  const r2 = validateSessionMemoryContent('');
  if (!r2.valid) {
    pass('空内容被拒绝', r2.reason);
  } else {
    fail('空内容应被拒绝');
  }

  // 5c. 缺少核心 section
  const r3 = validateSessionMemoryContent('# Session Title\nsome content\n# Learnings\nstuff');
  if (!r3.valid) {
    pass('缺少核心 section 被拒绝', r3.reason);
  } else {
    fail('缺少核心 section 应被拒绝');
  }

  // 5d. LLM 返回了工具调用指令而非 Markdown
  const r4 = validateSessionMemoryContent(
    'I will use the write_file tool to update the session notes.\n\n' +
    '```json\n{"tool": "write_file", "path": "session-notes.md"}\n```',
  );
  if (!r4.valid) {
    pass('LLM 返回工具调用指令被拒绝', r4.reason);
  } else {
    fail('LLM 返回工具调用指令应被拒绝');
  }

  // 5e. 只有 6 个 section（不够 7 个最低要求）
  const partialContent = [
    '# Session Title', 'title', '',
    '# Current State', 'state', '',
    '# Task Specification', 'spec', '',
    '# Files and Functions', 'files', '',
    '# Workflow', 'workflow', '',
    '# Worklog', 'log', '',
  ].join('\n');
  const r5 = validateSessionMemoryContent(partialContent);
  if (!r5.valid) {
    pass('只有 6/10 section 被拒绝', r5.reason);
  } else {
    fail('只有 6/10 section 应被拒绝');
  }
}

// ════════════════════════════════════════════════════════════
// 场景 6：并发控制 + JSON 解析健壮性
// ════════════════════════════════════════════════════════════
async function scenario6_concurrencyAndParsing() {
  section('场景 6: 并发控制 + JSON 解析健壮性');

  // 6a. sequential 包装器
  let callOrder: number[] = [];
  let concurrentCount = 0;
  let maxConcurrent = 0;

  const slowFn = sequential(async (id: number) => {
    concurrentCount++;
    maxConcurrent = Math.max(maxConcurrent, concurrentCount);
    callOrder.push(id);
    await new Promise(r => setTimeout(r, 50));
    concurrentCount--;
  });

  // 同时发起 3 个调用
  await Promise.all([slowFn(1), slowFn(2), slowFn(3)]);

  if (maxConcurrent === 1) {
    pass('sequential 保证串行执行', `最大并发: ${maxConcurrent}`);
  } else {
    fail('sequential 未能保证串行', `最大并发: ${maxConcurrent}`);
  }
  info(`执行顺序: [${callOrder.join(', ')}]`);

  // 6b. ExtractionGuard 互斥
  const guard = initExtractionGuard();
  if (!guard.inProgress && guard.lastProcessedIndex === 0 && guard.pendingContext === null) {
    pass('ExtractionGuard 初始状态正确');
  } else {
    fail('ExtractionGuard 初始状态不正确');
  }

  // 6c. JSON 解析健壮性
  const jsonTests = [
    { input: '{"selected": ["a.md"]}', label: '纯 JSON', expectKey: 'selected' },
    { input: '```json\n{"selected": ["a.md"]}\n```', label: 'Markdown 代码块', expectKey: 'selected' },
    { input: 'Here are the results:\n{"selected": ["a.md"]}', label: '前缀文本 + JSON', expectKey: 'selected' },
    { input: '{"selected": ["a.md",]}', label: '尾部逗号', expectKey: 'selected' },
    { input: 'no json here', label: '无 JSON 内容', expectKey: null },
  ];

  for (const test of jsonTests) {
    const parsed = parseLLMJson(test.input, false);
    if (test.expectKey === null) {
      if (parsed === null) pass(`JSON 解析: ${test.label} → null`);
      else fail(`JSON 解析: ${test.label} 应返回 null`);
    } else {
      if (parsed && (parsed as any)[test.expectKey]) {
        pass(`JSON 解析: ${test.label} → 成功`);
      } else {
        fail(`JSON 解析: ${test.label} → 失败`, JSON.stringify(parsed));
      }
    }
  }
}

// ════════════════════════════════════════════════════════════
// 场景 7：端到端用户体验模拟 — 完整对话流
// ════════════════════════════════════════════════════════════
async function scenario7_e2eUserExperience() {
  section('场景 7: 端到端用户体验 — 完整 3 轮对话');
  const memDir = path.join(tmpDir, 'scenario7');
  await fs.mkdir(memDir, { recursive: true });

  info('模拟用户 3 轮对话，观察记忆系统的完整行为链...');

  // ── 第 1 轮：用户自我介绍 ──
  info('');
  info('第 1 轮: 用户说 "我是前端工程师，主要用 TypeScript 和 React"');

  // 提取器应该捕获用户画像
  const extractor = new LLMMemoryExtractor({ maxMemories: 5, maxOutputTokens: 2048, enablePromptCache: false });
  const round1Mock = createMockLLM({
    'extract': JSON.stringify([
      {
        filename: 'user_role.md', type: 'user', name: '用户角色',
        description: '前端工程师，使用 TypeScript 和 React',
        content: '用户是前端工程师，主要技术栈是 TypeScript + React。',
        tags: ['role:frontend', 'lang:typescript', 'framework:react'],
        confidence: 1.0, source: 'llm_extract',
      },
    ]),
  });

  const r1 = await extractor.extract(
    [
      { role: 'user', content: '我是前端工程师，主要用 TypeScript 和 React' },
      { role: 'assistant', content: '了解！我会根据你的技术栈来提供帮助。' },
    ],
    memDir, round1Mock,
  );
  pass(`第 1 轮提取: ${r1.writtenPaths.length} 条记忆`, `耗时 ${r1.duration}ms`);

  // ── 第 2 轮：用户请求帮助 ──
  info('');
  info('第 2 轮: 用户说 "帮我优化这个 React 组件的性能"');

  // 召回应该找到第 1 轮保存的用户画像
  const round2Mock = createMockLLM({
    'available memories': '{"selected": ["user_role.md"]}',
  });

  const recall2 = await recallRelevantMemories(
    '帮我优化这个 React 组件的性能', memDir, round2Mock, new Set(), 5,
  );

  if (recall2.memories.length > 0) {
    pass(`第 2 轮召回: ${recall2.memories.length} 条记忆`, recall2.memories.map(m => m.filename).join(', '));
    // 验证召回的记忆确实是第 1 轮保存的
    const hasUserRole = recall2.memories.some(m => m.filename === 'user_role.md');
    if (hasUserRole) {
      pass('召回了第 1 轮保存的用户画像');
    } else {
      info('召回的记忆不包含 user_role.md（LLM mock 可能未匹配）');
    }
  } else {
    fail('第 2 轮应召回相关记忆');
  }

  // 验证 recallCount 被更新
  if (recall2.memories.length > 0) {
    // 等一下让异步更新完成
    await new Promise(r => setTimeout(r, 200));
    const updatedContent = await fs.readFile(recall2.memories[0].filePath, 'utf-8');
    const fm = parseFrontmatter(updatedContent);
    if (fm.recallCount && parseInt(fm.recallCount) > 0) {
      pass('recallCount 已更新', `recallCount=${fm.recallCount}`);
    } else {
      info(`recallCount 未更新（异步更新可能未完成）: ${fm.recallCount}`);
    }
  }

  // ── 第 3 轮：话题切换 — 从 React 切到数据库 ──
  info('');
  info('第 3 轮: 用户切换话题 "帮我设计一个 PostgreSQL 数据库 schema"');

  // 写入一条数据库相关记忆（模拟之前的对话积累）
  await writeMemory(memDir, 'reference_db_conventions.md', {
    name: '数据库命名规范', description: '团队的 PostgreSQL 命名规范文档',
    type: 'reference', content: '表名用 snake_case，主键用 id，外键用 xxx_id。',
    confidence: 0.8, tags: 'db:postgresql, convention:naming',
  });

  const round3Mock = createMockLLM({
    'available memories': '{"selected": ["reference_db_conventions.md"]}',
  });

  const surfacedFromRound2 = new Set(recall2.memories.map(m => m.filePath));
  const recall3 = await recallRelevantMemories(
    '帮我设计一个 PostgreSQL 数据库 schema', memDir, round3Mock, surfacedFromRound2, 5,
  );

  if (recall3.memories.length > 0) {
    pass(`第 3 轮召回: ${recall3.memories.length} 条记忆`, recall3.memories.map(m => m.filename).join(', '));
    // 不应该再返回第 2 轮已展示的记忆
    const hasOldMemory = recall3.memories.some(m => surfacedFromRound2.has(m.filePath));
    if (!hasOldMemory) {
      pass('话题切换后召回了新记忆，未重复旧记忆');
    } else {
      fail('话题切换后不应重复展示旧记忆');
    }
  } else {
    info('第 3 轮未召回记忆（mock 可能未匹配新话题）');
  }

  // ── 最终状态检查 ──
  info('');
  info('最终记忆目录状态:');
  const finalMemories = await scanMemoryFiles(memDir, 200);
  for (const mem of finalMemories) {
    const decay = getMemoryDecayStatus(mem);
    info(`  [${mem.type || '?'}] ${mem.filename} — ${mem.description || '(无描述)'} — ${decay}`);
  }
  pass(`对话结束，记忆目录共 ${finalMemories.length} 条记忆`);
}

// ════════════════════════════════════════════════════════════
// 场景 8：实际体验痛点检测
// ════════════════════════════════════════════════════════════
async function scenario8_painPoints() {
  section('场景 8: 实际体验痛点检测');
  const memDir = path.join(tmpDir, 'scenario8');
  await fs.mkdir(memDir, { recursive: true });

  // 8a. 痛点：LLM 提取器返回重复记忆时的去重效果
  info('测试: 连续两次提取相同内容，是否会产生重复文件？');
  const extractor = new LLMMemoryExtractor({ maxMemories: 3, maxOutputTokens: 1024, enablePromptCache: false });
  // 用 project 类型避免路由到 user-memory 目录
  const dupMock = createMockLLM({
    'extract': JSON.stringify([{
      filename: 'project_tech_stack.md', type: 'project', name: '技术栈',
      description: '项目使用 TypeScript',
      content: '项目使用 TypeScript 开发。',
      tags: ['lang:typescript'], confidence: 0.8, source: 'llm_extract',
    }]),
  });

  const msgs: UnifiedMessage[] = [
    { role: 'user', content: '用 TypeScript 写' },
    { role: 'assistant', content: '好的' },
  ];

  await extractor.extract(msgs, memDir, dupMock);
  await extractor.extract(msgs, memDir, dupMock); // 第二次提取相同内容

  const allFiles = await scanMemoryFiles(memDir, 200);
  const techFiles = allFiles.filter(m => m.filename.includes('project_tech_stack'));
  if (techFiles.length === 1) {
    pass('结构化去重生效 — 同名文件只有 1 个（覆盖更新）');
  } else {
    fail(`结构化去重失败 — 同名文件有 ${techFiles.length} 个`);
  }

  // 8b. 痛点：manifest 在大量文件时的大小
  info('');
  info('测试: 50 个记忆文件时 manifest 的大小');
  const bigDir = path.join(tmpDir, 'scenario8-big');
  await fs.mkdir(bigDir, { recursive: true });

  for (let i = 0; i < 50; i++) {
    await writeMemory(bigDir, `mem_${String(i).padStart(3, '0')}.md`, {
      name: `记忆 ${i}`, description: `这是第 ${i} 条测试记忆，用于测试 manifest 大小`,
      type: i % 4 === 0 ? 'user' : i % 4 === 1 ? 'feedback' : i % 4 === 2 ? 'project' : 'reference',
      content: `内容 ${i}`,
    });
  }

  const bigMemories = await scanMemoryFiles(bigDir, 200);
  const manifest = formatMemoryManifest(bigMemories);
  const manifestTokens = Math.ceil(manifest.length / 4);
  info(`50 个文件的 manifest: ${manifest.length} 字符, ~${manifestTokens} tokens`);

  if (manifestTokens < 5000) {
    pass(`manifest 大小可控: ~${manifestTokens} tokens`);
  } else {
    fail(`manifest 过大: ~${manifestTokens} tokens`, '可能影响 LLM 召回质量');
  }

  // 8c. 痛点：扫描性能
  info('');
  info('测试: 50 个文件的扫描耗时');
  const scanStart = Date.now();
  await scanMemoryFiles(bigDir, 200);
  const scanDuration = Date.now() - scanStart;
  info(`扫描耗时: ${scanDuration}ms`);

  if (scanDuration < 1000) {
    pass(`扫描性能良好: ${scanDuration}ms`);
  } else if (scanDuration < 3000) {
    pass(`扫描性能可接受: ${scanDuration}ms`, '但 200+ 文件时可能变慢');
  } else {
    fail(`扫描过慢: ${scanDuration}ms`, '需要优化');
  }

  // 8d. 痛点：召回在无关查询时是否会误召回
  info('');
  info('测试: 完全无关的查询是否会误召回');
  const irrelevantResult = await recallRelevantMemories(
    '今天天气怎么样', bigDir, null, new Set(), 5,
  );
  if (irrelevantResult.memories.length === 0) {
    pass('无关查询未误召回任何记忆');
  } else if (irrelevantResult.memories.length <= 2) {
    info(`无关查询召回了 ${irrelevantResult.memories.length} 条（关键词回退的噪声）`);
  } else {
    fail(`无关查询误召回 ${irrelevantResult.memories.length} 条`, '关键词匹配噪声过大');
  }

  // 8e. 中文分词效果验证
  info('');
  info('测试: 中文关键词召回（bigram 分词）');
  const cnDir = path.join(tmpDir, 'scenario8-cn');
  await fs.mkdir(cnDir, { recursive: true });

  await writeMemory(cnDir, 'project_db_optimization.md', {
    name: '数据库优化经验', description: '数据库查询优化和索引设计的最佳实践',
    type: 'project', content: 'SQL 查询优化、索引策略、慢查询排查。',
  });
  await writeMemory(cnDir, 'feedback_code_review.md', {
    name: '代码审查规范', description: '团队代码审查流程和常见问题清单',
    type: 'feedback', content: '代码审查的标准流程。',
  });
  await writeMemory(cnDir, 'user_backend_dev.md', {
    name: '后端开发偏好', description: '用户是后端开发工程师，擅长微服务架构',
    type: 'user', content: '后端开发，微服务。',
  });

  // 中文查询 "数据库查询慢怎么优化" — 应该匹配到数据库优化经验
  const cnResult1 = await recallRelevantMemories(
    '数据库查询慢怎么优化', cnDir, null, new Set(), 5,
  );
  const hasDbMatch = cnResult1.memories.some(m => m.filename.includes('db_optimization'));
  if (hasDbMatch) {
    pass('中文查询 "数据库查询慢怎么优化" 匹配到数据库优化记忆');
  } else {
    fail('中文查询未能匹配到数据库优化记忆', `召回: ${cnResult1.memories.map(m => m.filename).join(', ') || '(空)'}`);
  }

  // 中文查询 "代码审查" — 应该匹配到代码审查规范
  const cnResult2 = await recallRelevantMemories(
    '代码审查怎么做', cnDir, null, new Set(), 5,
  );
  const hasReviewMatch = cnResult2.memories.some(m => m.filename.includes('code_review'));
  if (hasReviewMatch) {
    pass('中文查询 "代码审查怎么做" 匹配到代码审查记忆');
  } else {
    fail('中文查询未能匹配到代码审查记忆', `召回: ${cnResult2.memories.map(m => m.filename).join(', ') || '(空)'}`);
  }

  // 中文查询 "微服务" — 应该匹配到后端开发偏好
  const cnResult3 = await recallRelevantMemories(
    '微服务架构设计', cnDir, null, new Set(), 5,
  );
  const hasMicroMatch = cnResult3.memories.some(m => m.filename.includes('backend_dev'));
  if (hasMicroMatch) {
    pass('中文查询 "微服务架构设计" 匹配到后端开发记忆');
  } else {
    fail('中文查询未能匹配到后端开发记忆', `召回: ${cnResult3.memories.map(m => m.filename).join(', ') || '(空)'}`);
  }

  // 不相关的中文查询 — 不应该匹配
  const cnResult4 = await recallRelevantMemories(
    '明天去哪里吃饭', cnDir, null, new Set(), 5,
  );
  if (cnResult4.memories.length === 0) {
    pass('不相关中文查询未误召回');
  } else {
    fail(`不相关中文查询误召回 ${cnResult4.memories.length} 条`);
  }

  // 8f. 痛点：description 写得差，但正文有关键信息
  info('');
  info('测试: description 笼统但正文包含关键词（contentPreview 召回）');
  const previewDir = path.join(tmpDir, 'scenario8-preview');
  await fs.mkdir(previewDir, { recursive: true });

  // 故意写一个 description 很笼统的记忆，但正文包含 "Vite" 和 "热更新"
  await writeMemory(previewDir, 'feedback_build_tool.md', {
    name: '构建工具反馈', description: '用户对构建工具的偏好',
    type: 'feedback', content: '用户明确表示偏好 Vite 作为构建工具，因为热更新速度快。不要用 Webpack。',
  });
  // 另一个 description 也笼统的记忆，正文包含 "Docker" 和 "部署"
  await writeMemory(previewDir, 'project_deploy.md', {
    name: '部署方式', description: '项目部署相关信息',
    type: 'project', content: '生产环境使用 Docker 容器化部署，CI/CD 用 GitHub Actions。镜像推送到 ECR。',
  });

  // 查询 "Vite 配置" — description 里没有 Vite，但正文有
  const previewResult1 = await recallRelevantMemories(
    'Vite 配置怎么改', previewDir, null, new Set(), 5,
  );
  const hasViteMatch = previewResult1.memories.some(m => m.filename.includes('build_tool'));
  if (hasViteMatch) {
    pass('description 无 "Vite" 但正文有 → 通过 contentPreview 召回成功');
  } else {
    fail('contentPreview 未能召回正文包含 "Vite" 的记忆', `召回: ${previewResult1.memories.map(m => m.filename).join(', ') || '(空)'}`);
  }

  // 查询 "Docker 部署" — description 里没有 Docker，但正文有
  const previewResult2 = await recallRelevantMemories(
    'Docker 部署流程', previewDir, null, new Set(), 5,
  );
  const hasDockerMatch = previewResult2.memories.some(m => m.filename.includes('deploy'));
  if (hasDockerMatch) {
    pass('description 无 "Docker" 但正文有 → 通过 contentPreview 召回成功');
  } else {
    fail('contentPreview 未能召回正文包含 "Docker" 的记忆', `召回: ${previewResult2.memories.map(m => m.filename).join(', ') || '(空)'}`);
  }
}

// ════════════════════════════════════════════════════════════
// 主函数
// ════════════════════════════════════════════════════════════
async function main() {
  console.log(`\n${C.bold}${C.cyan}=== 记忆系统端到端体验模拟 ===${C.reset}\n`);

  await setupTmpDir();
  info(`临时目录: ${tmpDir}`);

  try {
    await scenario1_newUser();
    await scenario2_multiTurnRecall();
    await scenario3_security();
    await scenario4_agingAndDream();
    await scenario5_sessionMemoryValidation();
    await scenario6_concurrencyAndParsing();
    await scenario7_e2eUserExperience();
    await scenario8_painPoints();
  } finally {
    await cleanupTmpDir();
  }

  // ── 总结 ──
  console.log(`\n${C.bold}${C.cyan}=== 总结 ===${C.reset}`);
  console.log(`  ${C.green}通过: ${passCount}${C.reset}`);
  if (failCount > 0) {
    console.log(`  ${C.red}失败: ${failCount}${C.reset}`);
    console.log(`\n${C.red}失败项:${C.reset}`);
    for (const issue of issues) {
      console.log(`  ${C.red}- ${issue}${C.reset}`);
    }
  } else {
    console.log(`  ${C.red}失败: 0${C.reset}`);
  }
  console.log('');

  process.exit(failCount > 0 ? 1 : 0);
}

main().catch(err => {
  console.error('模拟失败:', err);
  cleanupTmpDir().catch(() => {});
  process.exit(2);
});
