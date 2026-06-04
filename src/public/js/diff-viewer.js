/**
 * Diff Viewer — Git 风格：左侧文档行号 + 红删 / 绿增逐行展示
 */

/* exported DiffViewer */
var DiffViewer = (function () {
  'use strict';

  var TOOL_PREFIX_RE = /^\[[^\]]+\]\n?/;
  /** 超大 diff：展示前 N 行 + 省略 + 后 N 行 */
  var PREVIEW_HEAD_LINES = 50;
  var PREVIEW_TAIL_LINES = 50;

  /**
   * 从工具输出中提取 unified diff 文本
   * @param {string} text
   * @returns {string|null}
   */
  function extractUnifiedDiff(text) {
    if (!text || typeof text !== 'string') return null;

    var cleaned = text.replace(TOOL_PREFIX_RE, '');

    var headerStart = cleaned.search(/^(?:diff --git |--- )/m);
    if (headerStart >= 0) {
      var slice = cleaned.slice(headerStart);
      if (/^@@\s/m.test(slice) || /^(?:\+(?!\+)|-(?!-))/m.test(slice)) return slice;
    }

    var hunkStart = cleaned.search(/^@@\s/m);
    if (hunkStart >= 0) {
      var hunkSlice = cleaned.slice(hunkStart);
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
    var m = line.match(/^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/);
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

    var lines = text.split(/\r?\n/);
    var files = [];
    var current = null;
    var oldLine = 0;
    var newLine = 0;
    var inHunk = false;

    function ensureFile(name) {
      if (current && current.fileName === name) return current;
      current = { fileName: name, changes: [] };
      files.push(current);
      return current;
    }

    for (var i = 0; i < lines.length; i++) {
      var line = lines[i];

      if (line.startsWith('diff --git ')) {
        var gitMatch = line.match(/^diff --git a\/(.+?) b\/(.+)$/);
        if (gitMatch) {
          current = ensureFile(gitMatch[2]);
        }
        inHunk = false;
        continue;
      }

      if (line.startsWith('+++ ')) {
        var name = line.substring(4).replace(/^b\//, '').replace(/^a\//, '').trim();
        if (name !== '/dev/null') ensureFile(name);
        inHunk = false;
        continue;
      }

      if (line.startsWith('--- ') || line.startsWith('index ')) continue;
      if (line.startsWith('new file mode') || line.startsWith('deleted file mode')) continue;
      if (line.startsWith('similarity index') || line.startsWith('rename from')) continue;

      if (line.startsWith('@@')) {
        var header = parseHunkHeader(line);
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

    return files.filter(function (f) {
      return f.changes.length > 0;
    }).map(function (f) {
      return { fileName: f.fileName, changes: interleaveChangeBlocks(f.changes) };
    });
  }

  /**
   * 连续 delete 块 + insert 块 → 逐行配对（红 / 绿交替）
   * @param {DiffChange[]} changes
   * @returns {DiffChange[]}
   */
  function interleaveChangeBlocks(changes) {
    var result = [];
    var i = 0;
    while (i < changes.length) {
      if (changes[i].type !== 'del' && changes[i].type !== 'add') {
        result.push(changes[i]);
        i++;
        continue;
      }
      var dels = [];
      while (i < changes.length && changes[i].type === 'del') {
        dels.push(changes[i]);
        i++;
      }
      var adds = [];
      while (i < changes.length && changes[i].type === 'add') {
        adds.push(changes[i]);
        i++;
      }
      if (dels.length > 0 && adds.length > 0) {
        var max = Math.max(dels.length, adds.length);
        for (var k = 0; k < max; k++) {
          if (k < dels.length) result.push(dels[k]);
          if (k < adds.length) result.push(adds[k]);
        }
      } else {
        for (var d = 0; d < dels.length; d++) result.push(dels[d]);
        for (var a = 0; a < adds.length; a++) result.push(adds[a]);
      }
    }
    return result;
  }

  function countFileChanges(file) {
    var add = 0;
    var del = 0;
    for (var i = 0; i < file.changes.length; i++) {
      if (file.changes[i].type === 'add') add++;
      else if (file.changes[i].type === 'del') del++;
    }
    return { add: add, del: del };
  }

  function createChangeRow(ch) {
    var row = document.createElement('div');
    row.className = 'diff-change-row diff-change-' + ch.type;

    var gutter = document.createElement('span');
    gutter.className = 'diff-line-gutter';
    gutter.textContent = ch.lineNum != null ? String(ch.lineNum) : '';
    row.appendChild(gutter);

    var sign = document.createElement('span');
    sign.className = 'diff-line-sign';
    sign.textContent = ch.type === 'add' ? '+' : '-';
    row.appendChild(sign);

    var code = document.createElement('span');
    code.className = 'diff-line-code';
    code.textContent = ch.content;
    row.appendChild(code);

    return row;
  }

  function createOmitRow(omittedCount) {
    var row = document.createElement('div');
    row.className = 'diff-change-omit';
    row.textContent = '… 省略 ' + omittedCount + ' 行 …';
    return row;
  }

  /**
   * 超大 diff 折叠为：前 N + 省略 + 后 N
   * @param {DiffChange[]} changes
   * @returns {Array<{ change?: DiffChange, omit?: boolean, omitted?: number }>}
   */
  function buildDisplayItems(changes) {
    var total = changes.length;
    var head = PREVIEW_HEAD_LINES;
    var tail = PREVIEW_TAIL_LINES;
    if (total <= head + tail) {
      var all = [];
      for (var i = 0; i < total; i++) all.push({ change: changes[i] });
      return all;
    }
    var items = [];
    for (var h = 0; h < head; h++) items.push({ change: changes[h] });
    items.push({ omit: true, omitted: total - head - tail });
    for (var t = total - tail; t < total; t++) items.push({ change: changes[t] });
    return items;
  }

  function appendChangeItemsToBody(body, changes) {
    var items = buildDisplayItems(changes);
    for (var di = 0; di < items.length; di++) {
      var item = items[di];
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
    var root = document.createElement('div');
    root.className = 'diff-changes' + (opts.compact ? ' compact' : '');

    for (var f = 0; f < files.length; f++) {
      var file = files[f];
      var stats = countFileChanges(file);
      var block = document.createElement('div');
      block.className = 'diff-file-block';

      var head = document.createElement('div');
      head.className = 'diff-file-head';

      var chevron = document.createElement('span');
      chevron.className = 'diff-file-chevron';
      chevron.textContent = '▸';
      head.appendChild(chevron);

      var nameEl = document.createElement('span');
      nameEl.className = 'diff-file-name';
      nameEl.textContent = file.fileName || '(unknown)';
      head.appendChild(nameEl);

      var statsEl = document.createElement('span');
      statsEl.className = 'diff-file-stats';
      if (stats.del > 0) {
        var delStat = document.createElement('span');
        delStat.className = 'diff-stat-del';
        delStat.textContent = '-' + stats.del;
        statsEl.appendChild(delStat);
      }
      if (stats.add > 0) {
        var addStat = document.createElement('span');
        addStat.className = 'diff-stat-add';
        addStat.textContent = '+' + stats.add;
        statsEl.appendChild(addStat);
      }
      head.appendChild(statsEl);

      var body = document.createElement('div');
      body.className = 'diff-file-body expanded';

      appendChangeItemsToBody(body, file.changes);

      head.addEventListener('click', function (b, c) {
        return function () {
          var open = b.classList.contains('expanded');
          if (open) {
            b.classList.remove('expanded');
            c.classList.remove('expanded');
          } else {
            b.classList.add('expanded');
            c.classList.add('expanded');
          }
        };
      }(body, chevron));

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
    var diffText = extractUnifiedDiff(rawText);
    if (!diffText) return null;

    var files = parseChangesOnly(diffText);
    if (files.length === 0) return null;
    return render(files, opts);
  }

  /** @deprecated 兼容旧调用 */
  function parse(text) {
    var files = parseChangesOnly(text);
    if (files.length === 0) return { fileName: '', hunks: [] };
    var f = files[0];
    return {
      fileName: f.fileName,
      hunks: [{ header: '', lines: f.changes.map(function (c) {
        return {
          type: c.type,
          oldNum: c.type === 'del' ? c.lineNum : null,
          newNum: c.type === 'add' ? c.lineNum : null,
          content: c.content,
        };
      }) }],
    };
  }

  function countChanges(parsed) {
    var add = 0;
    var del = 0;
    var hunks = parsed.hunks || [];
    for (var h = 0; h < hunks.length; h++) {
      var lines = hunks[h].lines || [];
      for (var l = 0; l < lines.length; l++) {
        if (lines[l].type === 'add') add++;
        if (lines[l].type === 'del') del++;
      }
    }
    return { add: add, del: del };
  }

  return {
    extractUnifiedDiff: extractUnifiedDiff,
    looksLikeUnifiedDiffText: looksLikeUnifiedDiffText,
    parseChangesOnly: parseChangesOnly,
    interleaveChangeBlocks: interleaveChangeBlocks,
    buildDisplayItems: buildDisplayItems,
    parse: parse,
    render: render,
    renderFromText: renderFromText,
    countChanges: countChanges,
  };
})();

/** Vite 打包后由 main.js 以 module 导入，须显式挂到 window 供其它脚本使用 */
window.DiffViewer = DiffViewer;
