// @ts-nocheck
/**
 * 待办页（#/todos、移动端 mTodos）：短列表、勾选、补记一条。截图在桌面轮盘里附上。
 */

/* exported TodosPage */

export const TodosPage = (() => {

  const POLL_MS = 5000;
  let rootEl = null;
  let pollTimer = null;
  let loadGen = 0;
  let onKey = null;
  let saving = false;

  function escapeHtml(str) {
    return String(str == null ? '' : str)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  function formatTime(ms) {
    if (!ms) return '';
    const d = new Date(ms);
    if (isNaN(d.getTime())) return '';
    return d.toLocaleString('zh-CN', {
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
    });
  }

  function destroy() {
    loadGen += 1;
    if (pollTimer) clearInterval(pollTimer);
    pollTimer = null;
    if (onKey) {
      document.removeEventListener('keydown', onKey);
      onKey = null;
    }
    rootEl = null;
    saving = false;
  }

  function setError(message) {
    if (!rootEl) return;
    const el = rootEl.querySelector('.todo-error');
    if (!el) return;
    el.textContent = message || '';
    el.hidden = !message;
  }

  async function api(method, url, body) {
    const res = await fetch(url, {
      method,
      headers: body ? { 'Content-Type': 'application/json' } : undefined,
      body: body ? JSON.stringify(body) : undefined,
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok || data.success === false) {
      throw new Error((data && data.error) || '请求失败');
    }
    return data;
  }

  function closeLightbox() {
    if (!rootEl) return;
    const box = rootEl.querySelector('.todo-lightbox');
    if (box) box.hidden = true;
  }

  function openLightbox(url) {
    if (!rootEl || !url) return;
    const box = rootEl.querySelector('.todo-lightbox');
    const img = rootEl.querySelector('.todo-lightbox img');
    if (!box || !img) return;
    img.src = url;
    box.hidden = false;
  }

  function itemHtml(todo) {
    const done = todo.doneAt != null;
    const text = todo.text ? `<p class="todo-item-text">${escapeHtml(todo.text)}</p>` : '';
    const shot = todo.image
      ? `<button type="button" class="todo-shot" data-todo-preview="${escapeHtml(todo.id)}" data-todo-url="${escapeHtml(todo.image.url)}">` +
          `<img src="${escapeHtml(todo.image.url)}" alt="待办截图">` +
        '</button>'
      : '';
    const label = todo.text || '截图待办';
    return (
      `<li class="todo-item${done ? ' is-done' : ''}" data-todo-id="${escapeHtml(todo.id)}">` +
        `<label class="todo-check">` +
          `<input type="checkbox" data-todo-toggle="${escapeHtml(todo.id)}"${done ? ' checked' : ''} aria-label="${escapeHtml(label)}">` +
        '</label>' +
        `<div class="todo-item-main">${text}${shot}</div>` +
        `<time class="todo-item-time">${escapeHtml(formatTime(todo.createdAt))}</time>` +
        `<button type="button" class="skills-btn todo-item-delete" data-todo-delete="${escapeHtml(todo.id)}">删除</button>` +
      '</li>'
    );
  }

  function groupHtml(title, items) {
    if (!items.length) return '';
    const heading = title ? `<h2 class="todo-group-title">${title}</h2>` : '';
    return heading + `<ul class="todo-list">${items.map(itemHtml).join('')}</ul>`;
  }

  function paint(todos) {
    if (!rootEl) return;
    const list = rootEl.querySelector('.todo-list-host');
    const count = rootEl.querySelector('.todo-count');
    if (!list) return;
    const open = [];
    const done = [];
    for (let i = 0; i < todos.length; i++) {
      if (todos[i].doneAt == null) open.push(todos[i]);
      else done.push(todos[i]);
    }
    if (count) count.textContent = `${open.length} 条未完成`;
    if (!open.length && !done.length) {
      list.innerHTML = '<div class="skills-empty">还没有待办。</div>';
      return;
    }
    const showOpenTitle = open.length > 0 && done.length > 0;
    list.innerHTML = groupHtml(showOpenTitle ? '未完成' : '', open) + groupHtml(done.length ? '已完成' : '', done);
  }

  async function load() {
    const gen = ++loadGen;
    try {
      const data = await api('GET', '/api/todos');
      if (gen !== loadGen || !rootEl) return;
      setError('');
      paint(data.todos || []);
    } catch (err) {
      if (gen !== loadGen || !rootEl) return;
      setError(err.message || '待办加载失败');
    }
  }

  async function createTodo(text) {
    const trimmed = String(text || '').trim();
    if (!trimmed || saving) return;
    saving = true;
    setError('');
    try {
      await api('POST', '/api/todos', { text: trimmed });
      const input = rootEl && rootEl.querySelector('.todo-compose input');
      if (input) input.value = '';
      await load();
    } catch (err) {
      setError(err.message || '没有记上');
    } finally {
      saving = false;
    }
  }

  async function toggleTodo(id, done) {
    try {
      await api('POST', `/api/todos/${encodeURIComponent(id)}/done`, { done });
      await load();
    } catch (err) {
      setError(err.message || '没有改成');
      await load();
    }
  }

  async function deleteTodo(id) {
    try {
      await api('DELETE', `/api/todos/${encodeURIComponent(id)}`);
      closeLightbox();
      await load();
    } catch (err) {
      setError(err.message || '没有删掉');
    }
  }

  function onRootClick(event) {
    const preview = event.target.closest('[data-todo-preview]');
    if (preview) {
      openLightbox(preview.getAttribute('data-todo-url'));
      return;
    }
    if (event.target.closest('[data-todo-close]')) {
      closeLightbox();
      return;
    }
    const del = event.target.closest('[data-todo-delete]');
    if (del) {
      deleteTodo(del.getAttribute('data-todo-delete'));
    }
  }

  function onRootChange(event) {
    const box = event.target.closest('[data-todo-toggle]');
    if (!box) return;
    toggleTodo(box.getAttribute('data-todo-toggle'), box.checked);
  }

  function onSubmit(event) {
    event.preventDefault();
    const input = rootEl && rootEl.querySelector('.todo-compose input');
    createTodo(input ? input.value : '');
  }

  function render(parentEl) {
    destroy();
    if (window.TaskTabs) window.TaskTabs.remember('todos');
    const tabs = window.TaskTabs ? window.TaskTabs.html('todos') : '';
    parentEl.innerHTML =
      '<div class="tasks-root">' +
        '<header class="tasks-header">' +
          '<div class="tasks-header-text">' +
            '<h1 class="tasks-title">任务</h1>' +
            '<p class="tasks-hint">记一条，做完勾掉。桌面端按住 Ctrl 往下拖开轮盘，可以在原地记下，也能框一张图。</p>' +
          '</div>' +
          tabs +
        '</header>' +
        '<section class="tasks-body">' +
          '<div class="todo-root">' +
            '<div class="todo-toolbar">' +
              '<form class="todo-compose">' +
                '<input type="text" maxlength="500" placeholder="记一条，回车保存" aria-label="待办内容" autocomplete="off">' +
                '<button type="submit" class="skills-btn skills-btn-primary">记下</button>' +
              '</form>' +
              '<span class="todo-count">0 条未完成</span>' +
            '</div>' +
            '<p class="todo-error" hidden></p>' +
            '<div class="todo-list-host"><div class="skills-empty">载入中…</div></div>' +
          '</div>' +
        '</section>' +
        '<div class="todo-lightbox" hidden>' +
          '<button type="button" class="todo-lightbox-hit" data-todo-close aria-label="关闭截图"></button>' +
          '<img alt="待办截图">' +
        '</div>' +
      '</div>';
    rootEl = parentEl.querySelector('.tasks-root');
    const header = parentEl.querySelector('.tasks-header');
    if (window.TaskTabs) window.TaskTabs.bind(header);
    const form = parentEl.querySelector('.todo-compose');
    if (form) form.addEventListener('submit', onSubmit);
    rootEl.addEventListener('click', onRootClick);
    rootEl.addEventListener('change', onRootChange);
    onKey = (event) => {
      if (event.key === 'Escape') closeLightbox();
    };
    document.addEventListener('keydown', onKey);
    load();
    pollTimer = setInterval(load, POLL_MS);
  }

  return { render, destroy };
})();

if (typeof window !== 'undefined') {
  window.TodosPage = TodosPage;
}
