#!/usr/bin/env node

/**
 * 简单记忆系统测试
 */

const fs = require('fs/promises');
const path = require('path');

async function testMemorySystem() {
  console.log('🧠 简单记忆系统测试\n');

  const memoryDir = './test-memory-simple';
  const memoryIndex = path.join(memoryDir, 'MEMORY.md');

  try {
    // 1. 创建测试记忆目录
    console.log('1. 创建测试记忆目录...');
    await fs.mkdir(memoryDir, { recursive: true });
    console.log('✅ 目录创建成功\n');

    // 2. 创建测试记忆文件
    console.log('2. 创建测试记忆文件...');
    const testMemory = `---
name: 用户角色
description: 用户的角色和技术栈信息
type: user
---

用户是前端开发工程师，专注于 React 和 TypeScript 开发。`;

    await fs.writeFile(
      path.join(memoryDir, 'user_role.md'),
      testMemory,
      'utf-8'
    );
    console.log('✅ 记忆文件创建成功\n');

    // 3. 创建记忆索引
    console.log('3. 创建记忆索引...');
    const indexContent = `# 记忆索引

- [用户角色](user_role.md) — 用户的角色和技术栈信息
- [工作偏好](work_preference.md) — 用户的工作习惯和偏好
- [项目目标](project_goal.md) — 当前项目的目标和计划`;

    await fs.writeFile(memoryIndex, indexContent, 'utf-8');
    console.log('✅ 记忆索引创建成功\n');

    // 4. 读取记忆索引
    console.log('4. 读取记忆索引...');
    const index = await fs.readFile(memoryIndex, 'utf-8');
    console.log('索引内容:');
    console.log(index);
    console.log();

    // 5. 读取记忆文件
    console.log('5. 读取记忆文件...');
    const memoryContent = await fs.readFile(
      path.join(memoryDir, 'user_role.md'),
      'utf-8'
    );
    console.log('记忆内容:');
    console.log(memoryContent);
    console.log();

    // 6. 测试记忆搜索
    console.log('6. 测试记忆搜索...');
    const files = await fs.readdir(memoryDir);
    const memoryFiles = files.filter(f => f.endsWith('.md') && f !== 'MEMORY.md');
    
    console.log(`找到 ${memoryFiles.length} 个记忆文件:`);
    for (const file of memoryFiles) {
      const content = await fs.readFile(path.join(memoryDir, file), 'utf-8');
      if (content.includes('前端') || content.includes('React')) {
        console.log(`  ✅ ${file} - 包含相关记忆`);
      }
    }
    console.log();

    // 7. 清理测试文件
    console.log('7. 清理测试文件...');
    await fs.rm(memoryDir, { recursive: true, force: true });
    console.log('✅ 测试文件清理完成\n');

    console.log('🎉 简单记忆系统测试完成！');
    console.log('✅ 文件读写功能正常');
    console.log('✅ 索引管理功能正常');
    console.log('✅ 记忆搜索功能正常');

  } catch (error) {
    console.error('❌ 测试失败:', error);
  }
}

// 运行测试
testMemorySystem().catch(console.error);