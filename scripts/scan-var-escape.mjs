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

function containingBlock(node) {
  let cur = node.parent;
  while (cur) {
    if (
      ts.isBlock(cur) ||
      ts.isSourceFile(cur) ||
      ts.isFunctionLike(cur) ||
      ts.isModuleBlock(cur) ||
      ts.isCaseClause(cur) ||
      ts.isDefaultClause(cur)
    ) return cur;
    cur = cur.parent;
  }
  return null;
}

function isForDecl(list) {
  const p = list.parent;
  return p && (ts.isForStatement(p) || ts.isForInStatement(p) || ts.isForOfStatement(p)) && p.initializer === list;
}

const escapes = [];

for (const file of walk(root)) {
  const text = fs.readFileSync(file, 'utf8');
  const sf = ts.createSourceFile(file, text, ts.ScriptTarget.ES2022, true, file.endsWith('.js') ? ts.ScriptKind.JS : ts.ScriptKind.TS);

  const vars = [];
  function collect(node) {
    if (ts.isVariableDeclarationList(node)) {
      const isVar = !(node.flags & ts.NodeFlags.Let) && !(node.flags & ts.NodeFlags.Const);
      if (isVar && !isForDecl(node)) {
        for (const d of node.declarations) {
          if (ts.isIdentifier(d.name)) vars.push({ name: d.name.text, decl: d, list: node, block: containingBlock(node) });
        }
      }
    }
    ts.forEachChild(node, collect);
  }
  collect(sf);

  function visitIds(node) {
    if (ts.isIdentifier(node) && !ts.isBindingName(node.parent) || (ts.isIdentifier(node) && ts.isVariableDeclaration(node.parent) && node.parent.name !== node)) {
      // skip
    }
    if (ts.isIdentifier(node)) {
      const parent = node.parent;
      if (ts.isVariableDeclaration(parent) && parent.name === node) return;
      if (ts.isParameter(parent) && parent.name === node) return;
      if (ts.isFunctionDeclaration(parent) && parent.name === node) return;
      if (ts.isClassDeclaration(parent) && parent.name === node) return;
      const hit = vars.find((v) => v.name === node.text && v.decl.getStart(sf) < node.getStart(sf));
      if (hit && hit.block && !isNodeInside(hit.block, node) && containingBlock(node) !== hit.block) {
        // used outside declaring block
        const usedBlock = containingBlock(node);
        if (usedBlock !== hit.block && !isNodeInside(hit.block, node)) {
          escapes.push({
            file: path.relative(root, file),
            name: hit.name,
            declLine: sf.getLineAndCharacterOfPosition(hit.decl.getStart(sf)).line + 1,
            useLine: sf.getLineAndCharacterOfPosition(node.getStart(sf)).line + 1,
          });
        }
      }
    }
    ts.forEachChild(node, visitIds);
  }

  function isNodeInside(container, node) {
    return node.getStart(sf) >= container.getStart(sf) && node.getEnd() <= container.getEnd();
  }

  visitIds(sf);
}

const uniq = [];
const seen = new Set();
for (const e of escapes) {
  const k = `${e.file}:${e.name}:${e.declLine}:${e.useLine}`;
  if (seen.has(k)) continue;
  seen.add(k);
  uniq.push(e);
}
console.log('possible block-escape uses:', uniq.length);
for (const e of uniq.slice(0, 100)) {
  console.log(`  ${e.file} ${e.name} decl:${e.declLine} use:${e.useLine}`);
}
