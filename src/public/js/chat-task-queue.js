/**
 * 输入框上方浮动任务队列卡片。
 */

/* exported ChatTaskQueue */

window.ChatTaskQueue = (function () {
  'use strict';

  var root = null;
  var items = [];
  var editingInsertIndex = null;
  var sessionIdProvider = function () { return 'default'; };
  var onFillInput = null;

  function escapeHtml(text) {
    return String(text || '')
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  function summarize(text) {
    var oneLine = String(text || '').replace(/\s+/g, ' ').trim();
    return oneLine.length > 120 ? oneLine.slice(0, 120) + '…' : oneLine;
  }

  function mount(container) {
    if (!container) return;
    root = document.getElementById('chat-task-queue');
    if (root) return;
    root = document.createElement('div');
    root.className = 'chat-task-queue hidden';
    root.id = 'chat-task-queue';
    var composer = container.querySelector('.chat-composer');
    if (composer) container.insertBefore(root, composer);
  }

  function render() {
    if (!root) return;
    if (!items.length) {
      root.classList.add('hidden');
      root.innerHTML = '';
      return;
    }
    root.classList.remove('hidden');
    var html = '<div class="chat-task-queue-header">' +
      '<span>Next 队列</span>' +
      '<span class="chat-task-queue-count">(' + items.length + ')</span>' +
      '</div><div class="chat-task-queue-list">';
    for (var i = 0; i < items.length; i++) {
      var item = items[i];
      html += '<div class="chat-task-queue-item" data-task-id="' + escapeHtml(item.id) + '">' +
        '<span class="chat-task-queue-index">' + (i + 1) + '.</span>' +
        '<span class="chat-task-queue-text" title="' + escapeHtml(item.text) + '">' + escapeHtml(summarize(item.text)) + '</span>' +
        '<span class="chat-task-queue-actions">' +
          '<button type="button" class="chat-task-queue-btn" data-action="edit" aria-label="编辑">编辑</button>' +
          '<button type="button" class="chat-task-queue-btn" data-action="delete" aria-label="删除">删除</button>' +
        '</span></div>';
    }
    html += '</div>';
    root.innerHTML = html;
  }

  function setItems(newItems) {
    items = Array.isArray(newItems) ? newItems.slice() : [];
    render();
  }

  function refresh(sessionId) {
    var sid = sessionId || sessionIdProvider();
    return fetch('/api/sessions/' + encodeURIComponent(sid) + '/task-queue', { cache: 'no-store' })
      .then(function (res) { return res.json(); })
      .then(function (body) {
        if (body && Array.isArray(body.items)) setItems(body.items);
        return body;
      })
      .catch(function () { return null; });
  }

  function removeTask(taskId) {
    var sid = sessionIdProvider();
    return fetch('/api/sessions/' + encodeURIComponent(sid) + '/task-queue/' + encodeURIComponent(taskId), {
      method: 'DELETE',
    })
      .then(function (res) { return res.json(); })
      .then(function (body) {
        if (body && Array.isArray(body.items)) setItems(body.items);
        return body;
      });
  }

  function handleClick(ev) {
    var btn = ev.target && ev.target.closest ? ev.target.closest('[data-action]') : null;
    if (!btn || !root || !root.contains(btn)) return;
    var row = btn.closest('.chat-task-queue-item');
    if (!row) return;
    var taskId = row.getAttribute('data-task-id');
    if (!taskId) return;
    var action = btn.getAttribute('data-action');
    var index = -1;
    for (var i = 0; i < items.length; i++) {
      if (items[i].id === taskId) { index = i; break; }
    }
    if (index < 0) return;

    if (action === 'delete') {
      removeTask(taskId);
      return;
    }

    if (action === 'edit') {
      var item = items[index];
      editingInsertIndex = index;
      removeTask(taskId).then(function () {
        if (typeof onFillInput === 'function') onFillInput(item.text || '');
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
    init: init,
    bind: bind,
    mount: mount,
    setItems: setItems,
    refresh: refresh,
    getEditingInsertIndex: getEditingInsertIndex,
    clearEditingInsertIndex: clearEditingInsertIndex,
  };
})();
