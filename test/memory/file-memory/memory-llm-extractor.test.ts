/**
 * memory-llm-extractor 单元测试。
 *
 * P1 — Prompt cache 优化逻辑需验证。
 * 覆盖：提取响应解析、文件名清洗、路径安全、prompt cache 标记、保存逻辑。
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { randomUUID } from 'node:crypto';
import { createLLMMemoryExtractor, LLMMemoryExtractor, shouldRejectExtractedMemory } from '../../../src/memory/file-memory/memory-llm-extractor.js';
import type { LLMAdapterInterface, LLMResponse, UnifiedMessage } from '../../../src/llm/types.js';

let tempDir: string;
let userMemoryTempDir: string;

/** 满足 MIN_EXTRACTION_CONFIDENCE (0.6) 的测试用置信度 */
const TEST_CONFIDENCE = 0.75;

function createMockLLM(response: string, cacheReadTokens = 0): LLMAdapterInterface {
  return {
    chat: vi.fn(async () => ({
      content: response,
      usage: {
        inputTokens: 100,
        outputTokens: 50,
        totalTokens: 150,
        provider: 'test',
        cacheReadTokens,
      },
      finishReason: 'stop' as const,
    })),
    stream: vi.fn(async () => ({
      content: '',
      usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0, provider: 'test' },
      finishReason: 'stop' as const,
    })),
    countTokens: vi.fn(async () => 10),
  };
}

beforeEach(async () => {
  tempDir = path.join(os.tmpdir(), `extractor-test-${randomUUID()}`);
  userMemoryTempDir = path.join(os.tmpdir(), `extractor-user-mem-${randomUUID()}`);
  await fs.mkdir(tempDir, { recursive: true });
  await fs.mkdir(userMemoryTempDir, { recursive: true });
  process.env.ICE_USER_MEMORY_DIR = userMemoryTempDir;
});

afterEach(async () => {
  await fs.rm(tempDir, { recursive: true, force: true }).catch(() => {});
  await fs.rm(userMemoryTempDir, { recursive: true, force: true }).catch(() => {});
  delete process.env.ICE_USER_MEMORY_DIR;
});

