import fs from 'node:fs';
import path from 'node:path';

const root = path.resolve('src/public/js');

function walk(dir, acc = []) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p, acc);
    else if (/\.(js|ts)$/.test(e.name) && !e.name.endsWith('.d.ts')) acc.push(p);
  }
  return acc;
}

function fix(src) {
  let out = src;
  out = out.replace(/\(\s*=>/g, '() =>');
  out = out.replace(/\(([A-Za-z_$][\w$]*)\s*=>/g, '($1) =>');
  out = out.replace(/\(([^()\n]+?),\s*([A-Za-z_$][\w$]*)\s*=>/g, '($1, $2) =>');
  return out;
}

let n = 0;
for (const file of walk(root)) {
  const src = fs.readFileSync(file, 'utf8');
  const next = fix(src);
  if (next !== src) {
    fs.writeFileSync(file, next);
    n += 1;
    console.log(path.relative(root, file));
  }
}
console.log('fixed', n, 'files');
