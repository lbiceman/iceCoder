// @ts-nocheck
import { t } from './i18n.ts';
/**
 * 知识库 ·「规则」页签：用户级全局规则（对所有工作区生效、每次对话都会携带的自定义提示词）。
 */

/* exported RulesPage */

export const RulesPage = (() => {

  const DEFAULT_LIMITS = { maxEnabledTotalChars: 3000 };

  let containerEl = null;
  let rules = [];
  let limits = DEFAULT_LIMITS;
  let overheadTokens = 0;
  /** null：无编辑；'new'：新增；其余为正在编辑的规则 id */
  let editingId = null;
  /** 编辑中的草稿；保存失败重绘时保留用户输入 */
  let draft = '';
  let busy = false;
  let fetchAbort = null;

  function escapeHtml(str) {
    const div = document.createElement('div');
    div.appendChild(document.createTextNode(str || ''));
    return div.innerHTML;
  }

  /** 与服务端 token-estimator 一致：中日韩及全角字符约 1 token/字，其余约 4 字符/token。 */
  function estimateTokens(text) {
    let tokens = 0;
    for (let i = 0; i < text.length; i++) {
      const c = text.charCodeAt(i);
      const wide = (c >= 0x4E00 && c <= 0x9FFF) || (c >= 0x3400 && c <= 0x4DBF)
        || (c >= 0x3000 && c <= 0x303F) || (c >= 0xFF00 && c <= 0xFFEF)
        || (c >= 0xAC00 && c <= 0xD7AF) || (c >= 0x3040 && c <= 0x30FF);
      tokens += wide ? 1 : 0.25;
    }
    return Math.ceil(tokens);
  }

  function enabledContents(list) {
    return list.filter((r) => r.enabled && r.content.trim()).map((r) => r.content.trim());
  }

  function totalChars(contents) {
    return contents.reduce((sum, c) => sum + c.length, 0);
  }

  function totalTokens(contents) {
    if (!contents.length) return 0;
    const listText = contents
      .map((c, i) => `${i + 1}. ${c.replace(/\r?\n/g, '\n   ')}`)
      .join('\n');
    return overheadTokens + estimateTokens(listText);
  }

  /** 把编辑中的草稿代入规则列表，得到「保存后」的启用内容。 */
  function contentsWithDraft(draft) {
    const draftText = draft.trim();
    if (editingId === 'new') {
      const list = enabledContents(rules);
      if (draftText) list.push(draftText);
      return list;
    }
    return enabledContents(rules.map((r) => (r.id === editingId ? { ...r, content: draftText, enabled: r.enabled } : r)));
  }

  /** 当前编辑框最多可写字数：总额度减去其他启用规则；停用规则不占额度，但单条也不超过总额度。 */
  function editorMaxChars() {
    const max = limits.maxEnabledTotalChars;
    const others = editingId === 'new'
      ? enabledContents(rules)
      : enabledContents(rules.filter((r) => r.id !== editingId));
    const editingRule = rules.find((r) => r.id === editingId);
    if (editingRule && !editingRule.enabled) return max;
    return Math.max(0, max - totalChars(others));
  }

  function statsHtml(contents) {
    const chars = totalChars(contents);
    const tokens = totalTokens(contents);
    const max = limits.maxEnabledTotalChars;
    const over = chars > max;
    const pct = Math.min(100, Math.round((chars / max) * 100));
    return (
      `<div class="rules-stats${over ? ' is-over' : ''}">` +
        `<span>${t('rules.enabledSummary', { count: contents.length, chars, max })}</span>` +
        `<span>${t('rules.tokenSummary', { tokens })}</span>` +
      '</div>' +
      `<div class="rules-meter${over ? ' is-over' : ''}" aria-hidden="true"><div class="rules-meter-fill" style="width:${pct}%"></div></div>`
    );
  }

  function updateStats(contents) {
    const el = containerEl && containerEl.querySelector('#rules-stats');
    if (el) el.innerHTML = statsHtml(contents);
  }

  function editorHtml(initial) {
    return (
      '<div class="rules-editor">' +
        `<textarea class="rules-editor-input" rows="4" maxlength="${editorMaxChars()}" placeholder="${t('rules.placeholder')}">${escapeHtml(initial)}</textarea>` +
        '<div class="rules-editor-foot">' +
          '<span class="rules-editor-count"></span>' +
          '<div class="rules-editor-actions">' +
            '<button type="button" class="skills-btn" data-action="cancel">' + t('common.cancel') + '</button>' +
            '<button type="button" class="skills-btn skills-btn-primary" data-action="save">' + t('common.save') + '</button>' +
          '</div>' +
        '</div>' +
      '</div>'
    );
  }

  function bindEditor(host) {
    const input = host.querySelector('.rules-editor-input');
    const countEl = host.querySelector('.rules-editor-count');
    const saveBtn = host.querySelector('[data-action="save"]');
    const refresh = () => {
      draft = input.value;
      const text = input.value.trim();
      const contents = contentsWithDraft(input.value);
      const overTotal = totalChars(contents) > limits.maxEnabledTotalChars;
      const remaining = Math.max(0, editorMaxChars() - text.length);
      countEl.textContent = t('rules.draftCount', { chars: text.length, tokens: estimateTokens(text), remaining });
      countEl.classList.toggle('is-over', overTotal);
      saveBtn.disabled = busy || !text || overTotal;
      updateStats(contents);
    };
    input.addEventListener('input', refresh);
    host.querySelector('[data-action="cancel"]').addEventListener('click', () => {
      editingId = null;
      draft = '';
      renderList();
    });
    saveBtn.addEventListener('click', () => {
      const text = input.value.trim();
      if (!text) return;
      if (editingId === 'new') request('POST', '/api/user-rules', { content: text }, t('rules.added'), true);
      else request('PUT', `/api/user-rules/${encodeURIComponent(editingId)}`, { content: text }, t('rules.saved'), true);
    });
    refresh();
    input.focus();
    input.setSelectionRange(input.value.length, input.value.length);
  }

  function ruleCardHtml(rule, index) {
    const locked = editingId !== null ? ' disabled' : '';
    return (
      `<article class="rules-card${rule.enabled ? '' : ' is-disabled'}" data-id="${escapeHtml(rule.id)}">` +
        '<div class="rules-card-head">' +
          `<span class="rules-card-index">#${index + 1}</span>` +
          `<span class="rules-card-meta">~ ${estimateTokens(rule.content.trim())} tokens</span>` +
          `<label class="config-default-switch rules-card-switch" title="${rule.enabled ? t('common.on') : t('common.off')}">` +
            `<input type="checkbox" data-action="toggle"${rule.enabled ? ' checked' : ''}${locked} />` +
            '<span class="config-default-switch-track" aria-hidden="true"></span>' +
          '</label>' +
        '</div>' +
        `<div class="rules-card-content">${escapeHtml(rule.content)}</div>` +
        '<div class="rules-card-actions">' +
          `<button type="button" class="skills-btn" data-action="edit"${locked}>${t('common.edit')}</button>` +
          `<button type="button" class="skills-btn skills-btn-danger" data-action="delete"${locked}>${t('common.delete')}</button>` +
        '</div>' +
      '</article>'
    );
  }

  function renderList() {
    if (!containerEl) return;
    const listEl = containerEl.querySelector('#rules-list');
    const countEl = containerEl.querySelector('#rules-count');
    const addBtn = containerEl.querySelector('#rules-add-btn');
    if (!listEl) return;

    const full = totalChars(enabledContents(rules)) >= limits.maxEnabledTotalChars;
    if (countEl) countEl.textContent = t('rules.count', { n: rules.length });
    if (addBtn) {
      addBtn.disabled = busy || full || editingId !== null;
      addBtn.title = full ? t('rules.full', { max: limits.maxEnabledTotalChars }) : '';
    }
    updateStats(enabledContents(rules));

    let html = '';
    if (editingId === 'new') html += `<div class="rules-card is-editing" data-id="new">${editorHtml(draft)}</div>`;
    rules.forEach((rule, i) => {
      html += rule.id === editingId
        ? `<div class="rules-card is-editing" data-id="${escapeHtml(rule.id)}">${editorHtml(draft)}</div>`
        : ruleCardHtml(rule, i);
    });
    if (!rules.length && editingId !== 'new') {
      html = `<div class="skills-empty rules-empty">${escapeHtml(t('rules.empty'))}</div>`;
    }
    listEl.innerHTML = html;

    const editing = listEl.querySelector('.rules-card.is-editing');
    if (editing) bindEditor(editing);
  }

  function applyResponse(body) {
    rules = Array.isArray(body.rules) ? body.rules : [];
    if (body.limits) limits = body.limits;
    if (typeof body.overheadTokens === 'number') overheadTokens = body.overheadTokens;
  }

  function request(method, url, payload, successText, closeEditor) {
    if (busy) return;
    busy = true;
    fetch(url, {
      method,
      headers: payload ? { 'Content-Type': 'application/json' } : undefined,
      body: payload ? JSON.stringify(payload) : undefined,
    })
      .then((res) => res.json().then((body) => ({ ok: res.ok, body })))
      .then((out) => {
        if (!out.ok || !out.body.success) throw new Error((out.body && out.body.error) || t('common.operationFailed'));
        applyResponse(out.body);
        if (closeEditor) {
          editingId = null;
          draft = '';
        }
        if (successText && window.Notification) Notification.success(successText);
      })
      .catch((err) => {
        if (window.Notification) Notification.error(err.message || t('common.operationFailed'));
      })
      .finally(() => {
        busy = false;
        renderList();
      });
  }

  function onListClick(e) {
    const btn = e.target.closest('[data-action]');
    const card = e.target.closest('.rules-card');
    if (!btn || !card || card.classList.contains('is-editing')) return;
    const id = card.getAttribute('data-id');
    const rule = rules.find((r) => r.id === id);
    if (!rule) return;
    const action = btn.getAttribute('data-action');
    if (action === 'edit') {
      if (editingId !== null) return;
      editingId = id;
      draft = rule.content;
      renderList();
    } else if (action === 'delete') {
      window.Modal.confirm({
        title: t('rules.deleteTitle'),
        message: t('rules.deleteBody'),
        type: 'danger',
        confirmText: t('common.delete'),
        cancelText: t('common.cancel'),
        dangerConfirm: true,
      }).then((ok) => {
        if (ok) request('DELETE', `/api/user-rules/${encodeURIComponent(id)}`, null, t('rules.deleted'));
      });
    }
  }

  function onListChange(e) {
    const input = e.target.closest('[data-action="toggle"]');
    const card = input && input.closest('.rules-card');
    if (!card) return;
    const id = card.getAttribute('data-id');
    request('PUT', `/api/user-rules/${encodeURIComponent(id)}`, { enabled: input.checked }, null);
  }

  function reload() {
    if (!containerEl) return;
    if (fetchAbort) fetchAbort.abort();
    fetchAbort = new AbortController();
    const listEl = containerEl.querySelector('#rules-list');
    fetch('/api/user-rules', { signal: fetchAbort.signal })
      .then((res) => res.json())
      .then((body) => {
        if (!body.success) throw new Error(body.error || t('common.loadFailed'));
        applyResponse(body);
        renderList();
      })
      .catch((err) => {
        if (err && err.name === 'AbortError') return;
        if (listEl) listEl.innerHTML = `<div class="skills-empty">${escapeHtml(t('rules.loadFailed', { message: err.message || t('common.unknownError') }))}</div>`;
      });
  }

  function destroy() {
    if (fetchAbort) {
      fetchAbort.abort();
      fetchAbort = null;
    }
    containerEl = null;
    rules = [];
    editingId = null;
    draft = '';
    busy = false;
  }

  function render(parentEl) {
    destroy();
    containerEl = parentEl;
    parentEl.innerHTML = '';
    const Tabs = window.KnowledgeTabs;
    if (Tabs) Tabs.remember('rules');

    const root = document.createElement('div');
    root.className = 'skills-root rules-root';

    const header = document.createElement('header');
    header.className = 'skills-header knowledge-header';
    header.innerHTML =
      '<div class="skills-header-text">' +
        '<h1 class="skills-title">' + t('nav.knowledge') + '</h1>' +
        '<p class="skills-hint">' + t('rules.hint') + '</p>' +
      '</div>' +
      (Tabs ? Tabs.html('rules') : '');
    if (Tabs) Tabs.bind(header);

    const main = document.createElement('main');
    main.className = 'rules-main';
    main.innerHTML =
      '<section class="rules-notice">' +
        '<p class="rules-notice-text">' + t('rules.notice1') + '</p>' +
        '<p class="rules-notice-text">' + t('rules.notice2') + '</p>' +
        `<div id="rules-stats">${statsHtml([])}</div>` +
      '</section>' +
      '<div class="rules-toolbar">' +
        '<span class="skills-count" id="rules-count">' + t('common.loadingPage') + '</span>' +
        '<button type="button" class="skills-btn skills-btn-primary" id="rules-add-btn">' + t('rules.add') + '</button>' +
      '</div>' +
      '<div class="rules-list" id="rules-list"></div>';

    root.appendChild(header);
    root.appendChild(main);
    parentEl.appendChild(root);

    main.querySelector('#rules-add-btn').addEventListener('click', () => {
      if (editingId !== null || totalChars(enabledContents(rules)) >= limits.maxEnabledTotalChars) return;
      editingId = 'new';
      draft = '';
      renderList();
    });
    const listEl = main.querySelector('#rules-list');
    listEl.addEventListener('click', onListClick);
    listEl.addEventListener('change', onListChange);

    reload();
  }

  return {
    render,
    destroy,
  };
})();

if (typeof window !== 'undefined') {
  window.RulesPage = RulesPage;
}
