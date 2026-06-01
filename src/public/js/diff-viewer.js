/**
 * Diff Viewer — CC 风格：仅展示变更行（+ / -），无上下文、无 hunk 头
 */

/* exported DiffViewer */
var DiffViewer = (function () {
  'use strict';

  var TOOL_PREFIX_RE = /^\[[^\]]+\]\n?/;
  var MAX_LINES_PER_FILE = 120;

  /**
   * 从工具输出中提取 unified diff 文本
   * @param {string} text
   * @returns {string|null}
   */
  function extractUnifiedDiff(text) {
    if (!text || typeof text !== 'string') return null;

    var cleaned = text.replace(TOOL_PREFIX_RE, '');
    var start = cleaned.search(/^(?:diff --git |--- )/m);
    if (start < 0) return null;
    cleaned = cleaned.slice(start);

    if (!/^@@\s/m.test(cleaned) && !/^(?:\+(?!\+)|-(?!-))/m.test(cleaned)) return null;
    return cleaned;
  }

  /**
   * @typedef {{ fileName: string, changes: Array<{ type: string, content: string }> }} DiffFile
   */

  /**
   * 解析 unified diff → 按文件分组，仅保留 add/del 行
   * @param {string} text
   * @returns {DiffFile[]}
   */
  function parseChangesOnly(text) {
    if (!text || typeof text !== 'string') return [];

    var lines = text.split(/\r?\n/);
    var files = [];
    var current = null;

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
        continue;
      }

      if (line.startsWith('+++ ')) {
        var name = line.substring(4).replace(/^b\//, '').replace(/^a\//, '').trim();
        if (name !== '/dev/null') ensureFile(name);
        continue;
      }

      if (line.startsWith('--- ') || line.startsWith('index ') || line.startsWith('@@')) continue;
      if (line.startsWith('new file mode') || line.startsWith('deleted file mode')) continue;
      if (line.startsWith('similarity index') || line.startsWith('rename from')) continue;

      if (!current) {
        current = { fileName: '', changes: [] };
        files.push(current);
      }

      if (line.startsWith('+') && !line.startsWith('+++')) {
        current.changes.push({ type: 'add', content: line.substring(1) });
      } else if (line.startsWith('-') && !line.startsWith('---')) {
        current.changes.push({ type: 'del', content: line.substring(1) });
      }
    }

    return files.filter(function (f) {
      return f.changes.length > 0;
    });
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

  /**
   * CC 风格渲染
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

      var total = file.changes.length;
      var showCount = total > MAX_LINES_PER_FILE ? MAX_LINES_PER_FILE : total;

      for (var li = 0; li < showCount; li++) {
        var ch = file.changes[li];
        var row = document.createElement('div');
        row.className = 'diff-change-line diff-change-' + ch.type;
        row.textContent = ch.content;
        body.appendChild(row);
      }

      if (total > MAX_LINES_PER_FILE) {
        var more = document.createElement('div');
        more.className = 'diff-change-more';
        more.textContent = '… 还有 ' + (total - MAX_LINES_PER_FILE) + ' 行变更';
        body.appendChild(more);
      }

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
    if (!diffText && rawText && /^@@\s/m.test(rawText)) {
      diffText = rawText;
    }
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
        return { type: c.type, oldNum: null, newNum: null, content: c.content };
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
    parseChangesOnly: parseChangesOnly,
    parse: parse,
    render: render,
    renderFromText: renderFromText,
    countChanges: countChanges,
  };
})();
