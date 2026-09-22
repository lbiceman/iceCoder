import { execSync } from 'node:child_process';
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

function gitShow(rel) {
  try {
    return execSync(`git show HEAD:${rel.replace(/\\/g, '/')}`, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  } catch {
    return null;
  }
}

const issues = [];

for (const file of walk(root)) {
  const rel = path.relative(process.cwd(), file).replace(/\\/g, '/');
  const now = fs.readFileSync(file, 'utf8');
  const oldRel = rel.replace(/\.ts$/, '.js');
  const old = gitShow(oldRel) || (rel.endsWith('.js') ? gitShow(rel) : null);
  if (!old) continue;

  const oldWindows = [...old.matchAll(/window\.([A-Za-z][A-Za-z0-9]*)\s*=/g)].map((m) => m[1]);
  const newWindows = [...now.matchAll(/window\.([A-Za-z][A-Za-z0-9]*)\s*=/g)].map((m) => m[1]);
  for (const name of new Set(oldWindows)) {
    if (!newWindows.includes(name) && !now.includes(`window.${name}`)) {
      issues.push(`${rel}: missing window.${name}`);
    }
  }

  const oldAssignMut = [...old.matchAll(/Object\.assign\(\s*([A-Za-z_$][\w$]*)\s*,/g)].map((m) => m[1]);
  for (const target of oldAssignMut) {
    if (target === 'Object') continue;
    if (!now.includes(`Object.assign(${target}`) && !now.includes(`Object.assign(${target},`)) {
      // might have become spread onto new object
      if (!now.includes(`...${target}`)) {
        issues.push(`${rel}: Object.assign mutation on ${target} may be gone`);
      }
    }
  }

  const oldIndexZero = [...old.matchAll(/([^\n;]+)\.indexOf\(([^)]+)\)\s*===\s*0/g)];
  for (const m of oldIndexZero) {
    const recv = m[1].trim();
    if (/\[|length|Ids|markers|steps|LEVELS|items|list|arr/i.test(recv) && now.includes('.startsWith(')) {
      issues.push(`${rel}: possible array indexOf===0 -> startsWith  recv=${recv.slice(-40)}`);
    }
  }
}

// const without init / reassignment scan
for (const file of walk(root)) {
  const rel = path.relative(process.cwd(), file).replace(/\\/g, '/');
  const now = fs.readFileSync(file, 'utf8');
  const lines = now.split(/\n/);
  for (let i = 0; i < lines.length; i++) {
    if (/^\s*const \w+;/.test(lines[i])) issues.push(`${rel}:${i + 1}: const without initializer`);
    if (/export const  =/.test(lines[i])) issues.push(`${rel}:${i + 1}: empty export name`);
    if (/\( =>/.test(lines[i])) issues.push(`${rel}:${i + 1}: broken arrow`);
  }
}

// window shim vs export name
for (const file of walk(root)) {
  if (!file.endsWith('.ts')) continue;
  const rel = path.relative(process.cwd(), file).replace(/\\/g, '/');
  const now = fs.readFileSync(file, 'utf8');
  const exp = now.match(/^export const ([A-Za-z][A-Za-z0-9]*) = \(\(\) =>/m);
  const win = now.match(/window\.([A-Za-z][A-Za-z0-9]*) = \1;/);
  if (exp && win && exp[1] !== win[1]) {
    issues.push(`${rel}: export ${exp[1]} vs window.${win[1]}`);
  }
  if (exp && now.includes(`window.${exp[1]} = ${exp[1]}`) === false) {
    const alias = now.match(/window\.([A-Za-z][A-Za-z0-9]*) = /);
    if (!alias) issues.push(`${rel}: export ${exp[1]} has no window shim`);
  }
}

console.log(issues.length ? issues.join('\n') : 'no issues');
