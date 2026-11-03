// @ts-nocheck
/**
 * 待办页（#/todos、移动端 mTodos）：短列表、勾选、补记一条。记下时可以附一张图。
 */

/* exported TodosPage */

export const TodosPage = (() => {

  const POLL_MS = 5000;
  let rootEl = null;
  let pollTimer = null;
  let loadGen = 0;
  let onKey = null;
  let saving = false;
  let pendingImage = null;
  const IMAGE_MAX_EDGE = 1600;
  const IMAGE_MAX_CHARS = 1_200_000;

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
    pendingImage = null;
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

  function clearPendingImage() {
    pendingImage = null;
    if (!rootEl) return;
    const box = rootEl.querySelector('.todo-compose-shot');
    const file = rootEl.querySelector('.todo-file');
    if (box) {
      const img = box.querySelector('img');
      if (img) img.removeAttribute('src');
      box.hidden = true;
    }
    if (file) file.value = '';
  }

  function showPendingImage(dataUrl) {
    pendingImage = dataUrl;
    if (!rootEl) return;
    const box = rootEl.querySelector('.todo-compose-shot');
    const img = box && box.querySelector('img');
    if (!box || !img) return;
    img.src = dataUrl;
    box.hidden = false;
  }

  /** 选中的图统一收成 PNG，边长过大时缩小，避免撑过保存接口。 */
  function fileToPng(file) {
    return new Promise((resolve, reject) => {
      const url = URL.createObjectURL(file);
      const img = new Image();
      img.onload = () => {
        URL.revokeObjectURL(url);
        let width = img.naturalWidth;
        let height = img.naturalHeight;
        if (!width || !height) {
          reject(new Error('这张图打不开'));
          return;
        }
        const canvas = document.createElement('canvas');
        const ctx = canvas.getContext('2d');
        if (!ctx) {
          reject(new Error('这张图打不开'));
          return;
        }
        let dataUrl = '';
        for (let i = 0; i < 7; i++) {
          const edge = Math.max(width, height);
          if (edge > IMAGE_MAX_EDGE) {
            const scale = IMAGE_MAX_EDGE / edge;
            width = Math.max(1, Math.round(width * scale));
            height = Math.max(1, Math.round(height * scale));
          }
          canvas.width = width;
          canvas.height = height;
          ctx.drawImage(img, 0, 0, width, height);
          dataUrl = canvas.toDataURL('image/png');
          if (dataUrl.length <= IMAGE_MAX_CHARS) break;
          width = Math.max(1, Math.round(width * 0.75));
          height = Math.max(1, Math.round(height * 0.75));
        }
        resolve(dataUrl);
      };
      img.onerror = () => {
        URL.revokeObjectURL(url);
        reject(new Error('这张图打不开'));
      };
      img.src = url;
    });
  }

  async function attachImageFile(file) {
    if (!file || saving) return;
    const fileInput = rootEl && rootEl.querySelector('.todo-file');
    if (fileInput) fileInput.value = '';
    setError('');
    try {
      showPendingImage(await fileToPng(file));
    } catch (err) {
      setError(err.message || '这张图打不开');
    }
  }

  async function createTodo(text) {
    const trimmed = String(text || '').trim();
    const image = pendingImage;
    if (saving || (!trimmed && !image)) return;
    saving = true;
    setError('');
    try {
      const body = { text: trimmed };
      if (image) body.image = image;
      await api('POST', '/api/todos', body);
      const input = rootEl && rootEl.querySelector('.todo-compose input[type="text"]');
      if (input) input.value = '';
      clearPendingImage();
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
    if (event.target.closest('[data-todo-pick]')) {
      const file = rootEl && rootEl.querySelector('.todo-file');
      if (file) file.click();
      return;
    }
    if (event.target.closest('[data-todo-clear-shot]')) {
      clearPendingImage();
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
    const input = rootEl && rootEl.querySelector('.todo-compose input[type="text"]');
    createTodo(input ? input.value : '');
  }

  function onFileChange(event) {
    const file = event.target.files && event.target.files[0];
    if (file) attachImageFile(file);
  }

  function onPaste(event) {
    const items = event.clipboardData && event.clipboardData.items;
    if (!items) return;
    for (let i = 0; i < items.length; i++) {
      const item = items[i];
      if (item.kind !== 'file' || !item.type || item.type.indexOf('image/') !== 0) continue;
      const file = item.getAsFile();
      if (!file) continue;
      event.preventDefault();
      attachImageFile(file);
      return;
    }
  }

  function render(parentEl) {
    destroy();
    if (window.TaskTabs) window.TaskTabs.remember('todos');
    const tabs = window.TaskTabs ? window.TaskTabs.html('todos') : '';
    const plus = window.AppIcon
      ? window.AppIcon.html('plus', { width: 18 })
      : '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" aria-hidden="true"><line x1="12" y1="5" x2="12" y2="19" stroke="currentColor" stroke-width="1.7" stroke-linecap="round"/><line x1="5" y1="12" x2="19" y2="12" stroke="currentColor" stroke-width="1.7" stroke-linecap="round"/></svg>';
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
                '<button type="button" class="btn-icon btn-icon-ghost" data-todo-pick title="附一张图" aria-label="附一张图">' + plus + '</button>' +
                '<button type="submit" class="skills-btn skills-btn-primary">记下</button>' +
                '<input type="file" class="todo-file" accept="image/*" hidden aria-label="选择图片">' +
              '</form>' +
              '<span class="todo-count">0 条未完成</span>' +
            '</div>' +
            '<div class="todo-compose-shot pending-image-item" hidden>' +
              '<img class="pending-image-thumb" alt="待附上的图">' +
              '<button type="button" class="pending-image-remove" data-todo-clear-shot title="移除图片" aria-label="移除图片">×</button>' +
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
    if (window.AppIcon && typeof window.AppIcon.hydrate === 'function') {
      window.AppIcon.hydrate(parentEl.querySelector('[data-todo-pick]'));
    }
    const form = parentEl.querySelector('.todo-compose');
    if (form) form.addEventListener('submit', onSubmit);
    const fileInput = parentEl.querySelector('.todo-file');
    if (fileInput) fileInput.addEventListener('change', onFileChange);
    const textInput = parentEl.querySelector('.todo-compose input[type="text"]');
    if (textInput) textInput.addEventListener('paste', onPaste);
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
