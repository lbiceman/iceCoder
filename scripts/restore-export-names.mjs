import fs from 'node:fs';
import path from 'node:path';

const root = path.resolve('src/public/js');

function walk(dir, acc = []) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p, acc);
    else if (p.endsWith('.ts')) acc.push(p);
  }
  return acc;
}

for (const file of walk(root)) {
  let src = fs.readFileSync(file, 'utf8');
  if (!src.includes('export const  = (() => {')) continue;
  const names = [...src.matchAll(/window\.([A-Za-z][A-Za-z0-9]*) = \1;/g)].map((m) => m[1]);
  let name = names[0];
  if (file.endsWith('config-page.ts')) name = 'SettingsPage';
  if (!name) {
    console.error('NO NAME', file);
    continue;
  }
  src = src.replace('export const  = (() => {', `export const ${name} = (() => {`);
  fs.writeFileSync(file, src);
  console.log(path.relative(root, file), '->', name);
}
