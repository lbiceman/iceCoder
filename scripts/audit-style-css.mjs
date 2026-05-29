import fs from 'node:fs';
import path from 'node:path';

const root = path.resolve('src/public');
const css = fs.readFileSync(path.join(root, 'css/style.css'), 'utf8');

const srcFiles = [];
function walk(dir) {
  for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, ent.name);
    if (ent.isDirectory()) walk(p);
    else if (/\.(html|js)$/i.test(ent.name)) srcFiles.push(p);
  }
}
walk(root);
srcFiles.push(path.join(root, 'css/chat-execution-plan.css'));

let usage = '';
for (const f of srcFiles) usage += fs.readFileSync(f, 'utf8');

const cssClasses = new Set();
for (const m of css.matchAll(/\.([a-zA-Z_][\w-]*)/g)) {
  const c = m[1];
  if (['before', 'after', 'root', 'html', 'body'].includes(c)) continue;
  cssClasses.add(c);
}

const used = new Set();
const addTokens = (s) => s.split(/\s+/).filter(Boolean).forEach((t) => used.add(t));

for (const m of usage.matchAll(/class=["']([^"']+)["']/g)) addTokens(m[1]);
for (const m of usage.matchAll(/className\s*=\s*["']([^"']+)["']/g)) addTokens(m[1]);
for (const m of usage.matchAll(/className\s*=\s*`([^`]+)`/g)) {
  const inner = m[1].replace(/\$\{[^}]+\}/g, ' ');
  addTokens(inner);
}
for (const m of usage.matchAll(/classList\.(?:add|remove|toggle)\(\s*["']([^"']+)["']/g)) addTokens(m[1]);
for (const m of usage.matchAll(/className\s*=\s*['"][^'"]*['"]\s*\+\s*['"]([^'"]+)['"]/g)) addTokens(m[1]);
for (const m of usage.matchAll(/['"]([a-z][\w-]*)['"]/g)) {
  if (m[1].includes('-')) used.add(m[1]);
}

function isUsed(c) {
  if (used.has(c)) return true;
  if (usage.includes(c)) return true;
  const base = c.split('--')[0];
  if (base !== c && usage.includes(base)) return true;
  return false;
}

const unused = [...cssClasses].filter((c) => !isUsed(c)).sort();
const sections = css.split(/\n\/\* =====/).length;

console.log(JSON.stringify({
  lines: css.split('\n').length,
  sections: sections - 1,
  cssClassSelectors: cssClasses.size,
  likelyUnused: unused,
  likelyUnusedCount: unused.length,
}, null, 2));
