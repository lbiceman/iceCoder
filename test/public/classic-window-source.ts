import { readFileSync } from 'node:fs';

/**
 * 把 TS ESM + window 垫片还原成可被 Playwright addScriptTag / vm 执行的经典脚本。
 */
export function classicWindowSource(src: string): string {
  return src
    .replace(/^\/\/ @ts-nocheck\r?\n/, '')
    .replace(/^export const /gm, 'var ')
    .replace(/^export async function /gm, 'async function ')
    .replace(/^export function /gm, 'function ')
    .replace(/^export \{[\s\S]*?\};?\s*/gm, '');
}

export function readClassicWindowSource(filePath: string): string {
  return classicWindowSource(readFileSync(filePath, 'utf-8'));
}
