// scripts/verify_memory_seed.cjs
// 单元测试：验证 scripts/seed_memory.cjs 的落盘行为
const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

let failed = 0;
function assert(cond, msg) {
  if (!cond) {
    console.error('FAIL:', msg);
    failed++;
  } else {
    console.log('PASS:', msg);
  }
}

// 1) 跑一次 seed 脚本，保证文件存在
execSync('node scripts/seed_memory.cjs', { stdio: 'inherit' });

const dir = path.join(process.cwd(), 'data', 'memory-files');
const f1 = path.join(dir, 'user_commit_style.md');
const f2 = path.join(dir, 'user_typescript_style.md');
const f3 = path.join(dir, 'MEMORY.md');

// 2) 文件存在
assert(fs.existsSync(f1), 'user_commit_style.md 存在');
assert(fs.existsSync(f2), 'user_typescript_style.md 存在');
assert(fs.existsSync(f3), 'MEMORY.md 存在');

// 3) 内容关键字段
const c1 = fs.readFileSync(f1, 'utf8');
assert(c1.includes('中文'), 'user_commit_style.md 含「中文」');
assert(c1.includes('50 字符') || c1.includes('不超过 50'), 'user_commit_style.md 含 50 字符约束');
assert(c1.includes('bullet'), 'user_commit_style.md 含 bullet 约束');
assert(c1.includes('memoryCategory: stable_preference'), 'user_commit_style.md 有正确 frontmatter');

const c2 = fs.readFileSync(f2, 'utf8');
assert(c2.includes('后端出身'), 'user_typescript_style.md 含「后端出身」');
assert(c2.includes('strict mode'), 'user_typescript_style.md 含 strict mode');
assert(c2.includes('`any`') || c2.includes('any'), 'user_typescript_style.md 含 any 不喜欢');

const c3 = fs.readFileSync(f3, 'utf8');
assert(c3.includes('user_commit_style.md'), 'MEMORY.md 索引含 user_commit_style.md');
assert(c3.includes('user_typescript_style.md'), 'MEMORY.md 索引含 user_typescript_style.md');

// 4) frontmatter 起止符
assert(c1.startsWith('---\n') && c1.includes('\n---\n'), 'user_commit_style.md frontmatter 完整');
assert(c2.startsWith('---\n') && c2.includes('\n---\n'), 'user_typescript_style.md frontmatter 完整');

if (failed > 0) {
  console.error(`\n${failed} assertions failed`);
  process.exit(1);
}
console.log('\nAll assertions passed.');
