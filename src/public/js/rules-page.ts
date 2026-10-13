// @ts-nocheck
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
        `<span>已启用 <strong>${contents.length}</strong> 条，合计 <strong>${chars}</strong> / ${max} 字</span>` +
        `<span>预计每轮输入增加约 <strong>${tokens}</strong> tokens</span>` +
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
        `<textarea class="rules-editor-input" rows="4" maxlength="${editorMaxChars()}" placeholder="例如：始终使用简体中文回复；修改代码后先运行相关测试。">${escapeHtml(initial)}</textarea>` +
        '<div class="rules-editor-foot">' +
          '<span class="rules-editor-count"></span>' +
          '<div class="rules-editor-actions">' +
            '<button type="button" class="skills-btn" data-action="cancel">取消</button>' +
            '<button type="button" class="skills-btn skills-btn-primary" data-action="save">保存</button>' +
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
      countEl.textContent = `本条 ${text.length} 字 · 约 ${estimateTokens(text)} tokens · 还可写 ${remaining} 字`;
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
      if (editingId === 'new') request('POST', '/api/user-rules', { content: text }, '规则已添加', true);
      else request('PUT', `/api/user-rules/${encodeURIComponent(editingId)}`, { content: text }, '规则已保存', true);
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
          `<span class="rules-card-meta">${rule.content.trim().length} 字 · 约 ${estimateTokens(rule.content.trim())} tokens</span>` +
          `<label class="config-default-switch rules-card-switch" title="${rule.enabled ? '已启用' : '已停用'}">` +
            `<input type="checkbox" data-action="toggle"${rule.enabled ? ' checked' : ''}${locked} />` +
            '<span class="config-default-switch-track" aria-hidden="true"></span>' +
          '</label>' +
        '</div>' +
        `<div class="rules-card-content">${escapeHtml(rule.content)}</div>` +
        '<div class="rules-card-actions">' +
          `<button type="button" class="skills-btn" data-action="edit"${locked}>编辑</button>` +
          `<button type="button" class="skills-btn skills-btn-danger" data-action="delete"${locked}>删除</button>` +
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
    if (countEl) countEl.textContent = `${rules.length} 条`;
    if (addBtn) {
      addBtn.disabled = busy || full || editingId !== null;
      addBtn.title = full ? `启用规则已写满 ${limits.maxEnabledTotalChars} 字，可精简或停用部分规则后再新增` : '';
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
      html = '<div class="skills-empty rules-empty">还没有规则。点击「新增规则」，写下希望每次对话都遵守的约定，例如「始终使用简体中文回复」。</div>';
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
        if (!out.ok || !out.body.success) throw new Error((out.body && out.body.error) || '操作失败');
        applyResponse(out.body);
        if (closeEditor) {
          editingId = null;
          draft = '';
        }
        if (successText && window.Notification) Notification.success(successText);
      })
      .catch((err) => {
        if (window.Notification) Notification.error(err.message || '操作失败');
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
        title: '删除规则',
        message: '确定删除这条规则？此操作不可撤销。',
        type: 'danger',
        confirmText: '删除',
        cancelText: '取消',
        dangerConfirm: true,
      }).then((ok) => {
        if (ok) request('DELETE', `/api/user-rules/${encodeURIComponent(id)}`, null, '规则已删除');
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
        if (!body.success) throw new Error(body.error || '加载失败');
        applyResponse(body);
        renderList();
      })
      .catch((err) => {
        if (err && err.name === 'AbortError') return;
        if (listEl) listEl.innerHTML = `<div class="skills-empty">加载失败：${escapeHtml(err.message || '未知错误')}</div>`;
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
        '<h1 class="skills-title">知识库</h1>' +
        '<p class="skills-hint">规则是你的个人提示词，对所有工作区生效。</p>' +
      '</div>' +
      (Tabs ? Tabs.html('rules') : '');
    if (Tabs) Tabs.bind(header);

    const main = document.createElement('main');
    main.className = 'rules-main';
    main.innerHTML =
      '<section class="rules-notice">' +
        '<p class="rules-notice-text">启用的规则<strong>每次对话都会携带</strong>：新对话开始时注入上下文，之后随该对话的每一轮请求一起发给模型，' +
        '因此会持续占用输入 token（中文约 1 字 ≈ 1 token，英文约 4 个字母 ≈ 1 token）。修改后在新开的对话中生效。</p>' +
        '<p class="rules-notice-text"><strong>规则写得越多、越长，AI 越容易记混、漏掉，甚至不按规则来。</strong>' +
        '建议只写真正每次都需要的要求，一条只说一件事，说得具体直接；不常用的规则可以先停用。' +
        '参考：启用的规则<strong>最好不超过 10 条</strong>，<strong>每条最好在 200 字以内</strong>（仅为建议，不做限制）。</p>' +
        `<div id="rules-stats">${statsHtml([])}</div>` +
      '</section>' +
      '<div class="rules-toolbar">' +
        '<span class="skills-count" id="rules-count">载入中…</span>' +
        '<button type="button" class="skills-btn skills-btn-primary" id="rules-add-btn">新增规则</button>' +
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
