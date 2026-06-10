// scripts/seed_memory.cjs
const fs = require('fs');
const path = require('path');

const dir = path.join(process.cwd(), 'data', 'memory-files');
fs.mkdirSync(dir, { recursive: true });

const files = {
  'user_commit_style.md': [
    '---',
    'name: User commit message style',
    'description: Git commit messages must be in Chinese, subject line under 50 chars, body as bullet points',
    'type: user',
    'memoryCategory: stable_preference',
    '---',
    '',
    'Git commit message conventions:',
    '- Language: 中文 (Chinese)',
    '- Subject line: 不超过 50 字符',
    '- Body: 使用 bullet point (markdown 列表)',
    ''
  ].join('\n'),
  'user_typescript_style.md': [
    '---',
    'name: User TypeScript preferences',
    'description: Backend developer, prefers TypeScript strict mode, dislikes any type',
    'type: user',
    'memoryCategory: stable_preference',
    '---',
    '',
    'User background and TypeScript preferences:',
    '- 后端出身 (backend developer)',
    '- TypeScript strict mode',
    '- 不喜欢 `any` 类型',
    ''
  ].join('\n'),
  'MEMORY.md': [
    '# MEMORY.md',
    '',
    '# project_instructions',
    '# 项目记忆',
    '',
    '## user memories',
    '- [User commit message style](user_commit_style.md) — Git commit 一律中文，subject 不超过 50 字，body 用 bullet',
    '- [User TypeScript preferences](user_typescript_style.md) — 后端出身，TypeScript strict mode，禁用 `any`',
    ''
  ].join('\n')
};

for (const [name, content] of Object.entries(files)) {
  const p = path.join(dir, name);
  fs.writeFileSync(p, content, 'utf8');
  const st = fs.statSync(p);
  console.log(`wrote ${p} (${st.size} bytes)`);
}
