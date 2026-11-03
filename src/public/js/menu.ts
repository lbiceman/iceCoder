// @ts-nocheck
/**
 * 浮层菜单。同一时间只显示一个，点外面或按 Esc 关闭。
 *
 * Menu.open({
 *   x, y,
 *   items: [
 *     { id: 'rename', label: '重命名', icon: 'edit' },
 *     { id: 'delete', label: '删除', icon: 'trash', danger: true },
 *   ],
 *   onSelect(item) {},
 *   onClose() {},
 * })
 * Menu.close()
 * Menu.isOpen()
 */

/* exported Menu */

export const Menu = (() => {

  let root = null;
  let onSelect = null;
  let onClose = null;
  let dismissBound = false;

  function iconHtml(name) {
    if (!name || !window.AppIcon) return '';
    return window.AppIcon.html(name, { width: 14 });
  }

  function escapeHtml(value) {
    return String(value == null ? '' : value)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  function ensureRoot() {
    if (root && root.isConnected) return root;
    root = document.createElement('div');
    root.className = 'app-menu';
    root.hidden = true;
    root.setAttribute('role', 'menu');
    document.body.appendChild(root);
    root.addEventListener('click', (e) => {
      const btn = e.target.closest('[data-action]');
      if (!btn || btn.disabled) return;
      const id = btn.getAttribute('data-action');
      const select = onSelect;
      close();
      if (select) select({ id });
    });
    return root;
  }

  function bindDismiss() {
    if (dismissBound) return;
    dismissBound = true;
    document.addEventListener('pointerdown', (e) => {
      if (!root || root.hidden) return;
      if (root.contains(e.target)) return;
      close();
    });
    document.addEventListener('keydown', (e) => {
      if (e.key !== 'Escape' || !root || root.hidden) return;
      e.preventDefault();
      close();
    });
  }

  function place(x, y) {
    root.hidden = false;
    root.style.left = '0px';
    root.style.top = '0px';
    const rect = root.getBoundingClientRect();
    const pad = 8;
    let left = Number(x) || 0;
    let top = Number(y) || 0;
    if (left + rect.width > window.innerWidth - pad) {
      left = Math.max(pad, window.innerWidth - rect.width - pad);
    }
    if (top + rect.height > window.innerHeight - pad) {
      top = Math.max(pad, top - rect.height);
    }
    root.style.left = `${Math.round(left)}px`;
    root.style.top = `${Math.round(top)}px`;
  }

  function renderItems(items) {
    const html = [];
    for (let i = 0; i < items.length; i++) {
      const item = items[i] || {};
      const id = escapeHtml(item.id || '');
      const label = escapeHtml(item.label || '');
      const danger = item.danger ? ' is-danger' : '';
      const disabled = item.disabled ? ' disabled' : '';
      html.push(
        `<button type="button" class="app-menu-item${danger}" data-action="${id}" role="menuitem"${disabled}>` +
          `<span class="app-menu-icon" aria-hidden="true">${iconHtml(item.icon)}</span>` +
          `<span class="app-menu-label">${label}</span>` +
        '</button>',
      );
    }
    root.innerHTML = html.join('');
    if (window.AppIcon) window.AppIcon.hydrate(root);
  }

  /**
   * @param {{ x?: number, y?: number, items?: Array<{ id: string, label: string, icon?: string, danger?: boolean, disabled?: boolean }>, onSelect?: function, onClose?: function }} opts
   */
  function open(opts) {
    opts = opts || {};
    const items = Array.isArray(opts.items) ? opts.items : [];
    if (!items.length) return;
    close();
    bindDismiss();
    onSelect = typeof opts.onSelect === 'function' ? opts.onSelect : null;
    onClose = typeof opts.onClose === 'function' ? opts.onClose : null;
    const el = ensureRoot();
    renderItems(items);
    place(opts.x, opts.y);
    return el;
  }

  function close() {
    const notify = onClose;
    onSelect = null;
    onClose = null;
    if (root) root.hidden = true;
    if (notify) notify();
  }

  function isOpen() {
    return !!(root && !root.hidden);
  }

  return { open, close, isOpen };
})();

if (typeof window !== 'undefined') {
  window.Menu = Menu;
}
