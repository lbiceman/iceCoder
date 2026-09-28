/**
 * Conservative ES6 pass: IIFE→arrow, method shorthand, includes/startsWith,
 * Object.assign(literal, …)→spread. Skips this/arguments/generators.
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

function containsThisOrArguments(fn, sf) {
  let found = false;
  function visit(node) {
    if (found) return;
    if (node !== fn && ts.isFunctionLike(node)) return;
    if (node.kind === ts.SyntaxKind.ThisKeyword) {
      found = true;
      return;
    }
    if (ts.isIdentifier(node) && node.text === 'arguments') {
      const p = node.parent;
      if (!p || !ts.isPropertyAccessExpression(p) || p.name !== node) {
        found = true;
        return;
      }
    }
    ts.forEachChild(node, visit);
  }
  visit(fn);
  return found;
}

function isIifeCall(node) {
  if (!ts.isCallExpression(node)) return false;
  let expr = node.expression;
  if (ts.isParenthesizedExpression(expr)) expr = expr.expression;
  return ts.isFunctionExpression(expr);
}

function getIifeFn(node) {
  let expr = node.expression;
  if (ts.isParenthesizedExpression(expr)) expr = expr.expression;
  return expr;
}

function paramsText(fn, sf) {
  const start = fn.parameters.pos;
  const end = fn.parameters.end;
  return sf.text.slice(start, end).trim();
}

function modernize(file) {
  const text = fs.readFileSync(file, 'utf8');
  const kind = file.endsWith('.js') ? ts.ScriptKind.JS : ts.ScriptKind.TS;
  const sf = ts.createSourceFile(file, text, ts.ScriptTarget.ES2022, true, kind);
  const replacements = [];

  function visit(node) {
    // IIFE function → arrow
    if (isIifeCall(node)) {
      const fn = getIifeFn(node);
      if (
        ts.isFunctionExpression(fn)
        && !fn.asteriskToken
        && !fn.name
        && !containsThisOrArguments(fn, sf)
      ) {
        const params = paramsText(fn, sf);
        const body = fn.body.getText(sf);
        const asyncKw = fn.modifiers?.some((m) => m.kind === ts.SyntaxKind.AsyncKeyword) ? 'async ' : '';
        const arrow = `${asyncKw}(${params}) => ${body}`;
        // Replace only the function expression, keep surrounding parens/call
        replacements.push({
          start: fn.getStart(sf),
          end: fn.end,
          text: arrow,
        });
      }
    }

    // Object.assign({ ... }, a, b) → { ...props, ...a, ...b }
    if (
      ts.isCallExpression(node)
      && ts.isPropertyAccessExpression(node.expression)
      && ts.isIdentifier(node.expression.expression)
      && node.expression.expression.text === 'Object'
      && node.expression.name.text === 'assign'
      && node.arguments.length >= 2
      && ts.isObjectLiteralExpression(node.arguments[0])
    ) {
      const first = node.arguments[0];
      const inner = first.properties.length
        ? first.properties.map((p) => p.getText(sf)).join(', ')
        : '';
      const spreads = node.arguments.slice(1).map((arg) => {
        const t = arg.getText(sf);
        return t.startsWith('...') ? t : `...${t}`;
      });
      const body = [inner, ...spreads].filter(Boolean).join(', ');
      replacements.push({
        start: node.getStart(sf),
        end: node.end,
        text: `{ ${body} }`,
      });
    }

    // indexOf → includes / startsWith
    if (
      ts.isBinaryExpression(node)
      && ts.isCallExpression(node.left)
      && ts.isPropertyAccessExpression(node.left.expression)
      && node.left.expression.name.text === 'indexOf'
      && node.left.arguments.length === 1
    ) {
      const recv = node.left.expression.expression.getText(sf);
      const arg = node.left.arguments[0].getText(sf);
      const op = node.operatorToken.kind;
      const rhs = node.right;
      const rhsText = rhs.getText(sf);
      const isZero = ts.isNumericLiteral(rhs) && rhsText === '0';
      const isNegOne = rhsText === '-1';
      const call = `${recv}.indexOf(${arg})`;

      if (isZero && (op === ts.SyntaxKind.EqualsEqualsEqualsToken || op === ts.SyntaxKind.EqualsEqualsToken)) {
        replacements.push({ start: node.getStart(sf), end: node.end, text: `${recv}.startsWith(${arg})` });
      } else if (isZero && (op === ts.SyntaxKind.ExclamationEqualsEqualsToken || op === ts.SyntaxKind.ExclamationEqualsToken)) {
        replacements.push({ start: node.getStart(sf), end: node.end, text: `!${recv}.startsWith(${arg})` });
      } else if (isNegOne && (op === ts.SyntaxKind.EqualsEqualsEqualsToken || op === ts.SyntaxKind.EqualsEqualsToken)) {
        replacements.push({ start: node.getStart(sf), end: node.end, text: `!${recv}.includes(${arg})` });
      } else if (isNegOne && (op === ts.SyntaxKind.ExclamationEqualsEqualsToken || op === ts.SyntaxKind.ExclamationEqualsToken)) {
        replacements.push({ start: node.getStart(sf), end: node.end, text: `${recv}.includes(${arg})` });
      } else if (isZero && (op === ts.SyntaxKind.LessThanToken)) {
        // indexOf(x) < 0 already handled below; indexOf < 0 is not zero
      } else if (op === ts.SyntaxKind.LessThanToken && rhsText === '0') {
        replacements.push({ start: node.getStart(sf), end: node.end, text: `!${recv}.includes(${arg})` });
      } else if (op === ts.SyntaxKind.GreaterThanEqualsToken && rhsText === '0') {
        replacements.push({ start: node.getStart(sf), end: node.end, text: `${recv}.includes(${arg})` });
      }
      void call;
    }

    // foo: function (...) { } → foo(...) { }
    if (
      ts.isPropertyAssignment(node)
      && ts.isIdentifier(node.name)
      && ts.isFunctionExpression(node.initializer)
      && !node.initializer.asteriskToken
      && !node.initializer.name
    ) {
      const fn = node.initializer;
      let usesArgs = false;
      function scan(n) {
        if (usesArgs) return;
        if (n !== fn && ts.isFunctionLike(n)) return;
        if (ts.isIdentifier(n) && n.text === 'arguments') usesArgs = true;
        ts.forEachChild(n, scan);
      }
      scan(fn);
      if (!usesArgs) {
        const asyncKw = fn.modifiers?.some((m) => m.kind === ts.SyntaxKind.AsyncKeyword) ? 'async ' : '';
        const params = paramsText(fn, sf);
        const body = fn.body.getText(sf);
        replacements.push({
          start: node.getStart(sf),
          end: node.end,
          text: `${asyncKw}${node.name.text}(${params}) ${body}`,
        });
      }
    }

    ts.forEachChild(node, visit);
  }

  visit(sf);
  if (!replacements.length) return 0;
  fs.writeFileSync(file, applyReplacements(text, replacements));
  return replacements.length;
}

let total = 0;
for (const file of walkDir(root)) {
  const n = modernize(file);
  if (n) {
    console.log(path.relative(root, file), n);
    total += n;
  }
}
console.log('replacements', total);
