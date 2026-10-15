// @ts-nocheck
/**
 * 全局 Toast 通知组件
 *
 * 用法：
 *   Notification.success('配置已保存')
 *   Notification.error('保存失败')
 *   Notification.show('提示内容', 'info')
 *   Notification.show('长消息', 'success', { duration: 5000 })
 *
 * 兼容：
 *   window.UI.notify(message, type, opts)
 */

/* exported Notification */

export const Notification = (() => {

  const DEFAULT_DURATION = 3000;
  const LEAVE_MS = 280;
  let stackEl = null;

  const ICONS = {
    success: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M20 6 9 17l-5-5"/></svg>',
    error: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M18 6 6 18M6 6l12 12"/></svg>',
    warning: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 9v4"/><path d="M12 17h.01"/><path d="M10.3 4.3 2.6 18a2 2 0 0 0 1.7 3h15.4a2 2 0 0 0 1.7-3L13.7 4.3a2 2 0 0 0-3.4 0z"/></svg>',
    info: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="9"/><path d="M12 11v5"/><path d="M12 8h.01"/></svg>',
  };

  function ensureStack() {
    if (!stackEl || !stackEl.parentNode) {
      stackEl = document.createElement('div');
      stackEl.className = 'notification-stack';
      stackEl.setAttribute('aria-live', 'polite');
      stackEl.setAttribute('aria-relevant', 'additions');
      document.body.appendChild(stackEl);
    }
    return stackEl;
  }

  function dismiss(el) {
    if (!el || el.classList.contains('notification--leaving')) return;
    el.classList.remove('notification--visible');
    el.classList.add('notification--leaving');
    setTimeout(() => {
      if (el.parentNode) el.parentNode.removeChild(el);
      if (stackEl && !stackEl.children.length) {
        stackEl.parentNode.removeChild(stackEl);
        stackEl = null;
      }
    }, LEAVE_MS);
  }

  /**
   * @param {string} message
   * @param {'success'|'error'|'warning'|'info'} [type='info']
   * @param {{ duration?: number }} [opts]
   * @returns {HTMLElement}
   */
  function show(message, type = 'info', opts = {}) {
    const duration = typeof opts.duration === 'number' ? opts.duration : DEFAULT_DURATION;

    const kind = ICONS[type] ? type : 'info';
    const el = document.createElement('div');
    el.className = `notification ${kind}`;
    el.setAttribute('role', 'status');

    const mark = document.createElement('span');
    mark.className = 'notification-mark';
    mark.setAttribute('aria-hidden', 'true');
    mark.innerHTML = ICONS[kind];

    const body = document.createElement('span');
    body.className = 'notification-body';
    body.textContent = message || '';

    el.appendChild(mark);
    el.appendChild(body);

    ensureStack().appendChild(el);

    requestAnimationFrame(() => {
      el.classList.add('notification--visible');
    });

    const timer = setTimeout(() => {
      dismiss(el);
    }, duration);

    el.addEventListener('click', () => {
      clearTimeout(timer);
      dismiss(el);
    });

    return el;
  }

  function success(message, opts) {
    return show(message, 'success', opts);
  }

  function error(message, opts) {
    return show(message, 'error', opts);
  }

  function warning(message, opts) {
    return show(message, 'warning', opts);
  }

  function info(message, opts) {
    return show(message, 'info', opts);
  }

  return {
    show,
    success,
    error,
    warning,
    info,
    dismiss,
  };
})();

window.UI = window.UI || {};
window.UI.notify = (message, type, opts) => window.Notification.show(message, type, opts);

if (typeof window !== 'undefined') {
  window.Notification = Notification;
}
