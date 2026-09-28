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

function containingFn(node) {
  let cur = node.parent;
  while (cur) {
    if (ts.isFunctionLike(cur) || ts.isSourceFile(cur)) return cur;
    cur = cur.parent;
  }
  return null;
}

function isAssignTarget(id) {
  const p = id.parent;
  if (!p) return false;
  if (ts.isPrefixUnaryExpression(p) || ts.isPostfixUnaryExpression(p)) {
    return p.operator === ts.SyntaxKind.PlusPlusToken || p.operator === ts.SyntaxKind.MinusMinusToken;
  }
  if (ts.isBinaryExpression(p) && p.left === id) {
    return p.operatorToken.kind !== ts.SyntaxKind.EqualsEqualsToken
      && p.operatorToken.kind !== ts.SyntaxKind.EqualsEqualsEqualsToken
      && p.operatorToken.kind !== ts.SyntaxKind.ExclamationEqualsToken
      && p.operatorToken.kind !== ts.SyntaxKind.ExclamationEqualsEqualsToken
      && [
        ts.SyntaxKind.EqualsToken,
        ts.SyntaxKind.PlusEqualsToken,
        ts.SyntaxKind.MinusEqualsToken,
        ts.SyntaxKind.AsteriskEqualsToken,
        ts.SyntaxKind.SlashEqualsToken,
        ts.SyntaxKind.PercentEqualsToken,
      ].includes(p.operatorToken.kind);
  }
  return false;
}

let hits = 0;
for (const file of walk(root)) {
  const text = fs.readFileSync(file, 'utf8');
  const sf = ts.createSourceFile(file, text, ts.ScriptTarget.ES2022, true, file.endsWith('.js') ? ts.ScriptKind.JS : ts.ScriptKind.TS);
  const consts = new Map();

  function visitDecl(node) {
    if (ts.isVariableDeclarationList(node) && (node.flags & ts.NodeFlags.Const)) {
      const fn = containingFn(node);
      for (const d of node.declarations) {
        if (ts.isIdentifier(d.name)) {
          const key = `${fn ? fn.pos : 0}:${d.name.text}`;
          consts.set(key, { name: d.name.text, fn, file, pos: d.getStart(sf) });
        }
      }
    }
    ts.forEachChild(node, visitDecl);
  }
  visitDecl(sf);

  function visitUse(node) {
    if (ts.isIdentifier(node) && isAssignTarget(node)) {
      const fn = containingFn(node);
      const key = `${fn ? fn.pos : 0}:${node.text}`;
      const decl = consts.get(key);
      if (decl && node.getStart(sf) !== decl.pos) {
        const loc = sf.getLineAndCharacterOfPosition(node.getStart(sf));
        console.log(`${path.relative(root, file)}:${loc.line + 1} reassign const ${node.text}`);
        hits += 1;
      }
    }
    ts.forEachChild(node, visitUse);
  }
  visitUse(sf);
}
console.log('hits', hits);
