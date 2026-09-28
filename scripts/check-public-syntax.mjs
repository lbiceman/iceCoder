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

let errors = 0;
for (const file of walk(root)) {
  const text = fs.readFileSync(file, 'utf8');
  const sf = ts.createSourceFile(file, text, ts.ScriptTarget.ES2022, true, file.endsWith('.js') ? ts.ScriptKind.JS : ts.ScriptKind.TS);
  const list = sf.parseDiagnostics || [];
  // createSourceFile doesn't populate parseDiagnostics on all versions; use transpile
  const out = ts.transpileModule(text, {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext },
    reportDiagnostics: true,
    fileName: file,
  });
  const diags = (out.diagnostics || []).filter((d) => d.category === ts.DiagnosticCategory.Error);
  if (diags.length) {
    console.log(path.relative(root, file));
    for (const d of diags.slice(0, 8)) {
      const msg = ts.flattenDiagnosticMessageText(d.messageText, '\n');
      const pos = d.start != null ? sf.getLineAndCharacterOfPosition(d.start) : null;
      console.log(' ', pos ? `${pos.line + 1}:${pos.character + 1}` : '?', msg);
      errors += 1;
    }
  }
}
console.log('error count', errors);
