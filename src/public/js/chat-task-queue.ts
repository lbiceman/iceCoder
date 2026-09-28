// @ts-nocheck
/**
 * 输入框上方浮动任务队列卡片。
 */

/* exported ChatTaskQueue */

export const ChatTaskQueue = (() => {

  let root = null;
  let items = [];
  let editingInsertIndex = null;
  let sessionIdProvider = function () { return 'default'; };
  let onFillInput = null;

  function escapeHtml(text) {
    return String(text || '')
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  function summarize(text) {
    const oneLine = String(text || '').replace(/\s+/g, ' ').trim();
    return oneLine.length > 120 ? `${oneLine.slice(0, 120)}…` : oneLine;
  }

  function isSafeImageSrc(src) {
    if (!src || typeof src !== 'string') return false;
    return src.startsWith('data:image/')
      || src.startsWith('/api/sessions/')
      || src.startsWith('https://')
      || src.startsWith('http://')
      || src.startsWith('blob:');
  }

  function renderThumbs(images) {
    if (!images || !images.length) return '';
    let html = '<span class="chat-task-queue-thumbs">';
    let shown = 0;
    for (let i = 0; i < images.length && shown < 3; i++) {
      if (!isSafeImageSrc(images[i])) continue;
      html += `<img class="chat-task-queue-thumb" src="${escapeHtml(images[i])}" alt="配图">`;
      shown += 1;
    }
    if (images.length > shown && shown > 0) {
      html += '<span class="chat-task-queue-thumb-more">+' + (images.length - shown) + '</span>';
    }
    html += '</span>';
    return shown > 0 ? html : '';
  }

  function editIconSvg() {
    return window.AppIcon ? window.AppIcon.html('edit', { width: 14, className: 'chat-task-queue-icon' }) : '';
  }

  function deleteIconSvg() {
    return window.AppIcon ? window.AppIcon.html('trash', { width: 14, className: 'chat-task-queue-icon' }) : '';
  }

  function mount(container) {
    if (!container) return;
    root = document.getElementById('chat-task-queue');
    if (root) return;
    root = document.createElement('div');
    root.className = 'chat-task-queue hidden';
    root.id = 'chat-task-queue';
    const stack = container.querySelector('.chat-composer-stack');
    const composer = container.querySelector('.chat-composer');
    if (stack && composer) stack.insertBefore(root, composer);
    else if (composer) container.insertBefore(root, composer);
  }

  function render() {
    if (!root) return;
    if (!items.length) {
      root.classList.add('hidden');
      root.innerHTML = '';
      return;
    }
    root.classList.remove('hidden');
    let html = `<div class="chat-task-queue-header"><span class="chat-task-queue-title">消息队列</span><span class="chat-task-queue-count">${items.length}</span></div><div class="chat-task-queue-list">`;
    for (let i = 0; i < items.length; i++) {
      const item = items[i];
      let label = summarize(item.text);
      if (!label && item.images && item.images.length) label = '(图片)';
      html += '<div class="chat-task-queue-item" data-task-id="' + escapeHtml(item.id) + '">' +
        '<span class="chat-task-queue-index">' + (i + 1) + '</span>' +
        renderThumbs(item.images) +
        '<span class="chat-task-queue-text" title="' + escapeHtml(item.text || label) + '">' + escapeHtml(label) + '</span>' +
        '<span class="chat-task-queue-actions">' +
        '<button type="button" class="chat-task-queue-btn chat-task-queue-btn--edit" data-action="edit" title="编辑" aria-label="编辑">' +
            editIconSvg() +
          '</button>' +
          '<button type="button" class="chat-task-queue-btn chat-task-queue-btn--delete" data-action="delete" title="删除" aria-label="删除">' +
            deleteIconSvg() +
          '</button>' +
        '</span></div>';
    }
    html += '</div>';
    root.innerHTML = html;
    if (window.AppIcon) window.AppIcon.hydrate(root);
  }

  function setItems(newItems) {
    items = Array.isArray(newItems) ? newItems.slice() : [];
    render();
  }

  function addOptimistic(item) {
    const entry = {
      id: (item && item.id) || (`optimistic-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`),
      text: (item && item.text) || '',
      images: item && Array.isArray(item.images) ? item.images.slice() : [],
      optimistic: true,
    };
    items = items.concat([entry]);
    render();
    return entry.id;
  }

  function removeById(id) {
    if (!id) return;
    const next = [];
    for (let i = 0; i < items.length; i++) {
      if (items[i].id !== id) next.push(items[i]);
    }
    items = next;
    render();
  }

  function refresh(sessionId) {
    const sid = sessionId || sessionIdProvider();
    return fetch(`/api/sessions/${encodeURIComponent(sid)}/task-queue`, { cache: 'no-store' })
      .then((res) =>  res.json())
      .then((body) => {
        if (sessionIdProvider() !== sid) return body;
        if (body && Array.isArray(body.items)) setItems(body.items);
        return body;
      })
      .catch(() =>  null);
  }

  function removeTask(taskId) {
    const sid = sessionIdProvider();
    return fetch(`/api/sessions/${encodeURIComponent(sid)}/task-queue/${encodeURIComponent(taskId)}`, {
      method: 'DELETE',
    })
      .then((res) =>  res.json())
      .then((body) => {
        if (body && Array.isArray(body.items)) setItems(body.items);
        return body;
      });
  }

  function handleClick(ev) {
    const btn = ev.target && ev.target.closest ? ev.target.closest('[data-action]') : null;
    if (!btn || !root || !root.contains(btn)) return;
    const row = btn.closest('.chat-task-queue-item');
    if (!row) return;
    const taskId = row.getAttribute('data-task-id');
    if (!taskId) return;
    const action = btn.getAttribute('data-action');
    let index = -1;
    for (let i = 0; i < items.length; i++) {
      if (items[i].id === taskId) { index = i; break; }
    }
    if (index < 0) return;

    if (action === 'delete') {
      removeTask(taskId);
      return;
    }

    if (action === 'edit') {
      const item = items[index];
      editingInsertIndex = index;
      removeTask(taskId).then(() => {
        if (typeof onFillInput === 'function') {
          onFillInput(item.text || '', item.images || []);
        }
      });
    }
  }

  function bind(container) {
    mount(container);
    if (root && !root._queueClickBound) {
      root.addEventListener('click', handleClick);
      root._queueClickBound = true;
    }
  }

  function getEditingInsertIndex() {
    return editingInsertIndex;
  }

  function setEditingInsertIndex(index) {
    editingInsertIndex = typeof index === 'number' ? index : null;
  }

  function clearEditingInsertIndex() {
    editingInsertIndex = null;
  }

  function init(opts) {
    opts = opts || {};
    if (typeof opts.getSessionId === 'function') sessionIdProvider = opts.getSessionId;
    if (typeof opts.onFillInput === 'function') onFillInput = opts.onFillInput;
    if (opts.container) bind(opts.container);
  }

  return {
    init,
    bind,
    mount,
    setItems,
    addOptimistic,
    removeById,
    refresh,
    getEditingInsertIndex,
    setEditingInsertIndex,
    clearEditingInsertIndex,
  };
})();

if (typeof window !== 'undefined') {
  window.ChatTaskQueue = ChatTaskQueue;
}
