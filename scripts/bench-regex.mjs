const PATH_EXT_RE = /(?:^|[\s"'`(]|[/\\])[\w.-]+\.([a-z0-9]{1,8})\b/gi;
const BARE_FILE_RE = /\b([\w\u4e00-\u9fff.-]+)\.([a-z0-9]{1,8})\b/gi;

const inputs = [
  '帮我把 utils.ts 里的 foo 改成 bar',
  '分析 report.xlsx',
  '看看 app.ts 的导入',
  '分析一下这个 Excel',
  'a'.repeat(10000) + '.xlsx',
];

for (const text of inputs) {
  const t0 = Date.now();
  let m;
  PATH_EXT_RE.lastIndex = 0;
  while ((m = PATH_EXT_RE.exec(text)) !== null) {}
  BARE_FILE_RE.lastIndex = 0;
  while ((m = BARE_FILE_RE.exec(text)) !== null) {}
  console.log(`${Date.now() - t0}ms`, text.slice(0, 40));
}
