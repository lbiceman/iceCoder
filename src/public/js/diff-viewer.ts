// @ts-nocheck
/**
 * Diff Viewer — Git 风格：左侧文档行号 + 红删 / 绿增逐行展示
 */

/* exported DiffViewer */
export const DiffViewer = (() => {

  const TOOL_PREFIX_RE = /^\[[^\]]+\]\n?/;
  /** 超大 diff：展示前 N 行 + 省略 + 后 N 行 */
  const PREVIEW_HEAD_LINES = 50;
  const PREVIEW_TAIL_LINES = 50;

  /**
   * 从工具输出中提取 unified diff 文本
   * @param {string} text
   * @returns {string|null}
   */
  function extractUnifiedDiff(text) {
    if (!text || typeof text !== 'string') return null;

    const cleaned = text.replace(TOOL_PREFIX_RE, '');

    const headerStart = cleaned.search(/^(?:diff --git |--- )/m);
    if (headerStart >= 0) {
      const slice = cleaned.slice(headerStart);
      if (/^@@\s/m.test(slice) || /^(?:\+(?!\+)|-(?!-))/m.test(slice)) return slice;
    }

    const hunkStart = cleaned.search(/^@@\s/m);
    if (hunkStart >= 0) {
      const hunkSlice = cleaned.slice(hunkStart);
      if (/^(?:\+(?!\+)|-(?!-))/m.test(hunkSlice)) return hunkSlice;
    }

    return null;
  }

  function looksLikeUnifiedDiffText(text) {
    return extractUnifiedDiff(text) != null;
  }

  /**
   * @typedef {{ type: string, content: string, lineNum: number|null }} DiffChange
   * @typedef {{ fileName: string, changes: DiffChange[] }} DiffFile
   */

  /**
   * @param {string} line
   * @returns {{ oldLine: number, newLine: number }|null}
   */
  function parseHunkHeader(line) {
    const m = line.match(/^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/);
    if (!m) return null;
    return { oldLine: parseInt(m[1], 10), newLine: parseInt(m[2], 10) };
  }

  /**
   * 解析 unified diff → 按文件分组，保留 add/del 行及文档行号
   * @param {string} text
   * @returns {DiffFile[]}
   */
  function parseChangesOnly(text) {
    if (!text || typeof text !== 'string') return [];

    const lines = text.split(/\r?\n/);
    const files = [];
    let current = null;
    let oldLine = 0;
    let newLine = 0;
    let inHunk = false;

    function ensureFile(name) {
      if (current && current.fileName === name) return current;
      current = { fileName: name, changes: [] };
      files.push(current);
      return current;
    }

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];

      if (line.startsWith('diff --git ')) {
        const gitMatch = line.match(/^diff --git a\/(.+?) b\/(.+)$/);
        if (gitMatch) {
          current = ensureFile(gitMatch[2]);
        }
        inHunk = false;
        continue;
      }

      if (line.startsWith('+++ ')) {
        const name = line.substring(4).replace(/^b\//, '').replace(/^a\//, '').trim();
        if (name !== '/dev/null') ensureFile(name);
        inHunk = false;
        continue;
      }

      if (line.startsWith('--- ') || line.startsWith('index ')) continue;
      if (line.startsWith('new file mode') || line.startsWith('deleted file mode')) continue;
      if (line.startsWith('similarity index') || line.startsWith('rename from')) continue;

      if (line.startsWith('@@')) {
        const header = parseHunkHeader(line);
        if (header) {
          oldLine = header.oldLine;
          newLine = header.newLine;
          inHunk = true;
        }
        continue;
      }

      if (!inHunk) continue;

      if (!current) {
        current = { fileName: '', changes: [] };
        files.push(current);
      }

      if (line.startsWith(' ')) {
        oldLine++;
        newLine++;
        continue;
      }

      if (line.startsWith('+') && !line.startsWith('+++')) {
        current.changes.push({ type: 'add', content: line.substring(1), lineNum: newLine });
        newLine++;
      } else if (line.startsWith('-') && !line.startsWith('---')) {
        current.changes.push({ type: 'del', content: line.substring(1), lineNum: oldLine });
        oldLine++;
      } else if (line.startsWith('\\')) {
        continue;
      }
    }

    return files.filter((f) =>  f.changes.length > 0).map((f) =>  ({ fileName: f.fileName, changes: interleaveChangeBlocks(f.changes) }));
  }

  /**
   * 连续 delete 块 + insert 块 → 逐行配对（红 / 绿交替）
   * @param {DiffChange[]} changes
   * @returns {DiffChange[]}
   */
  function interleaveChangeBlocks(changes) {
    const result = [];
    let i = 0;
    while (i < changes.length) {
      if (changes[i].type !== 'del' && changes[i].type !== 'add') {
        result.push(changes[i]);
        i++;
        continue;
      }
      const dels = [];
      while (i < changes.length && changes[i].type === 'del') {
        dels.push(changes[i]);
        i++;
      }
      const adds = [];
      while (i < changes.length && changes[i].type === 'add') {
        adds.push(changes[i]);
        i++;
      }
      if (dels.length > 0 && adds.length > 0) {
        const max = Math.max(dels.length, adds.length);
        for (let k = 0; k < max; k++) {
          if (k < dels.length) result.push(dels[k]);
          if (k < adds.length) result.push(adds[k]);
        }
      } else {
        for (let d = 0; d < dels.length; d++) result.push(dels[d]);
        for (let a = 0; a < adds.length; a++) result.push(adds[a]);
      }
    }
    return result;
  }

  function countFileChanges(file) {
    let add = 0;
    let del = 0;
    for (let i = 0; i < file.changes.length; i++) {
      if (file.changes[i].type === 'add') add++;
      else if (file.changes[i].type === 'del') del++;
    }
    return { add, del };
  }

  function createChangeRow(ch) {
    const row = document.createElement('div');
    row.className = `diff-change-row diff-change-${ch.type}`;

    const gutter = document.createElement('span');
    gutter.className = 'diff-line-gutter';
    gutter.textContent = ch.lineNum != null ? String(ch.lineNum) : '';
    row.appendChild(gutter);

    const sign = document.createElement('span');
    sign.className = 'diff-line-sign';
    sign.textContent = ch.type === 'add' ? '+' : '-';
    row.appendChild(sign);

    const code = document.createElement('span');
    code.className = 'diff-line-code';
    code.textContent = ch.content;
    row.appendChild(code);

    return row;
  }

  function createOmitRow(omittedCount) {
    const row = document.createElement('div');
    row.className = 'diff-change-omit';
    row.textContent = `… 省略 ${omittedCount} 行 …`;
    return row;
  }

  /**
   * 超大 diff 折叠为：前 N + 省略 + 后 N
   * @param {DiffChange[]} changes
   * @returns {Array<{ change?: DiffChange, omit?: boolean, omitted?: number }>}
   */
  function buildDisplayItems(changes) {
    const total = changes.length;
    const head = PREVIEW_HEAD_LINES;
    const tail = PREVIEW_TAIL_LINES;
    if (total <= head + tail) {
      const all = [];
      for (let i = 0; i < total; i++) all.push({ change: changes[i] });
      return all;
    }
    const items = [];
    for (let h = 0; h < head; h++) items.push({ change: changes[h] });
    items.push({ omit: true, omitted: total - head - tail });
    for (let t = total - tail; t < total; t++) items.push({ change: changes[t] });
    return items;
  }

  function appendChangeItemsToBody(body, changes) {
    const items = buildDisplayItems(changes);
    for (let di = 0; di < items.length; di++) {
      const item = items[di];
      if (item.omit) {
        body.appendChild(createOmitRow(item.omitted || 0));
      } else if (item.change) {
        body.appendChild(createChangeRow(item.change));
      }
    }
  }

  /**
   * Git 风格渲染
   * @param {DiffFile[]} files
   * @param {{ compact?: boolean }} opts
   * @returns {HTMLElement}
   */
  function render(files, opts) {
    opts = opts || {};
    const root = document.createElement('div');
    root.className = 'diff-changes' + (opts.compact ? ' compact' : '');

    for (let f = 0; f < files.length; f++) {
      const file = files[f];
      const stats = countFileChanges(file);
      const block = document.createElement('div');
      block.className = 'diff-file-block';

      const head = document.createElement('div');
      head.className = 'diff-file-head';

      const chevron = document.createElement('span');
      chevron.className = 'diff-file-chevron';
      chevron.textContent = '▸';
      head.appendChild(chevron);

      const nameEl = document.createElement('span');
      nameEl.className = 'diff-file-name';
      nameEl.textContent = file.fileName || '(unknown)';
      head.appendChild(nameEl);

      const statsEl = document.createElement('span');
      statsEl.className = 'diff-file-stats';
      if (stats.del > 0) {
        const delStat = document.createElement('span');
        delStat.className = 'diff-stat-del';
        delStat.textContent = `-${stats.del}`;
        statsEl.appendChild(delStat);
      }
      if (stats.add > 0) {
        const addStat = document.createElement('span');
        addStat.className = 'diff-stat-add';
        addStat.textContent = `+${stats.add}`;
        statsEl.appendChild(addStat);
      }
      head.appendChild(statsEl);

      const body = document.createElement('div');
      body.className = 'diff-file-body expanded';

      appendChangeItemsToBody(body, file.changes);

      head.addEventListener('click', () => {
        const open = body.classList.contains('expanded');
        if (open) {
          body.classList.remove('expanded');
          chevron.classList.remove('expanded');
        } else {
          body.classList.add('expanded');
          chevron.classList.add('expanded');
        }
      });

      if (opts.compact !== false) {
        chevron.classList.add('expanded');
      }

      block.appendChild(head);
      block.appendChild(body);
      root.appendChild(block);
    }

    return root;
  }

  /**
   * @param {string} rawText
   * @param {{ compact?: boolean }} opts
   * @returns {HTMLElement|null}
   */
  function renderFromText(rawText, opts) {
    const diffText = extractUnifiedDiff(rawText);
    if (!diffText) return null;

    const files = parseChangesOnly(diffText);
    if (files.length === 0) return null;
    return render(files, opts);
  }

  /** @deprecated 兼容旧调用 */
  function parse(text) {
    const files = parseChangesOnly(text);
    if (files.length === 0) return { fileName: '', hunks: [] };
    const f = files[0];
    return {
      fileName: f.fileName,
      hunks: [{ header: '', lines: f.changes.map((c) =>  ({
          type: c.type,
          oldNum: c.type === 'del' ? c.lineNum : null,
          newNum: c.type === 'add' ? c.lineNum : null,
          content: c.content,
        })) }],
    };
  }

  function countChanges(parsed) {
    let add = 0;
    let del = 0;
    const hunks = parsed.hunks || [];
    for (let h = 0; h < hunks.length; h++) {
      const lines = hunks[h].lines || [];
      for (let l = 0; l < lines.length; l++) {
        if (lines[l].type === 'add') add++;
        if (lines[l].type === 'del') del++;
      }
    }
    return { add, del };
  }

  return {
    extractUnifiedDiff,
    looksLikeUnifiedDiffText,
    parseChangesOnly,
    interleaveChangeBlocks,
    buildDisplayItems,
    parse,
    render,
    renderFromText,
    countChanges,
  };
})();

/** Vite 打包后由 main.js 以 module 导入，须显式挂到 window 供其它脚本使用 */
window.DiffViewer = DiffViewer;
