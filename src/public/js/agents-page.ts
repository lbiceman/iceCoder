// @ts-nocheck
import { t } from './i18n.ts';
/**
 * 知识库 ·「代理」页签：用户自定义 Agent 的列表、新增、编辑与删除。
 * 布局沿用技能页。命令名会出现在聊天输入框的 / 列表里。
 */

/* exported AgentsPage */

export const AgentsPage = (() => {

  let containerEl = null;
  let agents = [];
  let toolCatalog = [];
  let selectedId = null;
  let creating = false;
  let editingId = null;
  let busy = false;
  let listFetchAbort = null;

  function escapeHtml(str) {
    const div = document.createElement('div');
    div.appendChild(document.createTextNode(str || ''));
    return div.innerHTML;
  }

  function formatZhIso(iso) {
    if (!iso) return '—';
    try {
      const d = new Date(iso);
      if (isNaN(d.getTime())) return '—';
      return d.toLocaleString('zh-CN', {
        year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit',
      });
    } catch (_e) {
      return '—';
    }
  }

  function notifyChanged() {
    window.dispatchEvent(new CustomEvent('ice-agents-changed'));
  }

  function agentById(id) {
    for (let i = 0; i < agents.length; i++) {
      if (agents[i].id === id) return agents[i];
    }
    return null;
  }

  function selectedToolsFrom(root) {
    const boxes = root.querySelectorAll('input[name="agent-tool"]:checked');
    const names = [];
    for (let i = 0; i < boxes.length; i++) names.push(boxes[i].value);
    return names;
  }

  function formValues(root) {
    const field = (name) => {
      const el = root.querySelector(`[name="${name}"]`);
      return el ? String(el.value || '') : '';
    };
    return {
      id: field('id').trim().toLowerCase(),
      name: field('name').trim(),
      description: field('description').trim(),
      prompt: field('prompt'),
      tools: selectedToolsFrom(root),
    };
  }

  function toolGridHtml(selected) {
    const picked = {};
    const list = selected || [];
    for (let i = 0; i < list.length; i++) picked[list[i]] = true;
    const known = {};
    let html = '<div class="agent-tool-grid">';
    for (let i = 0; i < toolCatalog.length; i++) {
      const tool = toolCatalog[i];
      known[tool.name] = true;
      const on = !!picked[tool.name];
      html += `<label class="agent-tool-item">` +
        `<input type="checkbox" name="agent-tool" value="${escapeHtml(tool.name)}"${on ? ' checked' : ''}>` +
        `<span class="agent-tool-name">${escapeHtml(tool.name)}</span>` +
        `<span class="agent-tool-desc">${escapeHtml(tool.description || '')}</span>` +
      '</label>';
    }
    const extra = [];
    for (let i = 0; i < list.length; i++) {
      if (!known[list[i]]) extra.push(list[i]);
    }
    for (let i = 0; i < extra.length; i++) {
      html += `<label class="agent-tool-item">` +
        `<input type="checkbox" name="agent-tool" value="${escapeHtml(extra[i])}" checked>` +
        `<span class="agent-tool-name">${escapeHtml(extra[i])}</span>` +
      '</label>';
    }
    if (!toolCatalog.length && !extra.length) {
      html += `<p class="agent-tool-empty">${t('agents.toolsEmpty')}</p>`;
    }
    return html + '</div>';
  }

  function formHtml(agent) {
    const row = agent || { id: '', name: '', description: '', prompt: '', tools: [] };
    const idField = agent
      ? `<p class="skills-detail-desc">/${escapeHtml(row.id)}</p>`
      : `<label class="skills-field"><span>${t('agents.command')}</span>` +
        `<input class="skills-field-input" name="id" value="" placeholder="${t('agents.commandPh')}" autocomplete="off"></label>`;
    return `<form class="agent-form" data-id="${escapeHtml(row.id || '')}">` +
      idField +
      `<label class="skills-field"><span>${t('agents.name')}</span>` +
        `<input class="skills-field-input" name="name" value="${escapeHtml(row.name)}" placeholder="${t('agents.namePh')}"></label>` +
      `<label class="skills-field"><span>${t('agents.desc')}</span>` +
        `<input class="skills-field-input" name="description" value="${escapeHtml(row.description || '')}" placeholder="${t('agents.descPh')}"></label>` +
      `<label class="skills-field"><span>${t('agents.prompt')}</span>` +
        `<textarea class="skills-detail-content skills-detail-editor" name="prompt" placeholder="${t('agents.promptPh')}">${escapeHtml(row.prompt || '')}</textarea></label>` +
      `<div class="skills-field"><span>${t('agents.tools')}</span>` +
        `<p class="skills-detail-desc">${t('agents.toolsHint')}</p>` +
        toolGridHtml(row.tools) +
      '</div>' +
      '<div class="skills-editor-foot">' +
        '<button type="button" class="skills-btn" data-action="cancel">' + t('common.cancel') + '</button>' +
        '<button type="submit" class="skills-btn skills-btn-primary">' + t('common.save') + '</button>' +
      '</div></form>';
  }

  function detailHtml(agent) {
    const tools = Array.isArray(agent.tools) ? agent.tools : [];
    const toolText = tools.length ? tools.join('、') : t('agents.noTools');
    return '<div class="skills-detail-header">' +
      '<div class="skills-detail-title-row">' +
        `<h2 class="skills-detail-title">${escapeHtml(agent.name)}</h2>` +
        `<span class="skills-detail-chip">/${escapeHtml(agent.id)}</span>` +
      '</div>' +
      `<p class="skills-detail-desc">${escapeHtml(agent.description || t('agents.noDesc'))}</p>` +
      '<div class="skills-detail-actions">' +
        '<button type="button" class="skills-btn skills-btn-danger" data-action="delete">' + t('common.delete') + '</button>' +
        '<button type="button" class="skills-btn" data-action="edit">' + t('common.edit') + '</button>' +
      '</div></div>' +
      `<pre class="skills-detail-content">${escapeHtml(agent.prompt || '')}</pre>` +
      `<p class="skills-detail-desc">${escapeHtml(t('agents.toolCount', { n: tools.length }))} ${escapeHtml(toolText)}</p>`;
  }

  function paintDetail() {
    const detailEl = containerEl && containerEl.querySelector('#agents-detail');
    if (!detailEl) return;
    if (creating) {
      detailEl.innerHTML = formHtml(null);
      const input = detailEl.querySelector('[name="id"]');
      if (input) input.focus();
      return;
    }
    if (editingId) {
      const agent = agentById(editingId);
      detailEl.innerHTML = agent ? formHtml(agent) : '';
      return;
    }
    const agent = agentById(selectedId);
    detailEl.innerHTML = agent
      ? detailHtml(agent)
      : `<div class="skills-detail-placeholder">${t('agents.placeholder')}</div>`;
  }

  function renderList() {
    const listEl = containerEl && containerEl.querySelector('#agents-list');
    const countEl = containerEl && containerEl.querySelector('#agents-total-count');
    if (countEl) countEl.textContent = t('agents.count', { n: agents.length });
    if (!listEl) return;
    if (!agents.length) {
      listEl.innerHTML = `<div class="skills-empty">${t('agents.empty')}</div>`;
      return;
    }
    let html = '';
    for (let i = 0; i < agents.length; i++) {
      const agent = agents[i];
      const active = agent.id === selectedId ? ' is-active' : '';
      html += `<div class="skills-card${active}" data-id="${escapeHtml(agent.id)}" tabindex="0">` +
        `<div class="skills-card-head"><span class="skills-card-name">${escapeHtml(agent.name)}</span>` +
        `<span class="skills-card-file">/${escapeHtml(agent.id)}</span></div>` +
        `<p class="skills-card-desc">${escapeHtml(agent.description || t('agents.noDesc'))}</p>` +
        `<div class="skills-card-meta">${escapeHtml(t('agents.updated', { time: formatZhIso(agent.updatedAt) }))}</div>` +
      '</div>';
    }
    listEl.innerHTML = html;
  }

  function reload() {
    if (listFetchAbort) listFetchAbort.abort();
    listFetchAbort = new AbortController();
    const signal = listFetchAbort.signal;
    fetch('/api/agents', { signal })
      .then((res) => res.json().then((data) => ({ ok: res.ok, data })))
      .then((result) => {
        if (!result.ok || !result.data.success) throw new Error((result.data && result.data.error) || t('common.unknownError'));
        agents = Array.isArray(result.data.agents) ? result.data.agents : [];
        if (selectedId && !agentById(selectedId)) selectedId = agents[0] ? agents[0].id : null;
        if (!selectedId && agents[0] && !creating) selectedId = agents[0].id;
        renderList();
        paintDetail();
      })
      .catch((err) => {
        if (err && err.name === 'AbortError') return;
        const listEl = containerEl && containerEl.querySelector('#agents-list');
        if (listEl) listEl.innerHTML = `<div class="skills-empty">${escapeHtml(t('agents.loadFailed', { message: err.message || '' }))}</div>`;
      });
  }

  function loadTools() {
    fetch('/api/tools')
      .then((res) => res.json())
      .then((data) => {
        toolCatalog = Array.isArray(data && data.tools) ? data.tools : [];
        if (creating || editingId) paintDetail();
      })
      .catch(() => { toolCatalog = []; });
  }

  function save(form) {
    if (busy) return;
    const body = formValues(form);
    const id = form.getAttribute('data-id') || '';
    if (!id && !body.id) {
      window.Notification && window.Notification.error(t('agents.commandRequired'));
      return;
    }
    if (!body.name) {
      window.Notification && window.Notification.error(t('agents.nameRequired'));
      return;
    }
    if (!String(body.prompt || '').trim()) {
      window.Notification && window.Notification.error(t('agents.promptRequired'));
      return;
    }
    busy = true;
    const url = id ? `/api/agents/${encodeURIComponent(id)}` : '/api/agents';
    const method = id ? 'PUT' : 'POST';
    const payload = id
      ? { name: body.name, description: body.description, prompt: body.prompt, tools: body.tools }
      : body;
    fetch(url, {
      method,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    })
      .then((res) => res.json().then((data) => ({ ok: res.ok, data })))
      .then((result) => {
        busy = false;
        if (!result.ok || !result.data.success) throw new Error((result.data && result.data.error) || t('common.unknownError'));
        creating = false;
        editingId = null;
        selectedId = result.data.agent && result.data.agent.id;
        window.Notification && window.Notification.success(id ? t('agents.saved') : t('agents.created'));
        notifyChanged();
        reload();
      })
      .catch((err) => {
        busy = false;
        window.Notification && window.Notification.error(err.message || t('agents.createFailed'));
      });
  }

  function doDelete(id) {
    fetch(`/api/agents/${encodeURIComponent(id)}`, { method: 'DELETE' })
      .then((res) => res.json().then((data) => ({ ok: res.ok, data })))
      .then((result) => {
        if (!result.ok || !result.data.success) throw new Error((result.data && result.data.error) || t('common.unknownError'));
        if (selectedId === id) selectedId = null;
        editingId = null;
        window.Notification && window.Notification.success(t('agents.deleted'));
        notifyChanged();
        reload();
      })
      .catch((err) => {
        window.Notification && window.Notification.error(t('agents.deleteFailed', { message: err.message || '' }));
      });
  }

  function onRootClick(e) {
    const actionBtn = e.target.closest('[data-action]');
    if (actionBtn) {
      const action = actionBtn.getAttribute('data-action');
      if (action === 'create') {
        creating = true;
        editingId = null;
        paintDetail();
        return;
      }
      if (action === 'cancel') {
        creating = false;
        editingId = null;
        paintDetail();
        return;
      }
      if (action === 'edit') {
        editingId = selectedId;
        creating = false;
        paintDetail();
        return;
      }
      if (action === 'delete') {
        const agent = agentById(selectedId);
        if (!agent || !window.Modal) return;
        window.Modal.confirm({
          title: t('agents.deleteTitle'),
          message: t('agents.deleteBody', { name: agent.name }),
          type: 'danger',
          confirmText: t('common.delete'),
          cancelText: t('common.cancel'),
          dangerConfirm: true,
        }).then((ok) => { if (ok) doDelete(agent.id); });
      }
      return;
    }
    const card = e.target.closest('.skills-card');
    if (!card) return;
    selectedId = card.getAttribute('data-id');
    creating = false;
    editingId = null;
    renderList();
    paintDetail();
  }

  function onRootSubmit(e) {
    const form = e.target.closest('.agent-form');
    if (!form) return;
    e.preventDefault();
    save(form);
  }

  function destroy() {
    if (listFetchAbort) {
      listFetchAbort.abort();
      listFetchAbort = null;
    }
    containerEl = null;
    agents = [];
    selectedId = null;
    creating = false;
    editingId = null;
    busy = false;
  }

  function render(parentEl) {
    destroy();
    containerEl = parentEl;
    parentEl.innerHTML = '';
    const Tabs = window.KnowledgeTabs;
    if (Tabs) Tabs.remember('agents');
    const root = document.createElement('div');
    root.className = 'skills-root agents-root';
    const header = document.createElement('header');
    header.className = 'skills-header knowledge-header';
    header.innerHTML =
      '<div class="skills-header-text">' +
        '<h1 class="skills-title">' + t('nav.knowledge') + '</h1>' +
        '<p class="skills-hint">' + t('agents.hint') + '</p>' +
      '</div>' +
      '<div class="skills-header-actions">' +
        '<button type="button" class="skills-btn skills-btn-primary" data-action="create">' + t('agents.new') + '</button>' +
        '<span class="skills-count" id="agents-total-count">' + t('common.loadingPage') + '</span>' +
      '</div>' +
      (Tabs ? Tabs.html('agents') : '');
    if (Tabs) Tabs.bind(header);
    const main = document.createElement('main');
    main.className = 'skills-main';
    main.innerHTML =
      '<aside class="skills-list-panel">' +
        '<div class="skills-list-toolbar">' +
          '<button type="button" class="skills-btn skills-btn-primary" data-action="create">' + t('agents.new') + '</button>' +
        '</div>' +
        '<div class="skills-list" id="agents-list"></div>' +
      '</aside>' +
      '<section class="skills-detail-panel" id="agents-detail">' +
        `<div class="skills-detail-placeholder">${t('agents.placeholder')}</div>` +
      '</section>';
    root.appendChild(header);
    root.appendChild(main);
    parentEl.appendChild(root);
    root.addEventListener('click', onRootClick);
    root.addEventListener('submit', onRootSubmit);
    loadTools();
    reload();
  }

  return { render, destroy };
})();

if (typeof window !== 'undefined') {
  window.AgentsPage = AgentsPage;
}
