/**
 * Modernize src/public/js: var → let/const, drop 'use strict',
 * object shorthand, safe arrows, includes/startsWith, Object.assign spread.
 */
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

function isVarList(node) {
  return ts.isVariableDeclarationList(node)
    && !(node.flags & ts.NodeFlags.Let)
    && !(node.flags & ts.NodeFlags.Const);
}

function containingFunction(node) {
  let cur = node.parent;
  while (cur) {
    if (ts.isFunctionLike(cur)) return cur;
    if (ts.isSourceFile(cur)) return cur;
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
    const k = p.operatorToken.kind;
    return k === ts.SyntaxKind.EqualsToken
      || k === ts.SyntaxKind.PlusEqualsToken
      || k === ts.SyntaxKind.MinusEqualsToken
      || k === ts.SyntaxKind.AsteriskEqualsToken
      || k === ts.SyntaxKind.SlashEqualsToken
      || k === ts.SyntaxKind.PercentEqualsToken
      || k === ts.SyntaxKind.AmpersandEqualsToken
      || k === ts.SyntaxKind.BarEqualsToken
      || k === ts.SyntaxKind.CaretEqualsToken
      || k === ts.SyntaxKind.LessThanLessThanEqualsToken
      || k === ts.SyntaxKind.GreaterThanGreaterThanEqualsToken
      || k === ts.SyntaxKind.GreaterThanGreaterThanGreaterThanEqualsToken
      || k === ts.SyntaxKind.AsteriskAsteriskEqualsToken
      || k === ts.SyntaxKind.AmpersandAmpersandEqualsToken
      || k === ts.SyntaxKind.BarBarEqualsToken
      || k === ts.SyntaxKind.QuestionQuestionEqualsToken;
  }
  if (ts.isForInStatement(p) || ts.isForOfStatement(p)) return false;
  return false;
}

function shadowsName(fn, name) {
  if (!fn || !fn.parameters) return false;
  return fn.parameters.some((p) => ts.isIdentifier(p.name) && p.name.text === name);
}

function isReassigned(decl, name, fn, sf) {
  const forParent = decl.parent && decl.parent.parent;
  if (forParent && ts.isForStatement(forParent) && forParent.initializer === decl.parent) {
    return true;
  }
  let found = false;
  const declPos = decl.getStart(sf);
  function visit(node) {
    if (found) return;
    if (node !== fn && ts.isFunctionLike(node)) {
      if (shadowsName(node, name)) return;
      let innerDeclares = false;
      node.parameters?.forEach((p) => {
        if (ts.isIdentifier(p.name) && p.name.text === name) innerDeclares = true;
      });
      const body = node.body;
      if (body) {
        const check = (n) => {
          if (ts.isVariableDeclaration(n) && ts.isIdentifier(n.name) && n.name.text === name) {
            innerDeclares = true;
          }
          ts.forEachChild(n, check);
        };
        check(body);
      }
      if (innerDeclares) return;
    }
    if (ts.isIdentifier(node) && node.text === name && node.getStart(sf) !== declPos) {
      if (isAssignTarget(node)) found = true;
    }
    ts.forEachChild(node, visit);
  }
  visit(fn);
  return found;
}

function usesThisOrArguments(fn) {
  let used = false;
  function visit(node) {
    if (used) return;
    if (node !== fn && ts.isFunctionLike(node) && !ts.isArrowFunction(node)) return;
    if (node.kind === ts.SyntaxKind.ThisKeyword) used = true;
    if (ts.isIdentifier(node) && node.text === 'arguments') used = true;
    ts.forEachChild(node, visit);
  }
  if (fn.body) visit(fn.body);
  return used;
}

function applyReplacements(text, replacements) {
  replacements.sort((a, b) => b.start - a.start);
  let out = text;
  let last = Infinity;
  for (const r of replacements) {
    if (r.start >= last) continue;
    out = out.slice(0, r.start) + r.text + out.slice(r.end);
    last = r.start;
  }
  return out;
}

