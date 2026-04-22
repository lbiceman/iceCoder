/**
 * 自动记忆提取服务。
 * 
 * 参考 Claude Code 的 extractMemories 服务：
 * 从对话中自动提取值得记住的信息，包括：
 * 1. 用户画像信息
 * 2. 行为反馈
 * 3. 项目上下文
 * 4. 外部引用
 * 
 * 使用规则和启发式方法识别潜在记忆
 */

import { promises as fs } from 'node:fs';
import path from 'node:path';
import type { FileMemoryType } from './types.js';

/**
 * 对话消息
 */
export interface ConversationMessage {
  role: 'user' | 'assistant' | 'system';
  content: string;
  timestamp?: number;
}

/**
 * 提取配置
 */
export interface ExtractionConfig {
  /** 启用用户画像提取 */
  enableUserExtraction: boolean;
  /** 启用反馈提取 */
  enableFeedbackExtraction: boolean;
  /** 启用项目上下文提取 */
  enableProjectExtraction: boolean;
  /** 启用外部引用提取 */
  enableReferenceExtraction: boolean;
  /** 最小内容长度 */
  minContentLength: number;
  /** 置信度阈值（0-1） */
  confidenceThreshold: number;
}

/**
 * 默认配置
 */
const DEFAULT_EXTRACTION_CONFIG: ExtractionConfig = {
  enableUserExtraction: true,
  enableFeedbackExtraction: true,
  enableProjectExtraction: true,
  enableReferenceExtraction: true,
  minContentLength: 20,
  confidenceThreshold: 0.7,
};

/**
 * 提取的候选记忆
 */
export interface CandidateMemory {
  /** 记忆内容 */
  content: string;
  /** 记忆类型 */
  type: FileMemoryType;
  /** 提取置信度（0-1） */
  confidence: number;
  /** 来源消息索引 */
  sourceIndex: number;
  /** 关键词/触发词 */
  keywords: string[];
  /** 建议的文件名 */
  suggestedFilename: string;
}

/**
 * 提取规则
 */
interface ExtractionRule {
  type: FileMemoryType;
  patterns: RegExp[];
  confidence: number;
  keywords: string[];
}

/**
 * 自动记忆提取器
 */
export class MemoryExtractor {
  private config: ExtractionConfig;
  private rules: ExtractionRule[];

  constructor(config?: Partial<ExtractionConfig>) {
    this.config = { ...DEFAULT_EXTRACTION_CONFIG, ...config };
    this.rules = this.buildExtractionRules();
  }

