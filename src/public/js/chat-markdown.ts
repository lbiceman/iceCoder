// @ts-nocheck
/**
 * 助手气泡的轻量 Markdown。
 * 只覆盖标题、列表、任务列表、引用、表格、围栏代码、行内代码、粗体、斜体、删除线、链接。
 * 没有可渲染结构，或解析抛错时返回 null，调用方按原文显示。
 */

/* exported ChatMarkdown, renderChatMarkdown */

function escapeHtml(text) {
  return String(text)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function matchFenceOpen(line) {
  const m = /^( {0,3})(`{3,}|~{3,})(.*)$/.exec(line);
  if (!m) return null;
  const marker = m[2];
  const rest = m[3];
  if (rest.indexOf(marker.charAt(0)) !== -1) return null;
  const token = (rest.trim().split(/\s+/)[0] || '');
  return { marker: marker, lang: token };
}

function matchFenceClose(line, marker) {
  const m = /^( {0,3})(`{3,}|~{3,})\s*$/.exec(line);
  if (!m) return false;
  return m[2].charAt(0) === marker.charAt(0) && m[2].length >= marker.length;
}

function sanitizeLang(lang) {
  if (!lang) return '';
  return String(lang).replace(/[^A-Za-z0-9_+#.-]/g, '').slice(0, 32);
}

function matchHeading(line) {
  const m = /^ {0,3}(#{1,6})\s+(\S.*)$/.exec(line);
  if (!m) return null;
  return { level: m[1].length, text: m[2].trim() };
}

function isHr(line) {
  return /^ {0,3}(?:-{3,}|\*{3,}|_{3,})\s*$/.test(line);
}

function isQuote(line) {
  return /^ {0,3}>/.test(line);
}

function quoteText(line) {
  return line.replace(/^ {0,3}>\s?/, '');
}

function parseListItem(line) {
  const m = /^ {0,3}([-*+]|\d+[.)])\s+(\S.*)$/.exec(line);
  if (!m) return null;
  const marker = m[1];
  const ordered = /^\d/.test(marker);
  let start = 1;
  if (ordered) {
    start = parseInt(marker, 10);
    if (!isFinite(start) || start < 0 || start > 9999) return null;
  }
  return { ordered: ordered, start: start, text: m[2] };
}

function parseTask(text) {
  const m = /^\[([ xX])\]\s+(\S.*)$/.exec(text);
  if (!m) return null;
  return { done: m[1] !== ' ', text: m[2] };
}

function renderListItem(item) {
  const task = parseTask(item.text);
  if (!task) return '<li>' + renderInline(item.text).html + '</li>';
  const box = '<input type="checkbox" disabled' + (task.done ? ' checked' : '') + '>';
  const cls = task.done ? 'md-task is-done' : 'md-task';
  return '<li class="' + cls + '">' + box + renderInline(task.text).html + '</li>';
}

function isStructural(line) {
  return !!(matchFenceOpen(line) || matchHeading(line) || isHr(line) || isQuote(line) || parseListItem(line));
}

function splitRow(line) {
  const trimmed = String(line || '').trim();
  if (trimmed.indexOf('|') === -1) return null;
  let body = trimmed;
  const hadLeading = body.charAt(0) === '|';
  const hadTrailing = body.charAt(body.length - 1) === '|';
  if (hadLeading) body = body.slice(1);
  if (hadTrailing && body.length) body = body.slice(0, -1);
  const cells = [];
  let cur = '';
  for (let i = 0; i < body.length; i++) {
    if (body.charAt(i) === '\\' && body.charAt(i + 1) === '|') {
      cur += '|';
      i++;
      continue;
    }
    if (body.charAt(i) === '|') {
      cells.push(cur.trim());
      cur = '';
      continue;
    }
    cur += body.charAt(i);
  }
  cells.push(cur.trim());
  if (cells.length < 2 && !(hadLeading && hadTrailing)) return null;
  return cells;
}

function parseAlignments(cells) {
  if (!cells || !cells.length) return null;
  const aligns = [];
  for (let i = 0; i < cells.length; i++) {
    const cell = cells[i].replace(/\s/g, '');
    if (!/^:?-+:?$/.test(cell) || cell.replace(/:/g, '').length < 3) return null;
    const left = cell.charAt(0) === ':';
    const right = cell.charAt(cell.length - 1) === ':';
    if (left && right) aligns.push('center');
    else if (right) aligns.push('right');
    else if (left) aligns.push('left');
    else aligns.push('');
  }
  return aligns;
}

function isTableStart(lines, index) {
  if (!lines || index < 0 || index + 1 >= lines.length) return false;
  const header = splitRow(lines[index]);
  if (!header || parseAlignments(header)) return false;
  const sep = splitRow(lines[index + 1]);
  if (!sep || sep.length !== header.length) return false;
  return !!parseAlignments(sep);
}

function fitRow(cells, count) {
  const row = cells.slice(0, count);
  while (row.length < count) row.push('');
  return row;
}

function renderTableCell(tag, text, align) {
  const inline = renderInline(text);
  const style = align ? ' style="text-align:' + align + '"' : '';
  return '<' + tag + style + '>' + inline.html + '</' + tag + '>';
}

function renderTable(lines, index) {
  const header = splitRow(lines[index]);
  const aligns = parseAlignments(splitRow(lines[index + 1]));
  const count = header.length;
  let i = index + 2;
  const body = [];
  while (i < lines.length && lines[i].trim()) {
    const row = splitRow(lines[i]);
    if (!row || parseAlignments(row)) break;
    body.push(fitRow(row, count));
    i++;
  }
  let html = '<div class="md-table-wrap"><table class="md-table"><thead><tr>';
  const head = fitRow(header, count);
  for (let c = 0; c < count; c++) {
    html += renderTableCell('th', head[c], aligns[c] || '');
  }
  html += '</tr></thead>';
  if (body.length) {
    html += '<tbody>';
    for (let r = 0; r < body.length; r++) {
      html += '<tr>';
      for (let c = 0; c < count; c++) {
        html += renderTableCell('td', body[r][c], aligns[c] || '');
      }
      html += '</tr>';
    }
    html += '</tbody>';
  }
  html += '</table></div>';
  return { html: html, next: i };
}

function matchLink(text, index) {
  if (text.charAt(index) !== '[') return null;
  const labelEnd = text.indexOf(']', index + 1);
  if (labelEnd < 0 || text.charAt(labelEnd + 1) !== '(') return null;
  const label = text.slice(index + 1, labelEnd);
  if (!label) return null;
  const urlEnd = text.indexOf(')', labelEnd + 2);
  if (urlEnd < 0) return null;
  const url = text.slice(labelEnd + 2, urlEnd).trim();
  if (!/^https?:\/\//i.test(url) && !/^mailto:/i.test(url)) return null;
  if (/[\s<>"']/.test(url)) return null;
  return { label: label, url: url, end: urlEnd + 1 };
}

function linkHtml(url, label) {
  return '<a href="' + escapeHtml(url) + '" target="_blank" rel="noopener noreferrer">'
    + escapeHtml(label) + '</a>';
}

function matchBareUrl(text, index) {
  const lower = text.slice(index, index + 8).toLowerCase();
  if (lower.indexOf('https://') !== 0 && lower.indexOf('http://') !== 0) return null;
  if (index > 0 && /[A-Za-z0-9_/@]/.test(text.charAt(index - 1))) return null;
  let end = index;
  while (end < text.length && !/[\s<>"'`]/.test(text.charAt(end))) end++;
  let url = text.slice(index, end);
  while (url.length) {
    const last = url.charAt(url.length - 1);
    if (!/[.,;:!?，。、；：！？)）\]】》」』]/.test(last)) break;
    if (last === ')' || last === '）') {
      const opens = (url.match(/[（(]/g) || []).length;
      const closes = (url.match(/[）)]/g) || []).length;
      if (closes <= opens) break;
    }
    url = url.slice(0, -1);
  }
  if (!/^https?:\/\/\S/i.test(url)) return null;
  return { url: url, end: index + url.length };
}

function renderInline(text) {
  let html = '';
  let formatted = false;
  let i = 0;
  const n = text.length;
  while (i < n) {
    if (text.charAt(i) === '`') {
      const end = text.indexOf('`', i + 1);
      if (end > i + 1) {
        html += '<code>' + escapeHtml(text.slice(i + 1, end)) + '</code>';
        formatted = true;
        i = end + 1;
        continue;
      }
    }
    if (text.startsWith('**', i)) {
      const end = text.indexOf('**', i + 2);
      if (end > i + 2) {
        html += '<strong>' + escapeHtml(text.slice(i + 2, end)) + '</strong>';
        formatted = true;
        i = end + 2;
        continue;
      }
    }
    if (text.startsWith('~~', i)) {
      const end = text.indexOf('~~', i + 2);
      if (end > i + 2) {
        html += '<del>' + escapeHtml(text.slice(i + 2, end)) + '</del>';
        formatted = true;
        i = end + 2;
        continue;
      }
    }
    if (text.charAt(i) === '[') {
      const link = matchLink(text, i);
      if (link) {
        html += linkHtml(link.url, link.label);
        formatted = true;
        i = link.end;
        continue;
      }
    }
    const bare = matchBareUrl(text, i);
    if (bare) {
      html += linkHtml(bare.url, bare.url);
      formatted = true;
      i = bare.end;
      continue;
    }
    const next = text.charAt(i + 1);
    if (text.charAt(i) === '*' && next && next !== '*' && next !== ' ' && next !== '\t') {
      let end = -1;
      for (let j = i + 2; j < n; j++) {
        const ch = text.charAt(j);
        if (ch !== '*') continue;
        const prev = text.charAt(j - 1);
        const after = text.charAt(j + 1);
        if (after === '*' || prev === '*' || prev === ' ' || prev === '\t') continue;
        end = j;
        break;
      }
      if (end > i + 1) {
        html += '<em>' + escapeHtml(text.slice(i + 1, end)) + '</em>';
        formatted = true;
        i = end + 1;
        continue;
      }
    }
    let j = i + 1;
    while (j < n) {
      const ch = text.charAt(j);
      if (ch === '`' || ch === '*' || ch === '[' || ch === '~') break;
      const ahead = text.slice(j, j + 8).toLowerCase();
      if (ahead.indexOf('https://') === 0 || ahead.indexOf('http://') === 0) break;
      j++;
    }
    html += escapeHtml(text.slice(i, j));
    i = j;
  }
  return { html: html, formatted: formatted };
}

function renderBlocks(src) {
  const lines = src.replace(/\r\n/g, '\n').replace(/\r/g, '\n').split('\n');
  const parts = [];
  let formatted = false;
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    if (!line.trim()) {
      i++;
      continue;
    }

    const fence = matchFenceOpen(line);
    if (fence) {
      const body = [];
      i++;
      while (i < lines.length && !matchFenceClose(lines[i], fence.marker)) {
        body.push(lines[i]);
        i++;
      }
      if (i < lines.length) i++;
      const lang = sanitizeLang(fence.lang);
      const label = lang ? '<span class="md-code-lang">' + escapeHtml(lang) + '</span>' : '';
      parts.push('<pre class="md-code">' + label + '<code>' + escapeHtml(body.join('\n')) + '</code></pre>');
      formatted = true;
      continue;
    }

    const heading = matchHeading(line);
    if (heading) {
      const inline = renderInline(heading.text);
      parts.push('<h' + heading.level + '>' + inline.html + '</h' + heading.level + '>');
      formatted = true;
      i++;
      continue;
    }

    if (isHr(line)) {
      parts.push('<hr>');
      formatted = true;
      i++;
      continue;
    }

    if (isQuote(line)) {
      const quoted = [];
      while (i < lines.length && isQuote(lines[i])) {
        quoted.push(renderInline(quoteText(lines[i])).html);
        i++;
      }
      parts.push('<blockquote>' + quoted.join('<br>') + '</blockquote>');
      formatted = true;
      continue;
    }

    if (isTableStart(lines, i)) {
      const table = renderTable(lines, i);
      parts.push(table.html);
      formatted = true;
      i = table.next;
      continue;
    }

    const firstItem = parseListItem(line);
    if (firstItem) {
      const ordered = firstItem.ordered;
      const items = [];
      const start = firstItem.start;
      while (i < lines.length) {
        const item = parseListItem(lines[i]);
        if (!item || item.ordered !== ordered) break;
        items.push(renderListItem(item));
        i++;
      }
      const tag = ordered ? 'ol' : 'ul';
      const startAttr = ordered && start > 1 ? ' start="' + start + '"' : '';
      parts.push('<' + tag + startAttr + '>' + items.join('') + '</' + tag + '>');
      formatted = true;
      continue;
    }

    const para = [];
    let paraFormatted = false;
    while (i < lines.length && lines[i].trim() && !isStructural(lines[i]) && !isTableStart(lines, i)) {
      const inline = renderInline(lines[i]);
      if (inline.formatted) paraFormatted = true;
      para.push(inline.html);
      i++;
    }
    if (!para.length) {
      parts.push('<p>' + escapeHtml(line) + '</p>');
      i++;
      continue;
    }
    parts.push('<p>' + para.join('<br>') + '</p>');
    if (paraFormatted) formatted = true;
  }
  if (!formatted) return null;
  return parts.join('');
}

export function renderChatMarkdown(src) {
  if (typeof src !== 'string' || !src) return null;
  try {
    return renderBlocks(src);
  } catch (_err) {
    return null;
  }
}

export const ChatMarkdown = {
  render: renderChatMarkdown,
};

if (typeof window !== 'undefined') {
  window.ChatMarkdown = ChatMarkdown;
}
