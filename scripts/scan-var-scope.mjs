import fs from 'node:fs';
import path from 'node:path';
import ts from 'typescript';

const root = path.resolve('src/public/js');

function walk(dir, acc = []) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p, acc);
    else if (/\.(js|ts)$/.test(e.name) && !e.name.endsWith('.d.ts')) acc.push(p);
  }
  return acc;
}

function parentOf(node, pred) {
  let cur = node.parent;
  while (cur) {
    if (pred(cur)) return cur;
    cur = cur.parent;
  }
  return null;
}

const files = walk(root);
const redeclares = [];
const hoistUses = []; // used outside declaring block

for (const file of files) {
  const text = fs.readFileSync(file, 'utf8');
  const sf = ts.createSourceFile(file, text, ts.ScriptTarget.ES2022, true, file.endsWith('.js') ? ts.ScriptKind.JS : ts.ScriptKind.TS);

  const functionVars = new Map();

  function fnKey(node) {
    const fn = parentOf(node, (n) => ts.isFunctionLike(n) || ts.isSourceFile(n));
    return fn || sf;
  }

  function visit(node) {
    if (ts.isVariableDeclarationList(node)) {
      const isVar = !(node.flags & ts.NodeFlags.Let) && !(node.flags & ts.NodeFlags.Const);
      if (isVar) {
        const fn = fnKey(node);
        for (const d of node.declarations) {
          if (!d.name || !ts.isIdentifier(d.name)) continue;
          const name = d.name.text;
          const list = functionVars.get(fn) || [];
          list.push({ name, node: d, list: node });
          functionVars.set(fn, list);
        }
      }
    }
    ts.forEachChild(node, visit);
  }
  visit(sf);

  for (const [, decls] of functionVars) {
    const byName = new Map();
    for (const d of decls) {
      const arr = byName.get(d.name) || [];
      arr.push(d);
      byName.set(d.name, arr);
    }
    for (const [name, arr] of byName) {
      if (arr.length > 1) {
        redeclares.push({
          file: path.relative(root, file),
          name,
          count: arr.length,
          lines: arr.map((d) => sf.getLineAndCharacterOfPosition(d.node.getStart(sf)).line + 1),
        });
      }
    }
  }
}

console.log('redeclared var in same function:', redeclares.length);
for (const r of redeclares.slice(0, 80)) {
  console.log(`  ${r.file}:${r.name} x${r.count} lines ${r.lines.join(',')}`);
}
