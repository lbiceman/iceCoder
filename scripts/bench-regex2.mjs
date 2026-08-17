const PATH_EXT_RE = /(?:^|[\s"'`(]|[/\\])[\w.-]+\.([a-z0-9]{1,8})\b/gi;
const BARE_FILE_RE = /\b([\w\u4e00-\u9fff.-]+)\.([a-z0-9]{1,8})\b/gi;

function collectExtsFromMessage(text) {
  const exts = [];
  const pushExt = (ext) => {
    const e = ext.toLowerCase();
    if (!exts.includes(e)) exts.push(e);
  };
  let m;
  let i = 0;
  PATH_EXT_RE.lastIndex = 0;
  while ((m = PATH_EXT_RE.exec(text)) !== null) {
    if (++i > 100) {
      console.error('PATH_EXT_RE infinite loop at', PATH_EXT_RE.lastIndex, m);
      break;
    }
    pushExt(m[1]);
  }
  i = 0;
  BARE_FILE_RE.lastIndex = 0;
  while ((m = BARE_FILE_RE.exec(text)) !== null) {
    if (++i > 100) {
      console.error('BARE_FILE_RE infinite loop at', BARE_FILE_RE.lastIndex, m);
      break;
    }
    pushExt(m[2]);
  }
  return exts;
}

const inputs = [
  '帮我把 utils.ts 里的 foo 改成 bar',
  '分析 report.xlsx',
  '看看 app.ts 的导入',
  '分析一下这个 Excel',
];

for (const text of inputs) {
  console.log(JSON.stringify(text), '->', collectExtsFromMessage(text));
}
