// @ts-nocheck
/**
 * 通用 Modal 组件
 * 确认框一律走 Modal.confirm：回滚、消息/会话/记忆/技能删除、
 * 模型提供者移除、MCP 删除与未保存、权限 / Shell 确认。
 * 信息面板（扫码 / Token 统计）走 Modal.panel。
 *
 * 用法：
 *   Modal.confirm({ title, message, type, confirmText, cancelText, dangerConfirm })
 *   Modal.alert({ title, message, type, confirmText })
 */

/* exported Modal */

export const Modal = (() => {

  /** 当前顶层 confirm 的 close 回调，供多端 first-win 时程序化关窗 */
  let activeDismiss = null;

  const ICONS = {
    danger: '⚠',
    warning: '⚡',
    info: 'ℹ',
  };

  /**
   * @param {object} opts
   * @param {string}  opts.title        - 标题
   * @param {string}  [opts.message]    - 正文
   * @param {'danger'|'warning'|'info'} [opts.type='warning']
   * @param {string}  [opts.confirmText='确认']
   * @param {string}  [opts.cancelText='取消']
   * @param {boolean} [opts.dangerConfirm=false] - 确认按钮使用 danger 样式
   * @param {'confirm'|'cancel'} [opts.defaultFocus='confirm'] - 默认焦点按钮
   * @returns {Promise<boolean>} resolve(true) 确认 / resolve(false) 取消
   */
  function confirm(opts) {
    return new Promise((resolve) => {
      opts = opts || {};
      const type = opts.type || (opts.dangerConfirm ? 'danger' : 'warning');

      // overlay
      const overlay = document.createElement('div');
      overlay.className = 'modal-overlay';

      // box
      const box = document.createElement('div');
      box.className = 'modal-box';
      box.setAttribute('role', 'dialog');
      box.setAttribute('aria-modal', 'true');

      // header
      const header = document.createElement('div');
      header.className = 'modal-header';

      const iconEl = document.createElement('div');
      iconEl.className = `modal-icon ${type}`;
      iconEl.textContent = ICONS[type] || ICONS.warning;
      header.appendChild(iconEl);

      const titleEl = document.createElement('div');
      titleEl.className = 'modal-title';
      titleEl.id = 'modal-confirm-title';
      titleEl.textContent = opts.title || '确认';
      header.appendChild(titleEl);
      box.appendChild(header);
      box.setAttribute('aria-labelledby', 'modal-confirm-title');

      // body
      if (opts.message) {
        const body = document.createElement('div');
        body.className = 'modal-body';
        body.textContent = opts.message;
        box.appendChild(body);
      }

      // footer
      const footer = document.createElement('div');
      footer.className = 'modal-footer';

      const cancelBtn = document.createElement('button');
      cancelBtn.className = 'modal-btn';
      cancelBtn.textContent = opts.cancelText || '取消';
      footer.appendChild(cancelBtn);

      const confirmBtn = document.createElement('button');
      confirmBtn.className = 'modal-btn' + (opts.dangerConfirm ? ' danger' : ' primary');
      confirmBtn.textContent = opts.confirmText || '确认';
      footer.appendChild(confirmBtn);

      box.appendChild(footer);
      overlay.appendChild(box);
      document.body.appendChild(overlay);

      // 入场动画（下一帧添加 visible）
      requestAnimationFrame(() => {
        overlay.classList.add('visible');
      });

      let settled = false;
      let dismissRef = null;

      function close(result) {
        if (settled) return;
        settled = true;
        if (activeDismiss === dismissRef) activeDismiss = null;
        overlay.classList.remove('visible');
        setTimeout(() => {
          if (overlay.parentNode) overlay.remove();
        }, 220);
        resolve(result);
      }

      confirmBtn.addEventListener('click', () => { close(true); });
      cancelBtn.addEventListener('click', () => { close(false); });

      function onKeydown(e) {
        if (e.key === 'Enter') {
          e.preventDefault();
          // Enter 只执行当前真实焦点按钮。danger 弹框默认焦点为取消时，
          // 不得被 document 级快捷键反向批准。
          close(document.activeElement === confirmBtn);
        }
      }
      document.addEventListener('keydown', onKeydown);

      // 清理 keydown 监听
      const origClose = close;
      close = function (result) {
        document.removeEventListener('keydown', onKeydown);
        origClose(result);
      };
      dismissRef = close;
      activeDismiss = close;

      if (opts.defaultFocus === 'cancel') {
        cancelBtn.focus();
      } else {
        confirmBtn.focus();
      }
    });
  }

  /**
   * 简易 alert 弹框（只有确认按钮）。
   */
  function alert(opts) {
    opts = opts || {};
    opts.cancelText = '';
    return confirm(opts).then(() =>  true);
  }

  /**
   * 关闭当前 confirm 弹窗（不触发用户点击）。
   * @param {boolean} result - 与点击「确认/取消」等价的 resolve 值
   * @returns {boolean} 是否关闭了弹窗
   */
  function dismissActive(result) {
    if (!activeDismiss) return false;
    activeDismiss(result);
    return true;
  }

  const CLOSE_ICON =
    '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' +
      '<path d="M18 6 6 18M6 6l12 12"/>' +
    '</svg>';

  let activePanel = null;

  /**
   * 信息展示弹层（扫码 / Token 统计等共用）。
   * @param {object} opts
   * @param {string} opts.title
   * @param {string} [opts.description]
   * @param {string} [opts.bodyHtml]
   * @returns {{ overlay: HTMLElement, body: HTMLElement, close: Function, setBody: Function }}
   */
  function panel(opts) {
    opts = opts || {};
    closePanel(true);

    const overlay = document.createElement('div');
    overlay.className = 'modal-overlay modal-panel';

    const box = document.createElement('div');
    box.className = 'modal-box modal-panel-box';
    box.setAttribute('role', 'dialog');
    box.setAttribute('aria-modal', 'true');

    const titleId = 'modal-panel-title';
    const descId = 'modal-panel-desc';
    box.setAttribute('aria-labelledby', titleId);

    const header = document.createElement('div');
    header.className = 'modal-panel-header';

    const heading = document.createElement('div');
    heading.className = 'modal-panel-heading';

    const titleEl = document.createElement('h3');
    titleEl.className = 'modal-panel-title';
    titleEl.id = titleId;
    titleEl.textContent = opts.title || '';
    heading.appendChild(titleEl);

    if (opts.description) {
      const descEl = document.createElement('p');
      descEl.className = 'modal-panel-desc';
      descEl.id = descId;
      descEl.textContent = opts.description;
      heading.appendChild(descEl);
      box.setAttribute('aria-describedby', descId);
    }

    const closeBtn = document.createElement('button');
    closeBtn.type = 'button';
    closeBtn.className = 'btn-icon btn-icon-ghost modal-panel-close';
    closeBtn.setAttribute('aria-label', '关闭');
    closeBtn.innerHTML = CLOSE_ICON;

    header.appendChild(heading);
    header.appendChild(closeBtn);

    const body = document.createElement('div');
    body.className = 'modal-panel-body';
    if (opts.bodyHtml) body.innerHTML = opts.bodyHtml;

    box.appendChild(header);
    box.appendChild(body);
    overlay.appendChild(box);
    document.body.appendChild(overlay);

    let closed = false;
    let closeTimer = null;

    function close(immediate) {
      document.removeEventListener('keydown', onKeydown);
      if (closeTimer) {
        clearTimeout(closeTimer);
        closeTimer = null;
      }
      if (immediate) {
        closed = true;
        if (activePanel && activePanel.overlay === overlay) activePanel = null;
        if (overlay.parentNode) overlay.remove();
        return;
      }
      if (closed) return;
      closed = true;
      overlay.classList.remove('visible');
      closeTimer = setTimeout(() => {
        closeTimer = null;
        if (activePanel && activePanel.overlay === overlay) activePanel = null;
        if (overlay.parentNode) overlay.remove();
      }, 200);
    }

    function onKeydown(e) {
      if (e.key === 'Escape') {
        e.preventDefault();
        close();
      }
    }

    closeBtn.addEventListener('click', () => { close(); });
    overlay.addEventListener('click', (e) => {
      if (e.target === overlay) close();
    });
    document.addEventListener('keydown', onKeydown);

    requestAnimationFrame(() => {
      overlay.classList.add('visible');
      closeBtn.focus();
    });

    const handle = {
      overlay,
      body,
      close,
      setBody(html) {
        if (!overlay.parentNode) return;
        body.innerHTML = html || '';
      },
    };
    activePanel = handle;
    return handle;
  }

  function closePanel(immediate) {
    if (!activePanel) return;
    activePanel.close(immediate);
  }

  return { confirm, alert, dismissActive, panel, closePanel };
})();

if (typeof window !== 'undefined') {
  window.Modal = Modal;
}
