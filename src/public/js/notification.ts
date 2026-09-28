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
  let stackEl = null;

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
    }, 200);
  }

  /**
   * @param {string} message
   * @param {'success'|'error'|'warning'|'info'} [type='info']
   * @param {{ duration?: number }} [opts]
   * @returns {HTMLElement}
   */
  function show(message, type = 'info', opts = {}) {
    const duration = typeof opts.duration === 'number' ? opts.duration : DEFAULT_DURATION;

    const el = document.createElement('div');
    el.className = `notification ${type}`;
    el.setAttribute('role', 'status');
    el.textContent = message || '';

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
