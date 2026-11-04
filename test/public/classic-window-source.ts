import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * 把 TS ESM + window 垫片还原成可被 Playwright addScriptTag / vm 执行的经典脚本。
 * 页面从 i18n.ts 引入文案时，这里把语言模块内联进去，测试里默认仍是中文。
 */

const I18N_PATH = path.join(path.dirname(fileURLToPath(import.meta.url)), '../../src/public/js/i18n.ts');
const I18N_IMPORT_RE = /^import\s*\{([^}]+)\}\s*from\s*['"](?:\.\.\/)*\.\/i18n(?:\.ts)?['"];?\r?\n/m;

function stripModuleSyntax(src: string): string {
  return src
    .replace(/^\/\/ @ts-nocheck\r?\n/, '')
    .replace(/^export const /gm, 'var ')
    .replace(/^export async function /gm, 'async function ')
    .replace(/^export function /gm, 'function ')
    .replace(/^export \{[\s\S]*?\};?\s*/gm, '');
}

let i18nBody: string | null = null;

function i18nBundleBody(): string {
  if (!i18nBody) i18nBody = stripModuleSyntax(readFileSync(I18N_PATH, 'utf-8'));
  return i18nBody;
}

function i18nPrelude(names: string[]): string {
  const assigns = names.map((name) => `var ${name} = __iceI18n.${name};`).join('\n');
  return `var __iceI18n = (typeof window !== 'undefined' && window.__iceI18nBundle) || (function () {
  var bundle = (function () {
${i18nBundleBody()}
    return { t: t, getLocale: getLocale, setLocale: setLocale, intlLocale: intlLocale };
  })();
  if (typeof window !== 'undefined') window.__iceI18nBundle = bundle;
  return bundle;
})();
${assigns}
`;
}

export function classicWindowSource(src: string): string {
  const match = src.match(I18N_IMPORT_RE);
  let body = src;
  const names: string[] = [];
  if (match) {
    match[1].split(',').forEach((part) => {
      const name = part.trim();
      if (name) names.push(name);
    });
    body = body.replace(I18N_IMPORT_RE, '');
  }
  const out = stripModuleSyntax(body);
  if (!names.length) return out;
  return i18nPrelude(names) + out;
}

export function readClassicWindowSource(filePath: string): string {
  return classicWindowSource(readFileSync(filePath, 'utf-8'));
}
