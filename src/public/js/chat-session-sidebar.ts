// @ts-nocheck
import { t } from './i18n.ts';
/**
 * 会话侧栏组件
 * 职责：侧栏 DOM 创建与渲染、会话列表、新建按钮、编辑标题、选中高亮
 * 任务会话和普通会话同一条按时间排列，任务用条目标记区分。
 * 会话行左键只打开会话；右键或「…」打开菜单（重命名 / 选择 / 删除）。
 * 「选择」进入多选，顶部计数、底部删除，可批量删除。
 * 侧栏全站固定常驻，无窄屏抽屉/折叠
 */

/* exported ChatSessionSidebar */

export const ChatSessionSidebar = (() => {

  const Store = window.ChatSessionStore;
  let sidebar = null;
  let selectMode = false;
  let selectEscapeBound = false;
  const selectedIds = new Set();
  let nicknameEditing = false;
  const NICKNAME_KEY = 'ice-sidebar-nickname';

  function ic(name, width) {
    return window.AppIcon ? window.AppIcon.html(name, { width: width || 14 }) : '';
  }

  function compactPath(p) {
    const norm = String(p || '').replace(/\\/g, '/');
    const parts = norm.split('/').filter((x) =>  x && x !== '.');
    if (parts.length <= 2) return p || '';
    return `…/${parts.slice(-2).join('/')}`;
  }

  function fullWorkspacePath(sessionId) {
    const root = Store.getSessionWorkspace ? Store.getSessionWorkspace(sessionId) : '';
    const def = Store.getDefaultWorkDir ? Store.getDefaultWorkDir() : '';
    return root || def || '';
  }

  /** 销毁侧栏 DOM（仅重建时调用；切页不销毁，侧栏挂在 app-shell 上常驻） */
  function destroy() {
    closeMenu();
    selectMode = false;
    selectedIds.clear();
    nicknameEditing = false;
    if (sidebar) {
      sidebar.remove();
      sidebar = null;
    }
  }

  /** 创建侧栏 DOM（插入到 .app-shell 内、.app-main 之前，全站常驻） */
  function create(shellEl) {
    if (sidebar && sidebar.isConnected) return sidebar;
    destroy();

    const host = shellEl || document.querySelector('.app-shell');
    if (!host) return null;

    sidebar = document.createElement('aside');
    sidebar.className = 'chat-session-sidebar';
    sidebar.innerHTML =
      `<div class="chat-sidebar-brand"><span class="chat-sidebar-brand-icon ice-brand-logo" aria-hidden="true"></span><span class="chat-sidebar-brand-logo">IceCoder</span></div>` +
      `<nav class="chat-sidebar-nav" role="tablist" aria-label="${t('nav.primary')}"><button class="chat-sidebar-nav-btn" data-page="chat" role="tab" aria-selected="true"><span class="chat-sidebar-nav-btn-icon" aria-hidden="true">${ic('work')}</span><span class="chat-sidebar-nav-btn-label">${t('nav.work')}</span></button><button class="chat-sidebar-nav-btn" data-page="tasks" role="tab" aria-selected="false"><span class="chat-sidebar-nav-btn-icon" aria-hidden="true">${ic('tasks')}</span><span class="chat-sidebar-nav-btn-label">${t('nav.tasks')}</span></button><button class="chat-sidebar-nav-btn" data-page="knowledge" role="tab" aria-selected="false"><span class="chat-sidebar-nav-btn-icon" aria-hidden="true">${ic('knowledge')}</span><span class="chat-sidebar-nav-btn-label">${t('nav.knowledge')}</span></button><button class="chat-sidebar-nav-btn" data-page="stats" role="tab" aria-selected="false"><span class="chat-sidebar-nav-btn-icon" aria-hidden="true">${ic('stats')}</span><span class="chat-sidebar-nav-btn-label">${t('nav.usage')}</span></button></nav>` +
      `<div class="chat-sidebar-header"><button class="chat-sidebar-new-btn" title="${t('session.newChat')}"><span class="chat-sidebar-new-btn-icon" aria-hidden="true">${ic('plus', 14)}</span><span class="chat-sidebar-new-btn-label">${t('session.newChat')}</span></button><div class="chat-sidebar-header-top"><span class="chat-sidebar-title">${t('nav.sessions')}</span><button class="chat-sidebar-search-btn" type="button" title="${t('session.search')}" aria-label="${t('session.search')}" aria-expanded="false">${ic('search', 14)}</button></div></div>` +
      `<div class="chat-sidebar-search" hidden><span class="chat-sidebar-search-icon" aria-hidden="true">${ic('search', 13)}</span><input class="chat-sidebar-search-input" type="search" placeholder="${t('session.searchPlaceholder')}" aria-label="${t('session.searchPlaceholder')}" autocomplete="off" spellcheck="false"></div>` +
      `<div class="chat-sidebar-selectbar" hidden><span class="chat-sidebar-selectbar-text">${t('session.selected', { n: 0 })}</span><button type="button" class="chat-sidebar-selectbar-close" aria-label="${t('session.exitSelect')}">×</button></div>` +
      `<div class="chat-sidebar-list"></div>` +
      `<div class="chat-sidebar-batchbar" hidden><button type="button" class="chat-sidebar-batch-delete" disabled><span class="chat-sidebar-batch-delete-icon" aria-hidden="true">${ic('trash', 14)}</span><span>${t('common.delete')}</span></button></div>` +
      `<div class="chat-sidebar-footer"><button class="chat-sidebar-control chat-sidebar-settings-btn" type="button" title="${t('nav.settings')}" aria-label="${t('nav.settings')}"><span class="chat-sidebar-user-avatar" aria-hidden="true"><svg viewBox="0 0 16 16" fill="none" aria-hidden="true"><circle cx="8" cy="5.35" r="2.65" stroke="currentColor" stroke-width="1.45"/><path d="M2.7 14.15a5.3 5.3 0 0 1 10.6 0" stroke="currentColor" stroke-width="1.45" stroke-linecap="round"/></svg></span><span class="chat-sidebar-user-meta"><span class="chat-sidebar-user-name" title="${t('session.nicknameTip')}"></span><span class="chat-sidebar-control-label">${t('nav.settings')}</span></span><span class="chat-sidebar-control-icon" aria-hidden="true">${ic('settings', 16)}</span></button></div>`;

    const mainEl = host.querySelector('.app-main');
    if (mainEl) {
      host.insertBefore(sidebar, mainEl);
    } else {
      host.insertBefore(sidebar, host.firstChild);
    }
    bindEvents();
    if (window.AppIcon) window.AppIcon.hydrate(sidebar);
    bindSidebarResizer();
    Store.fetchSessions(() => { renderList(); });
    return sidebar;
  }

  function getRouteFromHash() {
    const h = String(window.location.hash || '').replace(/^#\/?/, '').split('/')[0];
    if (h === 'chat' || h === 'memory' || h === 'skills' || h === 'rules' || h === 'tasks' || h === 'todos' || h === 'stats' || h === 'settings' || h === 'config') {
      return h === 'config' ? 'settings' : h;
    }
    if (h === 'knowledge') return 'skills';
    return 'chat';
  }

  /** 技能、记忆、规则三个路由同属「知识库」导航项。待办和定时同属「任务」。 */
  function navPageForRoute(route) {
    if (route === 'skills' || route === 'memory' || route === 'rules') return 'knowledge';
    if (route === 'todos') return 'tasks';
    return route;
  }

  /** 任务 / 知识库 / 统计 / 设置：会话列表不当作当前页，点会话回到聊天 */
  function isAuxiliaryNavPage() {
    const route = getRouteFromHash();
    return route === 'memory' || route === 'skills' || route === 'rules' || route === 'tasks' || route === 'todos' || route === 'stats' || route === 'settings';
  }

  function navigateToChatPage() {
    if (window.location.hash !== '#/chat') {
      window.location.hash = '#/chat';
    }
  }

  function syncSidebarSettingsActive() {
    if (!sidebar) return;
    const btn = sidebar.querySelector('.chat-sidebar-settings-btn');
    if (!btn) return;
    const onSettings = getRouteFromHash() === 'settings';
    btn.classList.toggle('is-active', onSettings);
    if (onSettings) btn.setAttribute('aria-current', 'page');
    else btn.removeAttribute('aria-current');
  }

  function syncSidebarNavActive() {
    if (!sidebar) return;
    const current = navPageForRoute(getRouteFromHash());
    const btns = sidebar.querySelectorAll('.chat-sidebar-nav-btn');
    for (let i = 0; i < btns.length; i++) {
      const btn = btns[i];
      const page = btn.getAttribute('data-page');
      const on = page === current;
      btn.classList.toggle('is-active', on);
      btn.setAttribute('aria-selected', on ? 'true' : 'false');
    }
    syncSidebarSettingsActive();
  }

  function bindEvents() {
    sidebar.querySelector('.chat-sidebar-new-btn').addEventListener('click', () => {
      Store.createSession('新会话', (session) => {
        if (session) {
          revealSession(session.id);
          selectSession(session.id);
        }
      });
    });

    bindSearch();

    const navBtns = sidebar.querySelectorAll('.chat-sidebar-nav-btn');
    for (let i = 0; i < navBtns.length; i++) {
      ((btn) => {
        btn.addEventListener('click', () => {
          const page = btn.getAttribute('data-page');
          if (!page) return;
          if (page === 'knowledge' && window.KnowledgeTabs) {
            window.KnowledgeTabs.open();
            return;
          }
          if (page === 'tasks' && window.TaskTabs) {
            window.TaskTabs.open();
            return;
          }
          if (window.location.hash !== `#/${page}`) {
            window.location.hash = `#/${page}`;
          } else {
            // 已经在该路由：仍触发一次 hashchange 监听器，保持行为一致
            window.dispatchEvent(new HashChangeEvent('hashchange'));
          }
        });
      })(navBtns[i]);
    }
    syncSidebarNavActive();
    window.addEventListener('hashchange', () => {
      syncSidebarNavActive();
      renderList();
    });

    bindShellControls();
    bindShellCollabWs();
    bindSelectChrome();
    bindMenuDismiss();

    Store.onChange(() => { renderList(); });
  }

  function notifyShellCollabUpdated(data) {
    if (!data) return;
    if (data.shellCollabActiveBySession && Store.applyShellCollabActiveMap) {
      Store.applyShellCollabActiveMap(data.shellCollabActiveBySession);
    } else {
      const sid = data.sessionId;
      if (sid && typeof data.shellCollabActive === 'boolean' && Store.setShellCollabActive) {
        Store.setShellCollabActive(sid, data.shellCollabActive);
      }
    }
    renderList();
  }

  function bindShellCollabWs() {
    const WS = window.ChatWebSocket;
    if (!WS || WS.__shellCollabSidebarBound) return;
    WS.__shellCollabSidebarBound = true;
    WS.on('connected', notifyShellCollabUpdated);
    WS.on('shell_collab_entered', notifyShellCollabUpdated);
  }

  function bindShellControls() {
    syncSidebarSettingsActive();

    const settingsBtn = sidebar.querySelector('.chat-sidebar-settings-btn');
    if (settingsBtn) {
      settingsBtn.addEventListener('click', (e) => {
        if (e.target.closest('.chat-sidebar-user-name-input')) return;
        if (window.location.hash !== '#/settings') {
          window.location.hash = '#/settings';
        } else {
          window.dispatchEvent(new HashChangeEvent('hashchange'));
        }
      });
      settingsBtn.addEventListener('contextmenu', (e) => {
        e.preventDefault();
        beginNicknameEdit();
      });
    }
    renderProfile();
  }

  function bindSelectChrome() {
    const closeBtn = sidebar.querySelector('.chat-sidebar-selectbar-close');
    const batchBtn = sidebar.querySelector('.chat-sidebar-batch-delete');
    const list = sidebar.querySelector('.chat-sidebar-list');
    if (closeBtn) closeBtn.addEventListener('click', () => { exitSelectMode(); });
    if (batchBtn) {
      batchBtn.addEventListener('click', () => {
        if (!selectedIds.size) return;
        deleteSessions(Array.from(selectedIds));
      });
    }
    if (list) list.addEventListener('scroll', () => { closeMenu(); }, { passive: true });
  }

  function bindMenuDismiss() {
    if (selectEscapeBound) return;
    selectEscapeBound = true;
    document.addEventListener('keydown', (e) => {
      if (e.key !== 'Escape') return;
      if (window.Menu && window.Menu.isOpen()) return;
      if (selectMode && !nicknameEditing) exitSelectMode();
    });
  }

  function basename(p) {
    if (!p) return '';
    const norm = String(p).replace(/\\/g, '/');
    const parts = norm.split('/').filter((x) =>  x && x !== '.');
    return parts.length ? parts[parts.length - 1] : (p || '');
  }

  function renderWorkspaceFooter() {
    if (!sidebar) return;
    const activeId = Store.getActiveSessionId();
    const root = fullWorkspacePath(activeId);
    const nameEl = sidebar.querySelector('.chat-sidebar-workspace-name');
    const pathEl = sidebar.querySelector('.chat-sidebar-workspace-path');
    if (nameEl) nameEl.textContent = basename(root) || 'IceCoder';
    if (pathEl) {
      const home = Store.getDefaultWorkDir ? Store.getDefaultWorkDir() : '';
      if (root && home) {
        const normRoot = String(root).replace(/\\/g, '/');
        const normHome = String(home).replace(/\\/g, '/');
        let rel;
        if (normRoot.toLowerCase() === normHome.toLowerCase()) {
          rel = '~';
        } else if (normRoot.toLowerCase().startsWith(`${normHome.toLowerCase()}/`)) {
          rel = `~/${normRoot.slice(normHome.length + 1)}`;
        } else {
          rel = compactPath(root);
        }
        pathEl.textContent = rel;
        pathEl.title = root;
      } else {
        pathEl.textContent = '';
        pathEl.removeAttribute('title');
      }
    }
  }

  const TASK_TITLE_PREFIX = '定时任务：';

  /**
   * 只按标题在本地过滤：消息正文在服务端逐会话存盘（任务会话可达 20 MB），
   * 全文搜索要读遍所有会话文件，会拖慢正在流式输出的回合。
   */
  let searchKeyword = '';

  function matchesSearch(s) {
    return !searchKeyword || String(s.title || t('session.untitled')).toLowerCase().indexOf(searchKeyword) !== -1;
  }

  function setSearchKeyword(value) {
    const next = String(value || '').trim().toLowerCase();
    if (next === searchKeyword) return;
    searchKeyword = next;
    renderList();
  }

  function setSearchOpen(open) {
    if (!sidebar) return;
    const box = sidebar.querySelector('.chat-sidebar-search');
    const btn = sidebar.querySelector('.chat-sidebar-search-btn');
    const input = sidebar.querySelector('.chat-sidebar-search-input');
    if (!box || !input) return;
    box.hidden = !open;
    if (btn) {
      btn.setAttribute('aria-expanded', open ? 'true' : 'false');
      btn.classList.toggle('is-active', open);
    }
    if (open) {
      input.focus();
      return;
    }
    input.value = '';
    setSearchKeyword('');
  }

  function isSearchOpen() {
    const box = sidebar && sidebar.querySelector('.chat-sidebar-search');
    return !!box && !box.hidden;
  }

  function bindSearch() {
    const btn = sidebar.querySelector('.chat-sidebar-search-btn');
    const input = sidebar.querySelector('.chat-sidebar-search-input');
    if (!btn || !input) return;
    btn.addEventListener('click', () => { setSearchOpen(!isSearchOpen()); });
    input.addEventListener('input', () => { setSearchKeyword(input.value); });
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        setSearchOpen(false);
      }
    });
  }

  /** 「新建会话」「打开会话」等显式跳转时调用。搜索中会先退出搜索，会话出现在同一条列表里。 */
  function revealSession(sessionId) {
    if (isSearchOpen()) setSearchOpen(false);
    else renderList();
    return sessionId;
  }

  function taskStateOf(sessionId) {
    return Store.getScheduledTaskSession ? Store.getScheduledTaskSession(sessionId) : null;
  }

  function formatClock(ts) {
    const d = new Date(Number(ts));
    const hm = `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
    if (d.toDateString() === new Date().toDateString()) return hm;
    return `${d.getMonth() + 1}/${d.getDate()} ${hm}`;
  }

  /** 任务会话 meta 行文案；状态未知时返回 null（回退为相对时间） */
  function describeTaskSession(st) {
    if (!st) return null;
    if (st.state === 'deleted') return { text: t('session.taskDeleted'), error: false };
    if (st.state === 'history') return { text: t('session.history'), error: false };
    if (st.state !== 'current') return null;
    const failed = st.lastStatus === 'error';
    const parts = [];
    if (failed) parts.push(t('session.lastFailed'));
    if (!st.enabled) parts.push(t('session.disabled'));
    else if (st.nextRunAt) parts.push(t('session.nextRun', { time: formatClock(st.nextRunAt) }));
    return parts.length ? { text: parts.join(' · '), error: failed } : null;
  }

  function displayTitle(s, isTask) {
    const title = s.title || t('session.untitled');
    if (!isTask || title.indexOf(TASK_TITLE_PREFIX) !== 0) return title;
    return title.slice(TASK_TITLE_PREFIX.length) || title;
  }

  /** 任务会话用一枚小标记区分，不再单独折叠成组。状态写在标记上，时间放进提示。 */
  function taskChip(st) {
    if (!st) return null;
    const described = describeTaskSession(st);
    const detail = described ? described.text : t('session.scheduled');
    if (st.state === 'deleted') return { text: t('session.taskDeletedShort'), error: false, title: detail };
    if (st.state === 'history') return { text: t('session.history'), error: false, title: detail };
    if (described && described.error) return { text: t('session.failed'), error: true, title: detail };
    if (st.state === 'current' && st.enabled === false) return { text: t('session.disabled'), error: false, title: detail };
    return { text: t('session.task'), error: false, title: detail };
  }

  function pinnedAtOf(session) {
    const value = session && session.pinnedAt;
    return typeof value === 'number' && value > 0 ? value : 0;
  }

  function sortByRecent(list) {
    list.sort((a, b) => {
      const ap = pinnedAtOf(a);
      const bp = pinnedAtOf(b);
      if (ap && bp) return ap - bp;
      if (ap) return -1;
      if (bp) return 1;
      return (b.updatedAt || 0) - (a.updatedAt || 0);
    });
    return list;
  }

  /** 普通会话按时间分段。无效时间戳不打标签，避免把测试数据和空值收成 1970。 */
  function timeSectionLabel(ts) {
    const time = Number(ts);
    if (!Number.isFinite(time) || time < 86400000 * 2) return '';
    const now = new Date();
    const dayStart = (d) => new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
    const diff = dayStart(now) - dayStart(new Date(time));
    const day = 86400000;
    if (diff <= 0) return t('session.today');
    if (diff < 7 * day) return t('session.within7');
    if (diff < 30 * day) return t('session.within30');
    const d = new Date(time);
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
  }

  function cssEscape(value) {
    const text = String(value || '');
    if (window.CSS && typeof window.CSS.escape === 'function') return window.CSS.escape(text);
    return text.replace(/"/g, '\\"');
  }

  function guessNickname() {
    try {
      const saved = localStorage.getItem(NICKNAME_KEY);
      if (saved && saved.trim()) return saved.trim().slice(0, 24);
    } catch (_e) { /* ignore */ }
    const fromOs = Store.getLocalUser ? String(Store.getLocalUser() || '').trim() : '';
    if (fromOs) return fromOs.slice(0, 24);
    const dir = Store.getDefaultWorkDir ? String(Store.getDefaultWorkDir() || '') : '';
    const matched = dir.replace(/\\/g, '/').match(/\/(?:Users|users|home)\/([^/]+)/i);
    if (matched && matched[1] && matched[1] !== '.' && matched[1].toLowerCase() !== 'public') {
      return matched[1];
    }
    return t('session.localUser');
  }

  function renderProfile() {
    if (!sidebar || nicknameEditing) return;
    const name = guessNickname();
    let nameEl = sidebar.querySelector('.chat-sidebar-user-name');
    const input = sidebar.querySelector('.chat-sidebar-user-name-input');
    if (!nameEl && input) {
      nameEl = document.createElement('span');
      nameEl.className = 'chat-sidebar-user-name';
      nameEl.title = t('session.nicknameTip');
      input.replaceWith(nameEl);
    }
    if (nameEl) nameEl.textContent = name;
  }

  function beginNicknameEdit() {
    if (!sidebar || nicknameEditing) return;
    const nameEl = sidebar.querySelector('.chat-sidebar-user-name');
    if (!nameEl) return;
    nicknameEditing = true;
    const current = nameEl.textContent || '';
    const input = document.createElement('input');
    input.type = 'text';
    input.className = 'chat-sidebar-user-name-input';
    input.value = current === t('session.localUser') ? '' : current;
    input.placeholder = t('session.nickname');
    input.maxLength = 24;
    input.setAttribute('aria-label', t('session.editNickname'));
    nameEl.replaceWith(input);
    input.addEventListener('click', (e) => { e.stopPropagation(); });
    input.addEventListener('mousedown', (e) => { e.stopPropagation(); });
    const finish = (save) => {
      if (!nicknameEditing) return;
      nicknameEditing = false;
      const next = input.value.trim();
      if (save && next) {
        try { localStorage.setItem(NICKNAME_KEY, next.slice(0, 24)); } catch (_e) { /* ignore */ }
      }
      renderProfile();
    };
    input.addEventListener('blur', () => { finish(true); });
    input.addEventListener('keydown', (e) => {
      e.stopPropagation();
      if (e.key === 'Enter') input.blur();
      else if (e.key === 'Escape') {
        e.preventDefault();
        nicknameEditing = false;
        renderProfile();
      }
    });
    input.focus();
    input.select();
  }

  function syncSelectChrome() {
    if (!sidebar) return;
    sidebar.classList.toggle('is-selecting', selectMode);
    const bar = sidebar.querySelector('.chat-sidebar-selectbar');
    const batch = sidebar.querySelector('.chat-sidebar-batchbar');
    const countText = sidebar.querySelector('.chat-sidebar-selectbar-text');
    const del = sidebar.querySelector('.chat-sidebar-batch-delete');
    if (bar) bar.hidden = !selectMode;
    if (batch) batch.hidden = !selectMode;
    if (countText) countText.innerHTML = t('session.selected', { n: selectedIds.size });
    if (del) del.disabled = selectedIds.size === 0;
  }

  function pruneSelection() {
    if (!selectMode || !selectedIds.size) return;
    const live = {};
    const sessions = Store.getSessions();
    for (let i = 0; i < sessions.length; i++) live[sessions[i].id] = true;
    selectedIds.forEach((id) => {
      if (!live[id]) selectedIds.delete(id);
    });
  }

  function exitSelectMode() {
    selectMode = false;
    selectedIds.clear();
    closeMenu();
    renderList();
  }

  function toggleSelected(sessionId) {
    if (!sessionId) return;
    if (selectedIds.has(sessionId)) selectedIds.delete(sessionId);
    else selectedIds.add(sessionId);
    renderList();
  }

  function enterOrToggleSelect(sessionId) {
    if (!selectMode) {
      selectMode = true;
      selectedIds.clear();
      if (sessionId) selectedIds.add(sessionId);
      if (isSearchOpen()) setSearchOpen(false);
    } else {
      toggleSelected(sessionId);
      return;
    }
    renderList();
  }

  function clearMenuOpenItem() {
    if (!sidebar) return;
    const open = sidebar.querySelectorAll('.chat-sidebar-item.is-menu-open');
    for (let i = 0; i < open.length; i++) open[i].classList.remove('is-menu-open');
  }

  function closeMenu() {
    if (window.Menu && typeof window.Menu.close === 'function') window.Menu.close();
    clearMenuOpenItem();
  }

  function openMenu(sessionId, x, y) {
    if (!window.Menu || typeof window.Menu.open !== 'function') return;
    const selecting = selectMode && selectedIds.has(sessionId);
    window.Menu.open({
      x,
      y,
      items: [
        { id: 'rename', label: t('session.rename'), icon: 'edit' },
        { id: 'pin', label: isPinned(sessionId) ? t('session.unpin') : t('session.pin'), icon: 'pin' },
        { id: 'select', label: selecting ? t('session.unselect') : t('session.select'), icon: 'check' },
        { id: 'delete', label: t('common.delete'), icon: 'trash', danger: true },
      ],
      onSelect(item) {
        if (!item) return;
        if (item.id === 'rename') renameFromMenu(sessionId);
        else if (item.id === 'pin') togglePin(sessionId);
        else if (item.id === 'select') enterOrToggleSelect(sessionId);
        else if (item.id === 'delete') deleteSessions([sessionId]);
      },
      onClose() { clearMenuOpenItem(); },
    });
    if (!sidebar) return;
    clearMenuOpenItem();
    const item = sidebar.querySelector(`.chat-sidebar-item[data-id="${cssEscape(sessionId)}"]`);
    if (item) item.classList.add('is-menu-open');
  }

  function isPinned(sessionId) {
    const sessions = Store.getSessions();
    for (let i = 0; i < sessions.length; i++) {
      if (sessions[i].id === sessionId) return pinnedAtOf(sessions[i]) > 0;
    }
    return false;
  }

  function togglePin(sessionId) {
    if (!Store.setSessionPinned) return;
    Store.setSessionPinned(sessionId, !isPinned(sessionId), () => { renderList(); });
  }

  function renameFromMenu(sessionId) {
    if (!sidebar) return;
    const titleEl = sidebar.querySelector(`.chat-sidebar-item[data-id="${cssEscape(sessionId)}"] .chat-sidebar-item-title`);
    if (!titleEl) return;
    const sessions = Store.getSessions();
    let current = titleEl.textContent || t('session.untitled');
    for (let i = 0; i < sessions.length; i++) {
      if (sessions[i].id === sessionId) {
        current = sessions[i].title || current;
        break;
      }
    }
    startRename(sessionId, titleEl, current);
  }

  function renderList() {
    if (!sidebar) return;
    closeMenu();
    pruneSelection();
    const list = sidebar.querySelector('.chat-sidebar-list');
    if (!list) return;
    list.innerHTML = '';

    const sessions = Store.getSessions();
    const activeId = Store.getActiveSessionId();
    const highlightActive = !isAuxiliaryNavPage();
    const visible = [];
    for (let i = 0; i < sessions.length; i++) {
      if (matchesSearch(sessions[i])) visible.push(sessions[i]);
    }
    sortByRecent(visible);

    if (!visible.length) {
      const empty = document.createElement('div');
      empty.className = 'chat-sidebar-list-empty';
      empty.textContent = searchKeyword ? t('session.noMatch') : t('session.empty');
      list.appendChild(empty);
    } else {
      let lastTimeLabel = '';
      for (let i = 0; i < visible.length; i++) {
        const s = visible[i];
        const pinned = pinnedAtOf(s) > 0;
        if (!pinned) {
          const label = timeSectionLabel(s.updatedAt);
          if (label && label !== lastTimeLabel) {
            const timeEl = document.createElement('div');
            timeEl.className = 'chat-sidebar-time';
            timeEl.textContent = label;
            list.appendChild(timeEl);
            lastTimeLabel = label;
          }
        }
        list.appendChild(renderItem(s, activeId, highlightActive, taskStateOf(s.id), pinned));
      }
    }
    if (window.AppIcon) window.AppIcon.hydrate(list);
    renderWorkspaceFooter();
    renderProfile();
    syncSelectChrome();
  }

  /** taskState 非空表示任务会话：标题去前缀，meta 行显示任务状态 */
  function renderItem(s, activeId, highlightActive, taskState, pinned) {
    const isActive = highlightActive && s.id === activeId;
    const checked = selectMode && selectedIds.has(s.id);
    const item = document.createElement('div');
    item.className = 'chat-sidebar-item'
      + (isActive ? ' active' : '')
      + (selectMode ? ' is-checkable' : '')
      + (checked ? ' is-checked' : '');
    item.setAttribute('data-id', s.id);

    if (selectMode) {
      const check = document.createElement('button');
      check.type = 'button';
      check.className = 'chat-sidebar-item-check';
      check.setAttribute('aria-pressed', checked ? 'true' : 'false');
      check.setAttribute('aria-label', checked ? t('session.unselect') : t('session.selectSession'));
      check.innerHTML = '<span class="chat-sidebar-item-check-icon" aria-hidden="true"></span>';
      check.addEventListener('click', (e) => {
        e.stopPropagation();
        toggleSelected(s.id);
      });
      item.appendChild(check);
    }

    const body = document.createElement('div');
    body.className = 'chat-sidebar-item-body';

    const titleRow = document.createElement('div');
    titleRow.className = 'chat-sidebar-item-title-row';

    const titleSpan = document.createElement('span');
    titleSpan.className = 'chat-sidebar-item-title';
    titleSpan.textContent = displayTitle(s, !!taskState);
    const pathTip = fullWorkspacePath(s.id);
    titleSpan.title = pathTip ? `${s.title || t('session.untitled')}\n${pathTip}` : (s.title || t('session.untitled'));

    titleSpan.addEventListener('dblclick', (e) => {
      e.stopPropagation();
      if (selectMode) return;
      startRename(s.id, titleSpan, s.title || t('session.untitled'));
    });
    titleRow.appendChild(titleSpan);

    if (pinned) {
      const pinChip = document.createElement('span');
      pinChip.className = 'chat-sidebar-item-chip';
      pinChip.textContent = t('session.pin');
      pinChip.title = t('session.pinned');
      titleRow.appendChild(pinChip);
    }

    const chipInfo = taskChip(taskState);
    if (chipInfo) {
      const chip = document.createElement('span');
      chip.className = 'chat-sidebar-item-chip' + (chipInfo.error ? ' is-error' : '');
      chip.textContent = chipInfo.text;
      chip.title = chipInfo.title;
      titleRow.appendChild(chip);
    }

    if (Store.getShellCollabActive && Store.getShellCollabActive(s.id)) {
      const shellBadge = document.createElement('span');
      shellBadge.className = 'chat-sidebar-item-shell-badge';
      shellBadge.title = t('session.shellFixed');
      shellBadge.setAttribute('aria-label', t('session.shellMode'));
      shellBadge.innerHTML =
        `${ic('terminal', 11)}<span class="chat-sidebar-item-shell-label">Shell</span>`;
      titleRow.appendChild(shellBadge);
    }

    const runPhase = Store.getRunPhase ? Store.getRunPhase(s.id) : '';
    if (runPhase === 'running' || runPhase === 'done' || runPhase === 'error') {
      item.setAttribute('data-run-phase', runPhase);
      item.classList.add('has-run-dot');
      const runDot = document.createElement('span');
      runDot.className = `chat-sidebar-item-run-dot is-${runPhase}`;
      runDot.setAttribute(
        'aria-label',
        runPhase === 'running' ? t('session.running') : runPhase === 'done' ? t('session.done') : t('session.runFailed'),
      );
      titleRow.appendChild(runDot);
    }

    if (!selectMode) {
      const moreBtn = document.createElement('button');
      moreBtn.type = 'button';
      moreBtn.className = 'chat-sidebar-item-more';
      moreBtn.title = t('session.actions');
      moreBtn.setAttribute('aria-label', t('session.actions'));
      moreBtn.innerHTML = ic('more-dots', 14);
      moreBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        const rect = moreBtn.getBoundingClientRect();
        openMenu(s.id, rect.left, rect.bottom + 4);
      });
      titleRow.appendChild(moreBtn);
    }

    body.appendChild(titleRow);
    item.appendChild(body);
    item.addEventListener('click', (e) => {
      if (e.target.closest('.chat-sidebar-rename-input')) return;
      if (selectMode) {
        toggleSelected(s.id);
        return;
      }
      selectSession(s.id);
    });
    item.addEventListener('contextmenu', (e) => {
      if (e.target.closest('.chat-sidebar-rename-input')) return;
      e.preventDefault();
      openMenu(s.id, e.clientX, e.clientY);
    });
    return item;
  }

  function applyWorkspaceForSession(sessionId, workspacePayload) {
    if (workspacePayload && Store.setSessionWorkspace) {
      Store.setSessionWorkspace(sessionId, workspacePayload);
      if (typeof workspacePayload.shellCollabActive === 'boolean' && Store.setShellCollabActive) {
        Store.setShellCollabActive(sessionId, workspacePayload.shellCollabActive);
      }
      return;
    }
    Store.fetchSessions(() => { renderList(); });
  }

  function deleteSessions(ids) {
    const unique = [];
    const seen = {};
    for (let i = 0; i < ids.length; i++) {
      if (!ids[i] || seen[ids[i]]) continue;
      seen[ids[i]] = true;
      unique.push(ids[i]);
    }
    if (!unique.length) return;
    const active = Store.getActiveSessionId();
    const ordered = unique.filter((id) => id !== active);
    if (seen[active]) ordered.push(active);
    const many = unique.length > 1;
    Modal.confirm({
      title: t('session.deleteTitle'),
      message: many
        ? t('session.deleteMany', { n: unique.length })
        : t('session.deleteOne'),
      type: 'danger',
      confirmText: t('common.delete'),
      cancelText: t('common.cancel'),
      dangerConfirm: true,
    }).then((ok) => {
      if (!ok) return;
      const wsSend = window.ChatWebSocket ? window.ChatWebSocket.send : null;
      const run = (index) => {
        if (index >= ordered.length) {
          if (!selectMode || selectedIds.size === 0) {
            selectMode = false;
            selectedIds.clear();
          }
          renderList();
          return;
        }
        const sessionId = ordered[index];
        const wasActive = Store.getActiveSessionId() === sessionId;
        selectedIds.delete(sessionId);
        Store.deleteSession(sessionId, wsSend, (success, info) => {
          if (!success) {
            selectedIds.add(sessionId);
            renderList();
            return;
          }
          if (wasActive && info && info.switchedTo
              && window.ChatPage && typeof window.ChatPage.onSessionSwitched === 'function') {
            window.ChatPage.onSessionSwitched(info.switchedTo);
          }
          run(index + 1);
        });
      };
      run(0);
    });
  }

  function selectSession(sessionId) {
    const leaveAuxiliary = isAuxiliaryNavPage();
    if (sessionId === Store.getActiveSessionId()) {
      if (leaveAuxiliary) navigateToChatPage();
      return;
    }
    Store.switchSession(sessionId, window.ChatWebSocket ? window.ChatWebSocket.send : null, (ok, runningTurn, workspacePayload, _degraded, bgTasks, runtime) => {
      if (!ok) return;
      applyWorkspaceForSession(sessionId, workspacePayload);
      renderList();
      if (window.ChatPage && typeof window.ChatPage.onSessionSwitched === 'function') {
        window.ChatPage.onSessionSwitched(sessionId, runningTurn, { bgTasks, ...(runtime || {}) });
      }
      if (leaveAuxiliary) navigateToChatPage();
    });
  }

  /** currentTitle：完整标题（任务会话显示时去掉了前缀，改名要基于原标题） */
  function startRename(sessionId, titleEl, currentTitle) {
    const current = currentTitle || titleEl.textContent;
    const input = document.createElement('input');
    input.type = 'text';
    input.className = 'chat-sidebar-rename-input';
    input.value = current;
    titleEl.replaceWith(input);
    input.addEventListener('click', (e) => { e.stopPropagation(); });
    input.addEventListener('mousedown', (e) => { e.stopPropagation(); });
    input.addEventListener('contextmenu', (e) => { e.stopPropagation(); });
    input.focus();
    input.select();

    function commit() {
      const newTitle = input.value.trim() || current;
      Store.renameSession(sessionId, newTitle, () => { renderList(); });
    }

    input.addEventListener('blur', commit);
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') { input.blur(); }
      if (e.key === 'Escape') { input.value = current; input.blur(); }
    });
  }

  /** WS / connected 推送的工作区更新 */
  function notifyWorkspaceUpdated(data) {
    if (!data) return;
    const sid = data.sessionId || data.activeSessionId;
    if (!sid || !Store.setSessionWorkspace) return;
    Store.setSessionWorkspace(sid, data);
    if (typeof data.shellCollabActive === 'boolean' && Store.setShellCollabActive) {
      Store.setShellCollabActive(sid, data.shellCollabActive);
    }
  }

  const SIDEBAR_MIN = 200;
  const SIDEBAR_MAX = 480;
  const SIDEBAR_DEFAULT = 256;

  function readStoredSidebarWidth() {
    try {
      if (window.EtlPrefs && typeof window.EtlPrefs.getKey === 'function') {
        const v = window.EtlPrefs.getKey('sidebarWidth');
        if (typeof v === 'number' && isFinite(v)) return v;
      }
    } catch (_e) { /* ignore */ }
    return SIDEBAR_DEFAULT;
  }

  function clampSidebarWidth(value) {
    const w = typeof value === 'number' ? value : parseInt(value, 10);
    const base = isFinite(w) ? w : SIDEBAR_DEFAULT;
    const room = Math.max(SIDEBAR_MIN, (window.innerWidth || SIDEBAR_MAX) - 320);
    const max = Math.min(SIDEBAR_MAX, room);
    return Math.round(Math.min(max, Math.max(SIDEBAR_MIN, base)));
  }

  function applySidebarWidth(value) {
    const w = clampSidebarWidth(value == null ? readStoredSidebarWidth() : value);
    document.documentElement.style.setProperty('--sidebar-width', `${w}px`);
    if (sidebar) {
      const handle = sidebar.querySelector('.chat-sidebar-resizer');
      if (handle) handle.setAttribute('aria-valuenow', String(w));
    }
    return w;
  }

  function commitSidebarWidth(value) {
    const next = applySidebarWidth(value);
    if (!window.EtlPrefs || typeof window.EtlPrefs.set !== 'function') return;
    if (next === readStoredSidebarWidth()) return;
    window.EtlPrefs.set({ sidebarWidth: next }).catch(() => {
      applySidebarWidth(readStoredSidebarWidth());
    });
  }

  function bindSidebarResizer() {
    if (!sidebar) return;
    let handle = sidebar.querySelector('.chat-sidebar-resizer');
    if (!handle) {
      handle = document.createElement('div');
      handle.className = 'chat-sidebar-resizer';
      handle.setAttribute('role', 'separator');
      handle.setAttribute('aria-orientation', 'vertical');
      handle.tabIndex = 0;
      handle.setAttribute('aria-label', t('session.resize'));
      handle.setAttribute('aria-valuemin', String(SIDEBAR_MIN));
      handle.setAttribute('aria-valuemax', String(SIDEBAR_MAX));
      sidebar.appendChild(handle);
    }
    if (handle.dataset.bound === '1') return;
    handle.dataset.bound = '1';
    applySidebarWidth();

    let dragging = false;
    const stop = () => {
      if (!dragging) return;
      dragging = false;
      document.body.classList.remove('pane-resizing');
      const current = parseInt(getComputedStyle(document.documentElement).getPropertyValue('--sidebar-width'), 10);
      commitSidebarWidth(current);
    };
    handle.addEventListener('pointerdown', (event) => {
      if (event.button !== 0) return;
      if (document.documentElement.getAttribute('data-shell') === 'mobile') return;
      dragging = true;
      handle.setPointerCapture(event.pointerId);
      document.body.classList.add('pane-resizing');
      applySidebarWidth(event.clientX - sidebar.getBoundingClientRect().left);
      event.preventDefault();
    });
    handle.addEventListener('pointermove', (event) => {
      if (!dragging) return;
      applySidebarWidth(event.clientX - sidebar.getBoundingClientRect().left);
    });
    handle.addEventListener('pointerup', stop);
    handle.addEventListener('pointercancel', stop);
    handle.addEventListener('keydown', (event) => {
      const current = parseInt(getComputedStyle(document.documentElement).getPropertyValue('--sidebar-width'), 10) || SIDEBAR_DEFAULT;
      const step = event.shiftKey ? 32 : 16;
      if (event.key === 'ArrowRight') commitSidebarWidth(current + step);
      else if (event.key === 'ArrowLeft') commitSidebarWidth(current - step);
      else if (event.key === 'Home') commitSidebarWidth(SIDEBAR_DEFAULT);
      else return;
      event.preventDefault();
    });
  }

  applySidebarWidth();
  if (window.EtlPrefs) {
    if (typeof window.EtlPrefs.whenReady === 'function') {
      window.EtlPrefs.whenReady().then(() => { applySidebarWidth(); });
    }
    if (typeof window.EtlPrefs.onChange === 'function') {
      window.EtlPrefs.onChange(() => { applySidebarWidth(); });
    }
  }

  return {
    create,
    destroy,
    renderList,
    revealSession,
    notifyWorkspaceUpdated,
    notifyShellCollabUpdated,
  };
})();

if (typeof window !== 'undefined') {
  window.ChatSessionSidebar = ChatSessionSidebar;
}
