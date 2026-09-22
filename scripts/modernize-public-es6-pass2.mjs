import fs from 'node:fs';
import path from 'node:path';
import ts from 'typescript';

const root = path.resolve('src/public/js');

function walkDir(dir, acc = []) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walkDir(p, acc);
    else if (/\.(js|ts)$/.test(e.name) && !e.name.endsWith('.d.ts')) acc.push(p);
  }
  return acc;
}

function applyReplacements(text, replacements) {
  replacements.sort((a, b) => b.start - a.start || (b.end - a.end));
  const used = [];
  let out = text;
  for (const r of replacements) {
    if (used.some((u) => r.start < u.end && r.end > u.start)) continue;
    out = out.slice(0, r.start) + r.text + out.slice(r.end);
    used.push({ start: r.start, end: r.end });
  }
  return out;
}

function plusChain(node, parts, sf) {
  if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.PlusToken) {
    return plusChain(node.left, parts, sf) && plusChain(node.right, parts, sf);
  }
  if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) {
    parts.push({ type: 'str', value: node.text });
    return true;
  }
  if (ts.isIdentifier(node) || ts.isPropertyAccessExpression(node) || ts.isCallExpression(node) || ts.isNumericLiteral(node)) {
    parts.push({ type: 'expr', value: node.getText(sf) });
    return true;
  }
  return false;
}

function toTemplate(parts) {
  if (parts.length < 2) return null;
  if (!parts.some((p) => p.type === 'str') || !parts.some((p) => p.type === 'expr')) return null;
  let out = '`';
  for (const p of parts) {
    if (p.type === 'str') out += p.value.replace(/\\/g, '\\\\').replace(/`/g, '\\`').replace(/\$\{/g, '\\${');
    else out += '${' + p.value + '}';
  }
  out += '`';
  return out;
}

function modernize(file) {
  const text = fs.readFileSync(file, 'utf8');
  const sf = ts.createSourceFile(file, text, ts.ScriptTarget.ES2022, true, file.endsWith('.js') ? ts.ScriptKind.JS : ts.ScriptKind.TS);
  const replacements = [];

  function visit(node) {
    if (
      ts.isArrowFunction(node)
      && ts.isBlock(node.body)
      && node.body.statements.length === 1
      && ts.isReturnStatement(node.body.statements[0])
      && node.body.statements[0].expression
    ) {
      const expr = node.body.statements[0].expression;
      let exprText = expr.getText(sf);
      if (ts.isObjectLiteralExpression(expr) || ts.isFunctionExpression(expr) || ts.isAssignmentExpression(expr)) {
        exprText = `(${exprText})`;
      }
      replacements.push({ start: node.body.getStart(sf), end: node.body.end, text: ` ${exprText}` });
    }

    if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.PlusToken) {
      const parent = node.parent;
      const alreadyPlus = parent && ts.isBinaryExpression(parent) && parent.operatorToken.kind === ts.SyntaxKind.PlusToken;
      if (!alreadyPlus) {
        const parts = [];
        if (plusChain(node, parts, sf)) {
          const tpl = toTemplate(parts);
          if (tpl) replacements.push({ start: node.getStart(sf), end: node.end, text: tpl });
        }
      }
    }

    ts.forEachChild(node, visit);
  }
  visit(sf);
  if (!replacements.length) return false;
  fs.writeFileSync(file, applyReplacements(text, replacements));
  return true;
}

let n = 0;
for (const f of walkDir(root)) {
  if (modernize(f)) {
    n += 1;
    console.log(path.relative(root, f));
  }
}
console.log('pass2', n);
