/**
 * 审计 Vite 生产构建是否遗漏前端静态资源。
 * 用法: node scripts/audit-web-bundle.mjs
 */
import fs from 'node:fs';
import path from 'node:path';

const root = path.resolve(import.meta.dirname, '..');
const jsDir = path.join(root, 'src/public/js');
const cssDir = path.join(root, 'src/public/css');
const distAssets = path.join(root, 'dist/public/assets');

function walkImports(name, seen) {
  if (seen.has(name)) return;
  seen.add(name);
  const p = path.join(jsDir, name);
  if (!fs.existsSync(p)) return;
  const src = fs.readFileSync(p, 'utf8');
  for (const m of src.matchAll(/import\s+[^'"]*['"]\.\/([^'"]+)['"]/g)) {
    walkImports(m[1], seen);
  }
}

const jsFiles = fs.readdirSync(jsDir).filter((f) => f.endsWith('.js'));
const reachable = new Set();
for (const m of fs.readFileSync(path.join(jsDir, 'main.js'), 'utf8').matchAll(/import\s+['"]\.\/([^'"]+)['"]/g)) {
  walkImports(m[1], reachable);
}
const unreachableJs = jsFiles.filter((f) => f !== 'main.js' && !reachable.has(f));

const jsBundle = fs.readdirSync(distAssets).find((f) => f.startsWith('index-') && f.endsWith('.js'));
const cssBundle = fs.readdirSync(distAssets).find((f) => f.startsWith('index-') && f.endsWith('.css'));
if (!jsBundle || !cssBundle) {
  console.error('FAIL: dist/public/assets 缺少 index-*.js 或 index-*.css，请先 npm run build:web');
  process.exit(1);
}

const jsContent = fs.readFileSync(path.join(distAssets, jsBundle), 'utf8');
const cssContent = fs.readFileSync(path.join(distAssets, cssBundle), 'utf8');

const requiredGlobals = [
  'window.Modal',
  'window.DiffViewer',
  'window.ChatUI',
  'window.ToolDisplayHistory',
  'window.BgTaskChip',
  'window.ToolTraceFormat',
  'window.AppRouter',
  'window.MemoryPage',
  'window.ChatPage',
];

const cssMarkers = [
  'tool-diff',
  'modal-overlay',
  'exec-plan',
  'diff-line',
];

console.log('=== JS 模块 ===');
console.log(`src/public/js 共 ${jsFiles.length} 个，main.js 可达 ${reachable.size} 个`);
console.log('未纳入主入口:', unreachableJs.length ? unreachableJs.join(', ') : '(无)');

console.log('\n=== JS bundle 全局对象 ===');
let failed = false;
for (const g of requiredGlobals) {
  const ok = jsContent.includes(g);
  console.log(`  ${g}: ${ok ? 'OK' : 'MISSING'}`);
  if (!ok) failed = true;
}

console.log('\n=== CSS bundle 关键样式 ===');
for (const m of cssMarkers) {
  const ok = cssContent.includes(m);
  console.log(`  ${m}: ${ok ? 'OK' : 'MISSING'}`);
  if (!ok) failed = true;
}

console.log('\n=== 其它 ===');
const faviconRoot = fs.existsSync(path.join(root, 'dist/public/favicon.svg'));
const faviconAssets = fs.readdirSync(distAssets).some((f) => f.includes('favicon'));
console.log(`  favicon.svg 在 dist/public 根目录: ${faviconRoot ? '有' : '无（/favicon.ico 回退可能失效，index.html 内链正常）'}`);
console.log(`  favicon 在 assets/: ${faviconAssets ? '有' : '无'}`);
console.log(`  pet-expressions-demo: 开发演示页， intentionally 不打包`);

if (failed) {
  console.error('\n审计 FAIL');
  process.exit(1);
}
console.log('\n审计 PASS — 主应用前端资源均已打进 bundle');