function modernize(file) {
  const text = fs.readFileSync(file, 'utf8');
  const kind = file.endsWith('.js') ? ts.ScriptKind.JS : ts.ScriptKind.TS;
  const sf = ts.createSourceFile(file, text, ts.ScriptTarget.ES2022, true, kind);
  const replacements = [];

  function add(start, end, next) {
    if (start < 0 || end <= start) return;
    if (text.slice(start, end) === next) return;
    replacements.push({ start, end, text: next });
  }

  function visit(node) {
    if (isVarList(node)) {
      const kwStart = node.getStart(sf);
      if (text.slice(kwStart, kwStart + 3) === 'var') {
        const fn = containingFunction(node) || sf;
        let reassigned = false;
        for (const d of node.declarations) {
          if (!ts.isIdentifier(d.name)) {
            reassigned = true;
            break;
          }
          if (isReassigned(d, d.name.text, fn, sf)) {
            reassigned = true;
            break;
          }
        }
        add(kwStart, kwStart + 3, reassigned ? 'let' : 'const');
      }
    }

    if (
      ts.isExpressionStatement(node)
      && ts.isStringLiteral(node.expression)
      && node.expression.text === 'use strict'
    ) {
      let start = node.getFullStart();
      let end = node.end;
      if (text[end] === '\r') end += 1;
      if (text[end] === '\n') end += 1;
      const lineStart = text.lastIndexOf('\n', node.getStart(sf) - 1) + 1;
      start = lineStart;
      add(start, end, '');
    }

    if (ts.isPropertyAssignment(node) && !node.name.getText(sf).includes('.') ) {
      if (ts.isIdentifier(node.name) && ts.isIdentifier(node.initializer) && node.name.text === node.initializer.text) {
        add(node.getStart(sf), node.end, node.name.text);
      }
    }

    if (
      ts.isFunctionExpression(node)
      && !node.name
      && !node.asteriskToken
      && node.parent
      && (ts.isCallExpression(node.parent) || ts.isNewExpression(node.parent))
      && !usesThisOrArguments(node)
    ) {
      const start = node.getStart(sf);
      if (text.slice(start, start + 8) === 'function') {
        const afterFn = start + 8;
        let i = afterFn;
        while (text[i] === ' ' || text[i] === '\n' || text[i] === '\r' || text[i] === '\t') i += 1;
        if (text[i] === '(') {
          const paramsEnd = node.parameters.end;
          let bodyStart = node.body.getStart(sf);
          add(start, i, '');
          add(paramsEnd, bodyStart, ' => ');
        }
      }
    }

    if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression)) {
      const obj = node.expression.expression;
      const method = node.expression.name.text;
      if (method === 'indexOf' && node.arguments.length === 1 && node.parent && ts.isBinaryExpression(node.parent) && node.parent.left === node) {
        const op = node.parent.operatorToken.kind;
        const right = node.parent.right;
        const fullStart = node.parent.getStart(sf);
        const fullEnd = node.parent.end;
        const objText = obj.getText(sf);
        const argText = node.arguments[0].getText(sf);
        if (ts.isStringLiteral(node.arguments[0]) && op === ts.SyntaxKind.EqualsEqualsEqualsToken && ts.isNumericLiteral(right) && right.text === '0') {
          add(fullStart, fullEnd, `${objText}.startsWith(${argText})`);
        } else if (
          (op === ts.SyntaxKind.GreaterThanEqualsToken && ts.isNumericLiteral(right) && right.text === '0')
          || (op === ts.SyntaxKind.ExclamationEqualsEqualsToken && ts.isPrefixUnaryExpression(right) === false && ts.isNumericLiteral(right) && right.text === '1' && text.slice(right.getStart(sf) - 1, right.getStart(sf)) === '-')
        ) {
          // !== -1 handled below
        }
        if (op === ts.SyntaxKind.GreaterThanEqualsToken && ts.isNumericLiteral(right) && right.text === '0') {
          add(fullStart, fullEnd, `${objText}.includes(${argText})`);
        }
        if (op === ts.SyntaxKind.ExclamationEqualsEqualsToken || op === ts.SyntaxKind.ExclamationEqualsToken) {
          if (ts.isPrefixUnaryExpression(right) && right.operator === ts.SyntaxKind.MinusToken && ts.isNumericLiteral(right.operand) && right.operand.text === '1') {
            add(fullStart, fullEnd, `${objText}.includes(${argText})`);
          }
        }
        if (op === ts.SyntaxKind.EqualsEqualsEqualsToken || op === ts.SyntaxKind.EqualsEqualsToken) {
          if (ts.isPrefixUnaryExpression(right) && right.operator === ts.SyntaxKind.MinusToken && ts.isNumericLiteral(right.operand) && right.operand.text === '1') {
            add(fullStart, fullEnd, `!${objText}.includes(${argText})`);
          }
        }
      }
    }

    if (
      ts.isCallExpression(node)
      && ts.isPropertyAccessExpression(node.expression)
      && ts.isIdentifier(node.expression.expression)
      && node.expression.expression.text === 'Object'
      && node.expression.name.text === 'assign'
      && node.arguments.length >= 2
      && ts.isObjectLiteralExpression(node.arguments[0])
      && node.arguments[0].properties.length === 0
    ) {
      const parts = node.arguments.slice(1).map((a) => `...${a.getText(sf)}`);
      add(node.getStart(sf), node.end, `{ ${parts.join(', ')} }`);
    }

    ts.forEachChild(node, visit);
  }

  visit(sf);

  if (!replacements.length) return { file, changed: false };
  const next = applyReplacements(text, replacements);
  fs.writeFileSync(file, next);
  return { file, changed: true, count: replacements.length };
}

const results = walkDir(root).map(modernize);
const changed = results.filter((r) => r.changed);
console.log(`updated ${changed.length} files`);
for (const r of changed) console.log(' ', path.relative(root, r.file), r.count);