describe('LLMMemoryExtractor', () => {
  describe('extract — 基本提取', () => {
    it('成功提取并保存记忆文件', async () => {
      const llmResponse = JSON.stringify([
        {
          memoryCategory: 'stable_preference',
          filename: 'user_role.md',
          type: 'user',
          name: '用户角色',
          description: '用户是前端开发者',
          content: '用户是一名前端开发者，偏好 React。',
          confidence: TEST_CONFIDENCE,
        },
      ]);

      const mockLLM = createMockLLM(llmResponse);
      const extractor = createLLMMemoryExtractor();

      const messages: UnifiedMessage[] = [
        { role: 'user', content: '我是前端开发者，主要用 React' },
        { role: 'assistant', content: '好的，我记住了。' },
      ];

      const result = await extractor.extract(messages, tempDir, mockLLM);

      expect(result.writtenPaths.length).toBe(1);
      expect(result.duration).toBeGreaterThanOrEqual(0);

      // 验证文件内容
      const content = await fs.readFile(result.writtenPaths[0], 'utf-8');
      expect(content).toContain('用户角色');
      expect(content).toContain('user');
      expect(content).toContain('memoryCategory: stable_preference');
      expect(content).toContain('前端开发者');
    });

    it('LLM 返回空数组时不写入文件', async () => {
      const mockLLM = createMockLLM('[]');
      const extractor = createLLMMemoryExtractor();

      const result = await extractor.extract(
        [{ role: 'user', content: '你好' }],
        tempDir,
        mockLLM,
      );

      expect(result.writtenPaths).toEqual([]);
    });

    it('LLM 失败时返回空结果不报错', async () => {
      const failingLLM: LLMAdapterInterface = {
        chat: vi.fn(async () => { throw new Error('API error'); }),
        stream: vi.fn(async () => { throw new Error('API error'); }),
        countTokens: vi.fn(async () => 0),
      };

      const extractor = createLLMMemoryExtractor();

      const result = await extractor.extract(
        [{ role: 'user', content: '测试' }],
        tempDir,
        failingLLM,
      );

      expect(result.writtenPaths).toEqual([]);
      expect(result.duration).toBeGreaterThanOrEqual(0);
    });
  });

  describe('extract — 响应解析', () => {
    it('过滤无效的记忆类型', async () => {
      const llmResponse = JSON.stringify([
        { memoryCategory: 'stable_preference', filename: 'valid.md', type: 'user', name: 'v', description: 'd', content: 'c', confidence: TEST_CONFIDENCE },
        { filename: 'invalid.md', type: 'unknown_type', name: 'i', description: 'd', content: 'c' },
      ]);

      const mockLLM = createMockLLM(llmResponse);
      const extractor = createLLMMemoryExtractor();

      const result = await extractor.extract(
        [{ role: 'user', content: '测试' }],
        tempDir,
        mockLLM,
      );

      expect(result.writtenPaths.length).toBe(1);
    });

    it('过滤缺少必要字段的记忆', async () => {
      const llmResponse = JSON.stringify([
        { filename: 'no_content.md', type: 'user', name: 'n', description: 'd' },
        { filename: 'no_name.md', type: 'user', description: 'd', content: 'c' },
        { type: 'user', name: 'n', description: 'd', content: 'c' },
      ]);

      const mockLLM = createMockLLM(llmResponse);
      const extractor = createLLMMemoryExtractor();

      const result = await extractor.extract(
        [{ role: 'user', content: '测试' }],
        tempDir,
        mockLLM,
      );

      expect(result.writtenPaths).toEqual([]);
    });

    it('限制最大提取数量', async () => {
      const memories = Array.from({ length: 10 }, (_, i) => ({
        memoryCategory: 'stable_preference',
        filename: `mem_${i}.md`,
        type: 'user',
        name: `记忆${i}`,
        description: `描述${i}`,
        content: `内容${i}`,
        confidence: TEST_CONFIDENCE,
      }));

      const mockLLM = createMockLLM(JSON.stringify(memories));
      const extractor = createLLMMemoryExtractor({ maxMemories: 3 });

      const result = await extractor.extract(
        [{ role: 'user', content: '测试' }],
        tempDir,
        mockLLM,
      );

      expect(result.writtenPaths.length).toBe(3);
    });

    it('解析 markdown 代码块包裹的 JSON', async () => {
      const llmResponse = '```json\n[{"memoryCategory":"stable_preference","filename":"note.md","type":"feedback","name":"n","description":"d","content":"c","confidence":0.75}]\n```';

      const mockLLM = createMockLLM(llmResponse);
      const extractor = createLLMMemoryExtractor();

      const result = await extractor.extract(
        [{ role: 'user', content: '测试' }],
        tempDir,
        mockLLM,
      );

      expect(result.writtenPaths.length).toBe(1);
    });

    it('缺少 memoryCategory 时不写入', async () => {
      const llmResponse = JSON.stringify([
        {
          filename: 'orphan.md',
          type: 'user',
          name: 'n',
          description: 'd',
          content: 'c',
        },
      ]);

      const mockLLM = createMockLLM(llmResponse);
      const extractor = createLLMMemoryExtractor();

      const result = await extractor.extract(
        [{ role: 'user', content: '测试' }],
        tempDir,
        mockLLM,
      );

      expect(result.writtenPaths).toEqual([]);
    });

    it('非法 memoryCategory 时不写入', async () => {
      const llmResponse = JSON.stringify([
        {
          memoryCategory: 'meta_dialogue',
          filename: 'bad.md',
          type: 'user',
          name: 'n',
          description: 'd',
          content: 'c',
        },
      ]);

      const mockLLM = createMockLLM(llmResponse);
      const extractor = createLLMMemoryExtractor();

      const result = await extractor.extract(
        [{ role: 'user', content: '测试' }],
        tempDir,
        mockLLM,
      );

      expect(result.writtenPaths).toEqual([]);
    });

    it('拦截含 model_identity 等垃圾文件名的条目', async () => {
      const llmResponse = JSON.stringify([
        {
          memoryCategory: 'stable_preference',
          filename: 'user_model_identity_foo.md',
          type: 'user',
          name: 'n',
          description: 'd',
          content: 'c',
        },
      ]);

      const mockLLM = createMockLLM(llmResponse);
      const extractor = createLLMMemoryExtractor();

      const result = await extractor.extract(
        [{ role: 'user', content: '测试' }],
        tempDir,
        mockLLM,
      );

      expect(result.writtenPaths).toEqual([]);
    });

    it('type=project 时必须 memoryCategory=project_convention', async () => {
      const llmResponse = JSON.stringify([
        {
          memoryCategory: 'stable_preference',
          filename: 'incoherent.md',
          type: 'project',
          name: 'n',
          description: 'd',
          content: 'c',
        },
      ]);

      const mockLLM = createMockLLM(llmResponse);
      const extractor = createLLMMemoryExtractor();

      const result = await extractor.extract(
        [{ role: 'user', content: '测试' }],
        tempDir,
        mockLLM,
      );

      expect(result.writtenPaths).toEqual([]);
    });

    it('memoryCategory=project_convention 时 type 须为 project', async () => {
      const llmResponse = JSON.stringify([
        {
          memoryCategory: 'project_convention',
          filename: 'incoherent2.md',
          type: 'user',
          name: 'n',
          description: 'd',
          content: 'c',
        },
      ]);

      const mockLLM = createMockLLM(llmResponse);
      const extractor = createLLMMemoryExtractor();

      const result = await extractor.extract(
        [{ role: 'user', content: '测试' }],
        tempDir,
        mockLLM,
      );

      expect(result.writtenPaths).toEqual([]);
    });

    it('空或仅空白的 description 不写入', async () => {
      const llmResponse = JSON.stringify([
        {
          memoryCategory: 'stable_preference',
          filename: 'nodesc.md',
          type: 'user',
          name: 'n',
          description: '  ',
          content: 'c',
        },
      ]);

      const mockLLM = createMockLLM(llmResponse);
      const extractor = createLLMMemoryExtractor();

      const result = await extractor.extract(
        [{ role: 'user', content: '测试' }],
        tempDir,
        mockLLM,
      );

      expect(result.writtenPaths).toEqual([]);
    });

    it('confidence 缺失或低于 0.6 时不写入', async () => {
      const llmResponse = JSON.stringify([
        {
          memoryCategory: 'stable_preference',
          filename: 'missing.md',
          type: 'user',
          name: 'n',
          description: 'd',
          content: 'c',
        },
        {
          memoryCategory: 'stable_preference',
          filename: 'low.md',
          type: 'user',
          name: 'n2',
          description: 'd2',
          content: 'c2',
          confidence: 0.55,
        },
        {
          memoryCategory: 'stable_preference',
          filename: 'ok.md',
          type: 'user',
          name: 'n3',
          description: 'd3',
          content: 'c3',
          confidence: TEST_CONFIDENCE,
        },
      ]);

      const mockLLM = createMockLLM(llmResponse);
      const extractor = createLLMMemoryExtractor();

      const result = await extractor.extract(
        [{ role: 'user', content: '测试' }],
        tempDir,
        mockLLM,
      );

      expect(result.writtenPaths.length).toBe(1);
      expect(path.basename(result.writtenPaths[0])).toBe('ok.md');
    });
  });

  describe('extract — 文件名安全', () => {
    it('清洗特殊字符', async () => {
      const llmResponse = JSON.stringify([
        {
          memoryCategory: 'stable_preference',
          filename: 'file<>:"/\\|?*.md',
          type: 'user',
          name: 'test',
          description: 'test',
          content: 'test',
          confidence: TEST_CONFIDENCE,
        },
      ]);

      const mockLLM = createMockLLM(llmResponse);
      const extractor = createLLMMemoryExtractor();

      const result = await extractor.extract(
        [{ role: 'user', content: '测试' }],
        tempDir,
        mockLLM,
      );

      // 应该成功写入（特殊字符被替换）
      expect(result.writtenPaths.length).toBe(1);
      // 文件名不应包含特殊字符
      const filename = path.basename(result.writtenPaths[0]);
      expect(filename).not.toMatch(/[<>:"/\\|?*]/);
    });

    it('拒绝路径遍历攻击', async () => {
      const llmResponse = JSON.stringify([
        {
          memoryCategory: 'project_convention',
          filename: '../../../etc/passwd',
          type: 'project',
          name: 'hack',
          description: 'hack',
          content: 'hack',
          confidence: TEST_CONFIDENCE,
        },
      ]);

      const mockLLM = createMockLLM(llmResponse);
      const extractor = createLLMMemoryExtractor();

      const result = await extractor.extract(
        [{ role: 'user', content: '测试' }],
        tempDir,
        mockLLM,
      );

      // 路径遍历应该被阻止
      // 不应该写到 tempDir 之外
      for (const p of result.writtenPaths) {
        expect(p.startsWith(tempDir)).toBe(true);
      }
    });
  });

  describe('extract — prompt cache', () => {
    it('有 conversationPrefix 时标记 usedPromptCache', async () => {
      const mockLLM = createMockLLM('[]');
      const extractor = createLLMMemoryExtractor({ enablePromptCache: true });

      const prefix: UnifiedMessage[] = [
        { role: 'user', content: '之前的对话' },
        { role: 'assistant', content: '之前的回复' },
      ];

      const result = await extractor.extract(
        [{ role: 'user', content: '新消息' }],
        tempDir,
        mockLLM,
        prefix,
      );

      expect(result.usedPromptCache).toBe(true);
    });

    it('无 conversationPrefix 时不标记 usedPromptCache', async () => {
      const mockLLM = createMockLLM('[]');
      const extractor = createLLMMemoryExtractor({ enablePromptCache: true });

      const result = await extractor.extract(
        [{ role: 'user', content: '新消息' }],
        tempDir,
        mockLLM,
      );

      expect(result.usedPromptCache).toBe(false);
    });

    it('检测提供商是否真正命中 cache', async () => {
      const mockLLMWithCache = createMockLLM('[]', 500); // cacheReadTokens = 500
      const extractor = createLLMMemoryExtractor({ enablePromptCache: true });

      const prefix: UnifiedMessage[] = [
        { role: 'user', content: '之前的对话' },
      ];

      const result = await extractor.extract(
        [{ role: 'user', content: '新消息' }],
        tempDir,
        mockLLMWithCache,
        prefix,
      );

      expect(result.cacheActuallyHit).toBe(true);
    });

    it('提供商未命中 cache 时 cacheActuallyHit 为 false', async () => {
      const mockLLMNoCache = createMockLLM('[]', 0); // cacheReadTokens = 0
      const extractor = createLLMMemoryExtractor({ enablePromptCache: true });

      const prefix: UnifiedMessage[] = [
        { role: 'user', content: '之前的对话' },
      ];

      const result = await extractor.extract(
        [{ role: 'user', content: '新消息' }],
        tempDir,
        mockLLMNoCache,
        prefix,
      );

      expect(result.cacheActuallyHit).toBe(false);
    });

    it('禁用 prompt cache 时即使有 prefix 也不使用', async () => {
      const mockLLM = createMockLLM('[]');
      const extractor = createLLMMemoryExtractor({ enablePromptCache: false });

      const prefix: UnifiedMessage[] = [
        { role: 'user', content: '之前的对话' },
      ];

      const result = await extractor.extract(
        [{ role: 'user', content: '新消息' }],
        tempDir,
        mockLLM,
        prefix,
      );

      expect(result.usedPromptCache).toBe(false);
    });
  });

  describe('extract — 已有记忆去重', () => {
    it('将已有记忆清单传给 LLM 避免重复', async () => {
      // 先写入一个已有记忆
      const existingContent = `---
name: existing
description: 已有的记忆
type: user
---
已有内容`;
      await fs.writeFile(path.join(tempDir, 'existing.md'), existingContent, 'utf-8');

      const mockLLM = createMockLLM('[]');
      const extractor = createLLMMemoryExtractor();

      await extractor.extract(
        [{ role: 'user', content: '测试' }],
        tempDir,
        mockLLM,
      );

      // 验证 LLM 收到的消息中包含已有记忆清单
      const chatCall = (mockLLM.chat as any).mock.calls[0];
      const messages = chatCall[0] as UnifiedMessage[];
      const userMsg = messages.find(m => m.role === 'user');
      expect(typeof userMsg?.content === 'string' && userMsg.content).toContain('existing.md');
    });
  });

  describe('updateConfig', () => {
    it('更新配置后生效', async () => {
      const extractor = createLLMMemoryExtractor({ maxMemories: 10 });

      extractor.updateConfig({ maxMemories: 1 });

      const memories = Array.from({ length: 5 }, (_, i) => ({
        memoryCategory: 'stable_preference',
        filename: `mem_${i}.md`,
        type: 'user',
        name: `n${i}`,
        description: `d${i}`,
        content: `c${i}`,
        confidence: TEST_CONFIDENCE,
      }));

      const mockLLM = createMockLLM(JSON.stringify(memories));

      const result = await extractor.extract(
        [{ role: 'user', content: '测试' }],
        tempDir,
        mockLLM,
      );

      expect(result.writtenPaths.length).toBe(1);
    });
  });

  describe('extract — 秘密扫描集成', () => {
    it('包含 API Key 的记忆内容被自动脱敏', async () => {
      const llmResponse = JSON.stringify([
        {
          memoryCategory: 'stable_preference',
          filename: 'api_ref.md',
          type: 'reference',
          name: 'API 配置',
          description: 'API 密钥信息',
          content: '用户的 AWS Key 是 AKIAIOSFODNN7EXAMPLE，用于访问 S3。',
          confidence: TEST_CONFIDENCE,
        },
      ]);

      const mockLLM = createMockLLM(llmResponse);
      const extractor = createLLMMemoryExtractor();

      const result = await extractor.extract(
        [{ role: 'user', content: '测试' }],
        tempDir,
        mockLLM,
      );

      expect(result.writtenPaths.length).toBe(1);

      // 读取写入的文件，验证 Key 已被脱敏
      const content = await fs.readFile(result.writtenPaths[0], 'utf-8');
      expect(content).not.toContain('AKIAIOSFODNN7EXAMPLE');
      expect(content).toContain('[REDACTED]');
    });

    it('包含 GitHub PAT 的记忆内容被自动脱敏', async () => {
      const fakePat = 'ghp_' + 'a'.repeat(36);
      const llmResponse = JSON.stringify([
        {
          memoryCategory: 'stable_preference',
          filename: 'github_ref.md',
          type: 'reference',
          name: 'GitHub',
          description: 'GitHub 访问信息',
          content: `GitHub token: ${fakePat}`,
          confidence: TEST_CONFIDENCE,
        },
      ]);

      const mockLLM = createMockLLM(llmResponse);
      const extractor = createLLMMemoryExtractor();

      const result = await extractor.extract(
        [{ role: 'user', content: '测试' }],
        tempDir,
        mockLLM,
      );

      const content = await fs.readFile(result.writtenPaths[0], 'utf-8');
      expect(content).not.toContain(fakePat);
      expect(content).toContain('[REDACTED]');
    });

    it('无秘密的记忆内容原样写入', async () => {
      const llmResponse = JSON.stringify([
        {
          memoryCategory: 'stable_preference',
          filename: 'safe.md',
          type: 'user',
          name: '安全内容',
          description: '无敏感信息',
          content: '用户偏好使用 TypeScript 和 React。',
          confidence: TEST_CONFIDENCE,
        },
      ]);

      const mockLLM = createMockLLM(llmResponse);
      const extractor = createLLMMemoryExtractor();

      const result = await extractor.extract(
        [{ role: 'user', content: '测试' }],
        tempDir,
        mockLLM,
      );

      const content = await fs.readFile(result.writtenPaths[0], 'utf-8');
      expect(content).toContain('TypeScript 和 React');
      expect(content).toContain('memoryCategory: stable_preference');
      expect(content).not.toContain('[REDACTED]');
    });
  });

  describe('shouldRejectExtractedMemory — 写盘拒绝', () => {
    it('拒绝 current-state 类文件名', () => {
      expect(
        shouldRejectExtractedMemory({
          memoryCategory: 'project_convention',
          filename: 'project_current-state.md',
          type: 'project',
          name: 'n',
          description: 'd',
          content: 'overview',
          confidence: 0.8,
        }),
      ).toBe('filename_pattern');
    });

    it('拒绝安装进度快照', () => {
      expect(
        shouldRejectExtractedMemory({
          memoryCategory: 'project_convention',
          filename: 'mysql_install.md',
          type: 'project',
          name: 'n',
          description: 'd',
          content: '安装到第 3/5 步，正在下载 45%',
          confidence: 0.8,
        }),
      ).toBe('install_progress_snapshot');
    });

    it('拒绝纯命令列表型 project', () => {
      expect(
        shouldRejectExtractedMemory({
          memoryCategory: 'project_convention',
          filename: 'cmds.md',
          type: 'project',
          name: 'n',
          description: 'd',
          content: '- npm install mysql\n- docker pull mysql\n- npm run dev',
          confidence: 0.8,
        }),
      ).toBe('command_list_project');
    });

    it('拒绝低置信推断 user 偏好', () => {
      expect(
        shouldRejectExtractedMemory({
          memoryCategory: 'stable_preference',
          filename: 'user_guess.md',
          type: 'user',
          name: 'n',
          description: 'd',
          content: '可能喜欢 React',
          confidence: 0.7,
        }),
      ).toBe('inferred_preference_low_confidence');
    });

    it('拒绝含日期的进度快照文件名', () => {
      expect(
        shouldRejectExtractedMemory({
          memoryCategory: 'project_convention',
          filename: 'project_current-state_2026-06-10.md',
          type: 'project',
          name: 'n',
          description: 'd',
          content: '安装进度',
          confidence: 0.8,
        }),
      ).toBe('filename_pattern');
    });

    it('允许普通带日期的 changelog 文件名', () => {
      expect(
        shouldRejectExtractedMemory({
          memoryCategory: 'project_convention',
          filename: 'release_notes_2026-06-10.md',
          type: 'project',
          name: 'n',
          description: 'd',
          content: '版本发布说明',
          confidence: 0.8,
        }),
      ).toBeNull();
    });
  });
});