  /**
   * 构建提取规则
   */
  private buildExtractionRules(): ExtractionRule[] {
    const rules: ExtractionRule[] = [];

    // 用户画像规则
    if (this.config.enableUserExtraction) {
      rules.push({
        type: 'user',
        patterns: [
          /我是(?:一个|一名)?\s*([^,。.!?]+)/i,
          /我(?:的)?(?:角色|职位|工作|职业)(?:是)?\s*([^,。.!?]+)/i,
          /我(?:的)?(?:目标|目的|职责)(?:是)?\s*([^,。.!?]+)/i,
          /我(?:的)?(?:偏好|喜欢|习惯)(?:是)?\s*([^,。.!?]+)/i,
          /我(?:的)?(?:知识|技能|专长)(?:是)?\s*([^,。.!?]+)/i,
        ],
        confidence: 0.8,
        keywords: ['我是', '角色', '职位', '工作', '职业', '目标', '职责', '偏好', '知识', '技能'],
      });
    }

    // 反馈规则
    if (this.config.enableFeedbackExtraction) {
      rules.push({
        type: 'feedback',
        patterns: [
          /(?:不要|停止|别)(?:那样|这样|做[^,。.!?]+)/i,
          /(?:对|正确|完美|很好|不错|就是这样)(?:，|。|！|\?|$)/i,
          /(?:应该|建议|推荐)(?:[^,。.!?]*?(?:方式|方法|做法))[^,。.!?]*/i,
          /(?:下次|以后|未来)(?:[^,。.!?]*?(?:这样|那样|按照))[^,。.!?]*/i,
          /(?:错误|不对|有问题)(?:[^,。.!?]*?(?:应该|改为))[^,。.!?]*/i,
        ],
        confidence: 0.9,
        keywords: ['不要', '停止', '正确', '完美', '应该', '建议', '错误', '改为'],
      });
    }

    // 项目上下文规则
    if (this.config.enableProjectExtraction) {
      rules.push({
        type: 'project',
        patterns: [
          /(?:项目|任务|工作)(?:[^,。.!?]*?(?:目标|目的|计划))[^,。.!?]*/i,
          /(?:截止|期限|deadline)(?:[^,。.!?]*?(?:是|为))[^,。.!?]*/i,
          /(?:bug|问题|缺陷|故障)(?:[^,。.!?]*?(?:编号|ID|#))[^,。.!?]*/i,
          /(?:功能|特性|feature)(?:[^,。.!?]*?(?:开发|实现|完成))[^,。.!?]*/i,
          /(?:会议|讨论|沟通)(?:[^,。.!?]*?(?:决定|结论|结果))[^,。.!?]*/i,
        ],
        confidence: 0.7,
        keywords: ['项目', '任务', '目标', '计划', '截止', 'deadline', 'bug', '功能', '会议'],
      });
    }

    // 外部引用规则
    if (this.config.enableReferenceExtraction) {
      rules.push({
        type: 'reference',
        patterns: [
          /(?:参见|参考|查看|访问)(?:[^,。.!?]*?(?:链接|网址|URL))[^,。.!?]*/i,
          /(?:文档|手册|指南|wiki)(?:[^,。.!?]*?(?:地址|位置))[^,。.!?]*/i,
          /(?:系统|平台|工具)(?:[^,。.!?]*?(?:名称|账号|凭证))[^,。.!?]*/i,
          /(?:API|接口|端点)(?:[^,。.!?]*?(?:文档|说明))[^,。.!?]*/i,
          /(?:数据库|存储|仓库)(?:[^,。.!?]*?(?:连接|配置))[^,。.!?]*/i,
        ],
        confidence: 0.6,
        keywords: ['参见', '参考', '链接', 'URL', '文档', '系统', 'API', '数据库'],
      });
    }

    return rules;
  }

  /**
   * 从对话中提取候选记忆
   */
  extractFromConversation(
    messages: ConversationMessage[]
  ): CandidateMemory[] {
    const candidates: CandidateMemory[] = [];

    messages.forEach((message, index) => {
      // 只处理用户消息
      if (message.role !== 'user') return;

      const content = message.content;
      
      // 检查内容长度
      if (content.length < this.config.minContentLength) return;

      // 应用所有规则
      this.rules.forEach(rule => {
        rule.patterns.forEach(pattern => {
          const match = pattern.exec(content);
          if (match) {
            // 提取相关内容（使用匹配组或整个内容）
            const extractedContent = match[1] ? match[1].trim() : content.trim();
            
            if (extractedContent.length >= this.config.minContentLength) {
              candidates.push({
                content: extractedContent,
                type: rule.type,
                confidence: rule.confidence,
                sourceIndex: index,
                keywords: this.extractKeywords(extractedContent, rule.keywords),
                suggestedFilename: this.generateFilename(rule.type, extractedContent),
              });
            }
          }
        });
      });
    });

    // 去重和过滤
    return this.deduplicateAndFilter(candidates);
  }

  /**
   * 提取关键词
   */
  private extractKeywords(content: string, ruleKeywords: string[]): string[] {
    const keywords: Set<string> = new Set();
    const contentLower = content.toLowerCase();

    // 添加规则关键词中出现在内容里的
    ruleKeywords.forEach(keyword => {
      if (contentLower.includes(keyword.toLowerCase())) {
        keywords.add(keyword);
      }
    });

    // 提取其他可能的关键词（名词短语）
    const words = content.split(/\s+/);
    words.forEach(word => {
      if (word.length > 3 && /^[a-zA-Z\u4e00-\u9fa5]+$/.test(word)) {
        keywords.add(word);
      }
    });

    return Array.from(keywords).slice(0, 5); // 最多5个关键词
  }

  /**
   * 生成文件名
   */
  private generateFilename(type: FileMemoryType, content: string): string {
    const timestamp = new Date().toISOString().split('T')[0]; // YYYY-MM-DD
    const slug = content
      .toLowerCase()
      .replace(/[^\w\u4e00-\u9fa5\s-]/g, '')
      .replace(/\s+/g, '-')
      .substring(0, 30)
      .replace(/-+$/, '');

    return `${type}_${slug}_${timestamp}.md`;
  }

  /**
   * 去重和过滤候选记忆
   */
  private deduplicateAndFilter(candidates: CandidateMemory[]): CandidateMemory[] {
    const seen = new Set<string>();
    const filtered: CandidateMemory[] = [];

    candidates.forEach(candidate => {
      // 检查置信度
      if (candidate.confidence < this.config.confidenceThreshold) return;

      // 创建唯一标识
      const key = `${candidate.type}:${candidate.content.substring(0, 50)}`;

      if (!seen.has(key)) {
        seen.add(key);
        filtered.push(candidate);
      }
    });

    // 按置信度排序
    return filtered.sort((a, b) => b.confidence - a.confidence);
  }

  /**
   * 格式化记忆为Markdown
   */
  formatMemory(candidate: CandidateMemory): string {
    const name = candidate.suggestedFilename.replace('.md', '').replace(/_/g, ' ');
    const description = candidate.content.substring(0, 100) + (candidate.content.length > 100 ? '...' : '');

    return `---
name: ${name}
description: ${description}
type: ${candidate.type}
---

${candidate.content}

---
*提取时间: ${new Date().toISOString()}*
*置信度: ${(candidate.confidence * 100).toFixed(1)}%*
*关键词: ${candidate.keywords.join(', ')}*`;
  }

  /**
   * 批量格式化记忆
   */
  formatMemories(candidates: CandidateMemory[]): string[] {
    return candidates.map(candidate => this.formatMemory(candidate));
  }

  /**
   * 保存提取的记忆到文件
   */
  async saveMemories(
    candidates: CandidateMemory[],
    memoryDir: string
  ): Promise<{ saved: number; failed: number }> {
    let saved = 0;
    let failed = 0;

    await fs.mkdir(memoryDir, { recursive: true });

    for (const candidate of candidates) {
      try {
        const content = this.formatMemory(candidate);
        const filePath = path.join(memoryDir, candidate.suggestedFilename);
        
        await fs.writeFile(filePath, content, 'utf-8');
        saved++;
      } catch (error) {
        console.error(`[MemoryExtractor] Failed to save memory:`, error);
        failed++;
      }
    }

    return { saved, failed };
  }

  /**
   * 更新索引文件
   */
  async updateMemoryIndex(
    memoryDir: string,
    entrypointName: string = 'MEMORY.md'
  ): Promise<void> {
    try {
      const indexPath = path.join(memoryDir, entrypointName);
      let indexContent = '';

      try {
        indexContent = await fs.readFile(indexPath, 'utf-8');
      } catch {
        // 文件不存在，创建新索引
        indexContent = '# 记忆索引\n\n';
      }

      // 扫描记忆文件
      const files = await fs.readdir(memoryDir);
      const memoryFiles = files.filter(f => f.endsWith('.md') && f !== entrypointName);

      // 构建索引条目
      const indexEntries = memoryFiles.map(file => {
        const name = file.replace('.md', '').replace(/_/g, ' ');
        return `- [${name}](${file})`;
      });

      // 更新索引内容
      const newIndexContent = `# 记忆索引\n\n${indexEntries.join('\n')}\n\n---\n*最后更新: ${new Date().toISOString()}*\n*总记忆数: ${memoryFiles.length}*`;

      await fs.writeFile(indexPath, newIndexContent, 'utf-8');
    } catch (error) {
      console.error('[MemoryExtractor] Failed to update memory index:', error);
    }
  }

  /**
   * 设置配置
   */
  updateConfig(config: Partial<ExtractionConfig>): void {
    this.config = { ...this.config, ...config };
    this.rules = this.buildExtractionRules(); // 重新构建规则
  }

  /**
   * 获取当前配置
   */
  getConfig(): ExtractionConfig {
    return { ...this.config };
  }
}

/**
 * 创建记忆提取器实例
 */
export function createMemoryExtractor(
  config?: Partial<ExtractionConfig>
): MemoryExtractor {
  return new MemoryExtractor(config);
}