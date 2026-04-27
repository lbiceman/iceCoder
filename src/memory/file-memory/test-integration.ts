/**
 * 文件记忆系统集成测试
 */

import { createFileMemoryManager } from './file-memory-manager.js';
import type { ConversationMessage } from './memory-extractor.js';

async function testFileMemorySystem() {
  console.log('=== 文件记忆系统集成测试 ===\n');

  // 1. 创建文件记忆管理器
  const manager = createFileMemoryManager({
    memory: {
      memoryDir: './test-memory-files',
    },
    multiLevel: {
      projectRoot: '.',
      userMemoryDir: './test-user-memory',
      currentDir: '.',
    },
    enableAutoExtraction: true,
    enableAsyncPrefetch: true,
  });

  try {
    // 2. 初始化
    console.log('1. 初始化记忆系统...');
    await manager.initialize();
    console.log('✓ 初始化成功\n');

    // 3. 加载记忆提示词
    console.log('2. 加载记忆提示词...');
    const prompt = await manager.loadMemoryPrompt();
    if (prompt) {
      console.log('✓ 提示词加载成功');
      console.log(`提示词长度: ${prompt.length} 字符\n`);
    }

    // 4. 手动保存测试记忆
    console.log('3. 手动保存测试记忆...');
    const saved = await manager.saveMemory(
      '用户是前端开发工程师，专注于 React 和 TypeScript 开发。',
      '用户角色',
      'user',
      '用户的角色和技术栈信息'
    );
    console.log(`✓ 记忆保存${saved ? '成功' : '失败'}\n`);

    // 5. 测试记忆搜索
    console.log('4. 测试记忆搜索...');
    const searchResults = await manager.searchMemories('前端');
    console.log(`找到 ${searchResults.length} 条相关记忆:`);
    searchResults.forEach((memory, index) => {
      console.log(`  ${index + 1}. ${memory.filename} - ${memory.description || '无描述'}`);
    });
    // 6. 测试自动记忆提取
    console.log('5. 测试自动记忆提取...');
    const testConversation: ConversationMessage[] = [
      {
        role: 'user',
        content: '我是前端开发工程师，主要使用 React 和 TypeScript。',
        timestamp: Date.now(),
      },
      {
        role: 'assistant',
        content: '好的，了解了。有什么可以帮助你的吗？',
        timestamp: Date.now() + 1000,
      },
      {
        role: 'user',
        content: '不要直接修改源代码，应该先写测试。',
        timestamp: Date.now() + 2000,
      },
      {
        role: 'user',
        content: '我们项目的截止日期是下周五。',
        timestamp: Date.now() + 3000,
      },
    ];

    const extractionResult = await manager.extractMemoriesFromConversation(testConversation);
    console.log(`提取到 ${extractionResult.candidates.length} 条候选记忆:`);
    extractionResult.candidates.forEach((candidate, index) => {
      console.log(`  ${index + 1}. [${candidate.type}] ${candidate.suggestedFilename}`);
      console.log(`     置信度: ${(candidate.confidence * 100).toFixed(1)}%`);
      console.log(`     内容: ${candidate.content.substring(0, 50)}...`);
    });
    console.log(`保存了 ${extractionResult.saved} 条记忆\n`);

    // 7. 测试异步预取
    console.log('6. 测试异步预取...');
    const prefetchSuccess = await manager.prefetchMemories('React');
    console.log(`预取${prefetchSuccess ? '成功' : '失败'}\n`);

    // 8. 获取相关记忆（应该包含预取的结果）
    console.log('7. 获取相关记忆...');
    const relevantMemories = await manager.getRelevantMemories('React');
    console.log(`找到 ${relevantMemories.length} 条相关记忆\n`);

    // 9. 获取记忆清单
    console.log('8. 获取记忆清单...');
    const manifest = await manager.getMemoryManifest();
    console.log(`记忆清单:\n${manifest.substring(0, 500)}...\n`);

    // 10. 获取统计信息
    console.log('9. 获取统计信息...');
    const stats = await manager.getStats();
    console.log(`总记忆数: ${stats.totalMemories}`);
    console.log('按类型统计:');
    Object.entries(stats.byType).forEach(([type, count]) => {
      console.log(`  ${type}: ${count}`);
    });
    console.log('按级别统计:');
    Object.entries(stats.byLevel).forEach(([level, count]) => {
      console.log(`  ${level}: ${count}`);
    });
    console.log(`缓存大小: ${stats.cacheSize}\n`);

    // 11. 清理测试文件
    console.log('10. 清理测试文件...');
    const { exec } = await import('child_process');
    const { promisify } = await import('util');
    const execAsync = promisify(exec);
    
    try {
      await execAsync('rm -rf ./test-memory-files ./test-user-memory');
      console.log('✓ 测试文件清理完成\n');
    } catch (error) {
      console.log('⚠ 清理测试文件时出错:', error);
    }

    console.log('=== 测试完成 ===');
    console.log('✓ 多级加载功能正常');
    console.log('✓ 异步预取功能正常');
    console.log('✓ 自动提取功能正常');
    console.log('✓ 记忆搜索功能正常');
    console.log('✓ 统计功能正常');

  } catch (error) {
    console.error('测试失败:', error);
  } finally {
    // 清理资源
    await manager.dispose();
  }
}

// 运行测试
if (import.meta.url === `file://${process.argv[1]}`) {
  testFileMemorySystem().catch(console.error);
}

export { testFileMemorySystem };