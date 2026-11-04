// @ts-nocheck
import { t } from './i18n.ts';
/**
 * 知识库 ·「技能」页签：列表、查看、新增简单技能、编辑与删除。
 * 带脚本的技能不在此创建，引导到聊天区使用「创建技能」。
 */

/* exported SkillsPage */

export const SkillsPage = (() => {

  const COMPLEX_SKILL_FILE = '创建技能.md';

  let containerEl = null;
  let allSkills = [];
  let selectedFilename = null;
  let listFetchAbort = null;
  let skillsChangedHandler = null;
  let creating = false;
  let editingFilename = null;
  let busy = false;
  /** 保存/创建后，移动端重新展开这张卡片 */
  let reopenFilename = null;
  /** @type {Record<string, { filename: string, content: string, meta: object }>} */
  let detailCache = {};

  function isMobile() {
    return window.innerWidth <= 720;
  }

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
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
        hour: '2-digit',
        minute: '2-digit',
      });
    } catch (_e) {
      return '—';
    }
  }

  function placeholderHtml() {
    return '<div class="skills-detail-placeholder">' + t('skills.placeholder') + '</div>';
  }

  function notifySkillsChanged() {
    if (window.ChatSkills && typeof window.ChatSkills.notifySkillsChanged === 'function') {
      window.ChatSkills.notifySkillsChanged();
    } else {
      window.dispatchEvent(new CustomEvent('ice-skills-changed'));
    }
  }

  function syncRootMode() {
    const root = containerEl && containerEl.querySelector('.skills-root');
    if (root) root.classList.toggle('is-composing', creating);
  }

  function findCard(filename) {
    if (!containerEl || !filename) return null;
    const cards = containerEl.querySelectorAll('.skills-card');
    for (let i = 0; i < cards.length; i++) {
      if (cards[i].getAttribute('data-filename') === filename) return cards[i];
    }
    return null;
  }

  function skillByFilename(filename) {
    for (let i = 0; i < allSkills.length; i++) {
      if (allSkills[i].filename === filename) return allSkills[i];
    }
    const cached = detailCache[filename];
    return {
      filename,
      name: (cached && cached.meta && cached.meta.name) || filename,
    };
  }

  function filenameFromAction(btn) {
    const card = btn.closest('.skills-card');
    if (card) return card.getAttribute('data-filename');
    return selectedFilename || editingFilename;
  }

  function destroy() {
    if (listFetchAbort) {
      listFetchAbort.abort();
      listFetchAbort = null;
    }
    if (skillsChangedHandler) {
      window.removeEventListener('ice-skills-changed', skillsChangedHandler);
      skillsChangedHandler = null;
    }
    containerEl = null;
    allSkills = [];
    selectedFilename = null;
    creating = false;
    editingFilename = null;
    busy = false;
    reopenFilename = null;
    detailCache = {};
  }

  function editorHtml(content) {
    return (
      `<textarea class="skills-detail-content skills-detail-editor">${escapeHtml(content || '')}</textarea>` +
      '<div class="skills-editor-foot">' +
        '<button type="button" class="skills-btn" data-action="cancel-edit">' + t('common.cancel') + '</button>' +
        '<button type="button" class="skills-btn skills-btn-primary" data-action="save-edit">' + t('common.save') + '</button>' +
      '</div>'
    );
  }

  function focusEditor(host) {
    const textarea = host && host.querySelector('.skills-detail-editor');
    if (!textarea) return;
    textarea.focus();
    const end = textarea.value.length;
    try { textarea.setSelectionRange(end, end); } catch (_e) { /* ignore */ }
  }

  function fillDetailHost(host, pack, editing) {
    if (!host) return;
    host.innerHTML = editing
      ? editorHtml(pack.content || '')
      : `<pre class="skills-detail-content">${escapeHtml(pack.content || '')}</pre>`;
    if (editing) focusEditor(host);
  }

  function paintDesktopDetail(pack) {
    const detailEl = containerEl && containerEl.querySelector('#skills-detail');
    if (!detailEl || !pack) return;
    const meta = pack.meta || {};
    const filename = pack.filename;
    const editing = editingFilename === filename;
    detailEl.innerHTML =
      '<div class="skills-detail-header">' +
        '<div class="skills-detail-title-row">' +
          `<h2 class="skills-detail-title">${escapeHtml(meta.name || filename)}</h2>` +
          `<span class="skills-detail-chip">#${escapeHtml(filename)}</span>` +
        '</div>' +
        `<p class="skills-detail-desc">${escapeHtml(meta.description || '')}</p>` +
        '<div class="skills-detail-actions">' +
          '<button type="button" class="skills-btn skills-btn-danger" data-action="delete">' + t('common.delete') + '</button>' +
          '<button type="button" class="skills-btn skills-btn-primary" data-action="use">' + t('skills.use') + '</button>' +
          `<button type="button" class="skills-btn${editing ? ' is-active' : ''}" data-action="edit">${t('common.edit')}</button>` +
        '</div>' +
      '</div>' +
      (editing
        ? editorHtml(pack.content || '')
        : `<pre class="skills-detail-content">${escapeHtml(pack.content || '')}</pre>`);
    if (editing) focusEditor(detailEl);
  }

  function renderSkillList(listEl, countEl) {
    if (!listEl) return;
    listEl.innerHTML = '';
    if (countEl) countEl.textContent = t('skills.count', { n: allSkills.length });

    if (!allSkills.length) {
      listEl.innerHTML = '<div class="skills-empty">' + t('skills.empty') + '</div>';
      return;
    }

    for (let i = 0; i < allSkills.length; i++) {
      ((sk) => {
        const card = document.createElement('div');
        card.className = 'skills-card' + (sk.filename === selectedFilename ? ' is-active' : '');
        card.setAttribute('data-filename', sk.filename);
        card.tabIndex = 0;
        const editing = editingFilename === sk.filename;
        card.innerHTML =
          `<div class="skills-card-head"><span class="skills-card-name">${escapeHtml(sk.name || sk.filename)}</span><span class="skills-card-file">#${escapeHtml(sk.filename)}</span></div>` +
          `<p class="skills-card-desc">${escapeHtml(sk.description || t('skills.noDesc'))}</p>` +
          `<div class="skills-card-meta">${escapeHtml(t('skills.updated', { time: formatZhIso(sk.modifiedAt) }))}</div>` +
          '<div class="skills-card-actions">' +
            '<button type="button" class="skills-btn skills-btn-danger" data-action="delete">' + t('skills.deleteSkill') + '</button>' +
            '<button type="button" class="skills-btn skills-btn-primary" data-action="use">' + t('skills.useSkill') + '</button>' +
            `<button type="button" class="skills-btn${editing ? ' is-active' : ''}" data-action="edit">${t('common.edit')}</button>` +
          '</div>';

        card.addEventListener('click', (e) => {
          if (e.target.closest('[data-action], .skills-card-detail, .skills-field-input, .skills-detail-editor')) return;
          if (isMobile()) toggleSkillExpand(card, sk);
          else selectSkill(sk.filename);
        });
        card.addEventListener('keydown', (e) => {
          if (e.target !== card) return;
          if (e.key !== 'Enter' && e.key !== ' ') return;
          e.preventDefault();
          if (isMobile()) toggleSkillExpand(card, sk);
          else selectSkill(sk.filename);
        });
        listEl.appendChild(card);
      })(allSkills[i]);
    }
  }

  function rerenderList() {
    if (!containerEl) return;
    renderSkillList(
      containerEl.querySelector('#skills-list'),
      containerEl.querySelector('#skills-total-count'),
    );
  }

  function selectSkill(filename) {
    if (busy) return;
    if (creating) {
      creating = false;
      syncRootMode();
    }
    if (editingFilename && editingFilename !== filename) editingFilename = null;
    if (selectedFilename === filename && editingFilename === filename) return;
    selectedFilename = filename;
    rerenderList();
    loadSkillDetail(filename);
  }

  function collapseSkillCard(card) {
    card.classList.remove('is-expanded');
    const old = card.querySelector('.skills-card-detail');
    if (old) old.remove();
    const editBtn = card.querySelector('[data-action="edit"]');
    if (editBtn) editBtn.classList.remove('is-active');
    if (editingFilename && card.getAttribute('data-filename') === editingFilename) {
      editingFilename = null;
    }
  }

  function toggleSkillExpand(card, sk) {
    const wasExpanded = card.classList.contains('is-expanded');
    const expanded = containerEl.querySelectorAll('.skills-card.is-expanded');
    for (let i = 0; i < expanded.length; i++) {
      if (expanded[i] === card) continue;
      collapseSkillCard(expanded[i]);
    }
    if (wasExpanded) {
      collapseSkillCard(card);
      return;
    }
    card.classList.add('is-expanded');
    const detailDiv = document.createElement('div');
    detailDiv.className = 'skills-card-detail';
    detailDiv.innerHTML = '<div class="skills-detail-loading">' + t('common.loadingPage') + '</div>';
    card.appendChild(detailDiv);
    const cached = detailCache[sk.filename];
    if (cached) {
      fillDetailHost(detailDiv, cached, editingFilename === sk.filename);
    }
    fetch(`/api/skills/${encodeURIComponent(sk.filename)}`)
      .then((res) => res.json())
      .then((body) => {
        if (!body.success) throw new Error(body.error || t('common.loadFailed'));
        if (!card.classList.contains('is-expanded')) return;
        const pack = {
          filename: sk.filename,
          content: body.content || '',
          meta: body.meta || {},
        };
        detailCache[sk.filename] = pack;
        const keepDraft = editingFilename === sk.filename && detailDiv.querySelector('.skills-detail-editor');
        if (!keepDraft) fillDetailHost(detailDiv, pack, editingFilename === sk.filename);
        const editBtn = card.querySelector('[data-action="edit"]');
        if (editBtn) editBtn.classList.toggle('is-active', editingFilename === sk.filename);
      })
      .catch((err) => {
        if (!card.classList.contains('is-expanded')) return;
        if (detailDiv.querySelector('.skills-detail-content, .skills-detail-editor')) return;
        detailDiv.innerHTML = `<div class="skills-detail-error">${escapeHtml(t('skills.loadFailed', { message: err.message || t('common.unknownError') }))}</div>`;
      });
  }

  function confirmDeleteSkill(sk) {
    const name = sk.name || sk.filename;
    window.Modal.confirm({
      title: t('skills.deleteTitle'),
      message: t('skills.deleteBody', { name }),
      type: 'danger',
      confirmText: t('common.delete'),
      cancelText: t('common.cancel'),
      dangerConfirm: true,
    }).then((ok) => {
      if (ok) doDelete(sk.filename);
    });
  }

  function navigateToChatComposer() {
    const router = window.AppRouter;
    if (router && typeof router.getShell === 'function' && router.getShell() === 'mobile') {
      if (typeof router.navigate === 'function') {
        router.navigate('work');
      }
      return;
    }
    const targetHash = '#/chat';
    if (window.location.hash !== targetHash) {
      window.location.hash = targetHash;
    } else {
      window.dispatchEvent(new HashChangeEvent('hashchange'));
    }
  }

  function focusChatInputSoon() {
    setTimeout(() => {
      const input = document.getElementById('chat-input');
      if (input) input.focus();
    }, 0);
  }

  function prefillChatDraft(text) {
    let tries = 0;
    const tick = () => {
      const input = document.getElementById('chat-input');
      if (input) {
        if (!String(input.value || '').trim()) {
          input.value = text;
          input.dispatchEvent(new Event('input', { bubbles: true }));
        }
        input.focus();
        return;
      }
      tries += 1;
      if (tries < 20) setTimeout(tick, 50);
    };
    setTimeout(tick, 0);
  }

  function useSkillAction(sk) {
    if (window.ChatSkills && typeof window.ChatSkills.useSkill === 'function') {
      window.ChatSkills.useSkill(sk.filename);
    }
    navigateToChatComposer();
    focusChatInputSoon();
  }

  function openChatForComplexSkill() {
    if (window.ChatSkills && typeof window.ChatSkills.useSkill === 'function') {
      window.ChatSkills.useSkill(COMPLEX_SKILL_FILE);
    }
    navigateToChatComposer();
    prefillChatDraft('创建');
  }

  function loadSkillDetail(filename) {
    const detailEl = containerEl && containerEl.querySelector('#skills-detail');
    if (!detailEl || creating) return;
    detailEl.innerHTML = '<div class="skills-detail-loading">' + t('common.loadingPage') + '</div>';

    fetch(`/api/skills/${encodeURIComponent(filename)}`)
      .then((res) => res.json().then((body) => ({ ok: res.ok, body })))
      .then((out) => {
        if (!containerEl || creating || selectedFilename !== filename) return;
        if (!out.ok || !out.body.success) {
          throw new Error((out.body && out.body.error) || t('skills.readFailed'));
        }
        const pack = {
          filename,
          content: out.body.content || '',
          meta: out.body.meta || {},
        };
        detailCache[filename] = pack;
        paintDesktopDetail(pack);
      })
      .catch((err) => {
        if (!containerEl || creating || selectedFilename !== filename) return;
        detailEl.innerHTML =
          `<div class="skills-detail-error">${escapeHtml(t('skills.loadFailed', { message: err.message || t('common.unknownError') }))}</div>`;
      });
  }

  function beginEdit(filename) {
    if (!filename || busy) return;
    if (creating) {
      creating = false;
      syncRootMode();
    }
    editingFilename = filename;
    if (isMobile()) {
      const card = findCard(filename);
      const sk = skillByFilename(filename);
      if (!card || !sk) return;
      const editBtn = card.querySelector('[data-action="edit"]');
      if (editBtn) editBtn.classList.add('is-active');
      if (!card.classList.contains('is-expanded')) {
        toggleSkillExpand(card, sk);
        return;
      }
      const cached = detailCache[filename];
      const detailDiv = card.querySelector('.skills-card-detail');
      if (detailDiv && cached) fillDetailHost(detailDiv, cached, true);
      return;
    }
    selectedFilename = filename;
    rerenderList();
    const cached = detailCache[filename];
    if (cached) paintDesktopDetail(cached);
    else loadSkillDetail(filename);
  }

  function cancelEdit() {
    const filename = editingFilename;
    editingFilename = null;
    if (!filename) return;
    const cached = detailCache[filename];
    if (isMobile()) {
      const card = findCard(filename);
      const detailDiv = card && card.querySelector('.skills-card-detail');
      if (detailDiv && cached) fillDetailHost(detailDiv, cached, false);
      const editBtn = card && card.querySelector('[data-action="edit"]');
      if (editBtn) editBtn.classList.remove('is-active');
      return;
    }
    if (cached) paintDesktopDetail(cached);
  }

  function saveEdit(filename) {
    if (busy || !filename || !containerEl) return;
    const host = isMobile() ? findCard(filename) : containerEl.querySelector('#skills-detail');
    const textarea = host && host.querySelector('.skills-detail-editor');
    if (!textarea) return;
    const content = textarea.value;
    if (!String(content).trim()) {
      if (window.Notification) Notification.error(t('skills.emptyContent'));
      textarea.focus();
      return;
    }
    busy = true;
    fetch(`/api/skills/${encodeURIComponent(filename)}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ content }),
    })
      .then((res) => res.json().then((body) => ({ ok: res.ok, body })))
      .then((out) => {
        if (!out.ok || !out.body.success) {
          throw new Error((out.body && out.body.error) || t('common.saveFailed'));
        }
        editingFilename = null;
        selectedFilename = filename;
        if (isMobile()) reopenFilename = filename;
        if (detailCache[filename]) {
          detailCache[filename].content = out.body.content || content;
          if (out.body.meta) detailCache[filename].meta = out.body.meta;
        }
        if (window.Notification) Notification.success(t('skills.saved'));
        notifySkillsChanged();
        reloadSkills();
      })
      .catch((err) => {
        if (window.Notification) Notification.error(err.message || t('common.saveFailed'));
      })
      .finally(() => { busy = false; });
  }

  function createFormHtml() {
    return (
      '<div class="skills-detail-header">' +
        '<h2 class="skills-detail-title">' + t('skills.newTitle') + '</h2>' +
        '<p class="skills-detail-desc">' + t('skills.newDesc') + '</p>' +
      '</div>' +
      '<div class="skills-create-note">' +
        '<p>' + t('skills.simpleOnly') + '</p>' +
        '<button type="button" class="skills-btn" data-action="create-via-chat">' + t('skills.createInChat') + '</button>' +
      '</div>' +
      '<form class="skills-form" id="skills-create-form">' +
        '<label class="skills-field">' +
          '<span class="skills-field-label">' + t('skills.folder') + '</span>' +
          '<input class="skills-field-input" id="skills-new-folder" name="folder" type="text" maxlength="80" placeholder="' + t('skills.folderPh') + '" autocomplete="off" />' +
        '</label>' +
        '<label class="skills-field">' +
          '<span class="skills-field-label">' + t('skills.name') + '</span>' +
          '<input class="skills-field-input" id="skills-new-name" name="name" type="text" maxlength="80" placeholder="' + t('skills.namePh') + '" autocomplete="off" />' +
        '</label>' +
        '<label class="skills-field">' +
          '<span class="skills-field-label">' + t('skills.content') + '</span>' +
          '<textarea class="skills-detail-content skills-detail-editor" id="skills-new-content" name="content" placeholder="' + t('skills.contentPh') + '"></textarea>' +
        '</label>' +
        '<div class="skills-editor-foot">' +
          '<button type="button" class="skills-btn" data-action="cancel-create">' + t('common.cancel') + '</button>' +
          '<button type="submit" class="skills-btn skills-btn-primary" data-action="save-create">' + t('common.save') + '</button>' +
        '</div>' +
      '</form>'
    );
  }

  function startCreate() {
    if (busy || !containerEl) return;
    if (creating) {
      const nameEl = containerEl.querySelector('#skills-new-name');
      if (nameEl) nameEl.focus();
      return;
    }
    creating = true;
    editingFilename = null;
    selectedFilename = null;
    syncRootMode();
    rerenderList();
    const detailEl = containerEl.querySelector('#skills-detail');
    if (detailEl) detailEl.innerHTML = createFormHtml();
    const folderEl = containerEl.querySelector('#skills-new-folder');
    if (folderEl) folderEl.focus();
  }

  function cancelCreate() {
    creating = false;
    syncRootMode();
    const detailEl = containerEl && containerEl.querySelector('#skills-detail');
    if (selectedFilename) {
      loadSkillDetail(selectedFilename);
      return;
    }
    if (detailEl) detailEl.innerHTML = placeholderHtml();
  }

  function submitCreate() {
    if (busy || !creating || !containerEl) return;
    const folderEl = containerEl.querySelector('#skills-new-folder');
    const nameEl = containerEl.querySelector('#skills-new-name');
    const contentEl = containerEl.querySelector('#skills-new-content');
    const folder = folderEl ? folderEl.value.trim() : '';
    const name = nameEl ? nameEl.value.trim() : '';
    const content = contentEl ? contentEl.value : '';
    if (!name) {
      if (window.Notification) Notification.error(t('skills.nameRequired'));
      if (nameEl) nameEl.focus();
      return;
    }
    if (!String(content).trim()) {
      if (window.Notification) Notification.error(t('skills.contentRequired'));
      if (contentEl) contentEl.focus();
      return;
    }
    busy = true;
    fetch('/api/skills', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ folder, name, content }),
    })
      .then((res) => res.json().then((body) => ({ ok: res.ok, body })))
      .then((out) => {
        if (!out.ok || !out.body.success) {
          throw new Error((out.body && out.body.error) || t('skills.createFailed'));
        }
        creating = false;
        editingFilename = null;
        selectedFilename = out.body.filename;
        if (isMobile()) reopenFilename = out.body.filename;
        syncRootMode();
        if (window.Notification) Notification.success(t('skills.created'));
        notifySkillsChanged();
        reloadSkills();
      })
      .catch((err) => {
        if (window.Notification) Notification.error(err.message || t('skills.createFailed'));
      })
      .finally(() => { busy = false; });
  }

  function doDelete(filename) {
    fetch(`/api/skills/${encodeURIComponent(filename)}`, { method: 'DELETE' })
      .then((res) => res.json().then((body) => ({ ok: res.ok, body })))
      .then((out) => {
        if (!out.ok || !out.body.success) {
          throw new Error((out.body && out.body.error) || t('common.deleteFailed'));
        }
        if (window.Notification) Notification.success(t('skills.deleted'));
        delete detailCache[filename];
        if (editingFilename === filename) editingFilename = null;
        if (selectedFilename === filename) selectedFilename = null;
        notifySkillsChanged();
        reloadSkills();
      })
      .catch((err) => {
        if (window.Notification) Notification.error(t('skills.deleteFailed', { message: err.message || t('common.unknownError') }));
      });
  }

  function onRootClick(e) {
    const btn = e.target.closest('[data-action]');
    if (!btn || !containerEl || !containerEl.contains(btn)) return;
    const action = btn.getAttribute('data-action');
    if (action === 'create') {
      startCreate();
      return;
    }
    if (action === 'cancel-create') {
      cancelCreate();
      return;
    }
    if (action === 'create-via-chat') {
      openChatForComplexSkill();
      return;
    }
    if (action === 'save-create') return;
    const filename = filenameFromAction(btn);
    if (action === 'delete') {
      if (filename) confirmDeleteSkill(skillByFilename(filename));
      return;
    }
    if (action === 'use') {
      if (filename) useSkillAction(skillByFilename(filename));
      return;
    }
    if (action === 'edit') {
      if (filename) beginEdit(filename);
      return;
    }
    if (action === 'cancel-edit') {
      cancelEdit();
      return;
    }
    if (action === 'save-edit') saveEdit(filename || editingFilename);
  }

  function onRootSubmit(e) {
    if (!e.target || e.target.id !== 'skills-create-form') return;
    e.preventDefault();
    submitCreate();
  }

  function reloadSkills() {
    if (!containerEl) return;
    const listEl = containerEl.querySelector('#skills-list');
    const countEl = containerEl.querySelector('#skills-total-count');
    const detailEl = containerEl.querySelector('#skills-detail');

    if (listFetchAbort) listFetchAbort.abort();
    listFetchAbort = new AbortController();

    if (countEl && !creating && !editingFilename) countEl.textContent = t('common.loadingPage');
    fetch('/api/skills', { signal: listFetchAbort.signal })
      .then((res) => res.json())
      .then((body) => {
        if (!body.success) throw new Error(body.error || t('common.loadFailed'));
        allSkills = body.skills || [];
        if (countEl) countEl.textContent = t('skills.count', { n: allSkills.length });
        if (creating || editingFilename) return;
        renderSkillList(listEl, countEl);
        if (reopenFilename && isMobile()) {
          const fn = reopenFilename;
          reopenFilename = null;
          const card = findCard(fn);
          const sk = skillByFilename(fn);
          if (card && sk) toggleSkillExpand(card, sk);
        } else {
          reopenFilename = null;
        }
        if (selectedFilename) {
          loadSkillDetail(selectedFilename);
        } else if (detailEl && !creating) {
          detailEl.innerHTML = placeholderHtml();
        }
      })
      .catch((err) => {
        if (err && err.name === 'AbortError') return;
        if (countEl) countEl.textContent = t('common.loadFailed');
        if (listEl && !creating && !editingFilename) {
          listEl.innerHTML =
            `<div class="skills-empty">${escapeHtml(t('skills.loadFailed', { message: err.message || t('common.unknownError') }))}</div>`;
        }
      });
  }

  function render(parentEl) {
    destroy();
    containerEl = parentEl;
    parentEl.innerHTML = '';
    const Tabs = window.KnowledgeTabs;
    if (Tabs) Tabs.remember('skills');

    const root = document.createElement('div');
    root.className = 'skills-root';

    const header = document.createElement('header');
    header.className = 'skills-header knowledge-header';
    header.innerHTML =
      '<div class="skills-header-text">' +
        '<h1 class="skills-title">' + t('nav.knowledge') + '</h1>' +
        '<p class="skills-hint">' + t('skills.hint') + '</p>' +
      '</div>' +
      '<div class="skills-header-actions">' +
        '<button type="button" class="skills-btn skills-btn-primary" data-action="create">' + t('skills.new') + '</button>' +
        '<span class="skills-count" id="skills-total-count">' + t('common.loadingPage') + '</span>' +
      '</div>' +
      (Tabs ? Tabs.html('skills') : '');
    if (Tabs) Tabs.bind(header);

    const main = document.createElement('main');
    main.className = 'skills-main';
    main.innerHTML =
      '<aside class="skills-list-panel" id="skills-list-panel">' +
        '<div class="skills-list-toolbar">' +
          '<button type="button" class="skills-btn skills-btn-primary" data-action="create">' + t('skills.new') + '</button>' +
        '</div>' +
        '<div class="skills-list" id="skills-list"></div>' +
      '</aside>' +
      '<section class="skills-detail-panel" id="skills-detail">' +
        placeholderHtml() +
      '</section>';

    root.appendChild(header);
    root.appendChild(main);
    parentEl.appendChild(root);
    root.addEventListener('click', onRootClick);
    root.addEventListener('submit', onRootSubmit);

    skillsChangedHandler = function () { reloadSkills(); };
    window.addEventListener('ice-skills-changed', skillsChangedHandler);

    reloadSkills();
  }

  return {
    render,
    destroy,
  };
})();

if (typeof window !== 'undefined') {
  window.SkillsPage = SkillsPage;
}
