/**
 * 通用 Modal 组件
 * 提供 confirm / alert 弹框，Promise 风格调用，适配 dark/light 主题。
 *
 * 用法：
 *   Modal.confirm({ title, message, type, confirmText, cancelText })
 *   Modal.alert({ title, message, type, confirmText })
 */

/* exported Modal */

window.Modal = (function () {
  'use strict';

  var ICONS = {
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
   * @returns {Promise<boolean>} resolve(true) 确认 / resolve(false) 取消
   */
  function confirm(opts) {
    return new Promise(function (resolve) {
      opts = opts || {};
      var type = opts.type || 'warning';

      // overlay
      var overlay = document.createElement('div');
      overlay.className = 'modal-overlay';

      // box
      var box = document.createElement('div');
      box.className = 'modal-box';

      // header
      var header = document.createElement('div');
      header.className = 'modal-header';

      var iconEl = document.createElement('div');
      iconEl.className = 'modal-icon ' + type;
      iconEl.textContent = ICONS[type] || ICONS.warning;
      header.appendChild(iconEl);

      var titleEl = document.createElement('div');
      titleEl.className = 'modal-title';
      titleEl.textContent = opts.title || '确认';
      header.appendChild(titleEl);
      box.appendChild(header);

      // body
      if (opts.message) {
        var body = document.createElement('div');
        body.className = 'modal-body';
        body.textContent = opts.message;
        box.appendChild(body);
      }

      // footer
      var footer = document.createElement('div');
      footer.className = 'modal-footer';

      var cancelBtn = document.createElement('button');
      cancelBtn.className = 'modal-btn';
      cancelBtn.textContent = opts.cancelText || '取消';
      footer.appendChild(cancelBtn);

      var confirmBtn = document.createElement('button');
      confirmBtn.className = 'modal-btn' + (opts.dangerConfirm ? ' danger' : ' primary');
      confirmBtn.textContent = opts.confirmText || '确认';
      footer.appendChild(confirmBtn);

      box.appendChild(footer);
      overlay.appendChild(box);
      document.body.appendChild(overlay);

      // 入场动画（下一帧添加 visible）
      requestAnimationFrame(function () {
        overlay.classList.add('visible');
      });

      var settled = false;

      function close(result) {
        if (settled) return;
        settled = true;
        overlay.classList.remove('visible');
        setTimeout(function () {
          if (overlay.parentNode) overlay.remove();
        }, 220);
        resolve(result);
      }

      confirmBtn.addEventListener('click', function () { close(true); });
      cancelBtn.addEventListener('click', function () { close(false); });
      overlay.addEventListener('click', function (e) {
        if (e.target === overlay) close(false);
      });

      function onKeydown(e) {
        if (e.key === 'Escape') {
          e.preventDefault();
          close(false);
        } else if (e.key === 'Enter') {
          e.preventDefault();
          close(true);
        }
      }
      document.addEventListener('keydown', onKeydown);

      // 清理 keydown 监听
      var origClose = close;
      close = function (result) {
        document.removeEventListener('keydown', onKeydown);
        origClose(result);
      };

      confirmBtn.focus();
    });
  }

  /**
   * 简易 alert 弹框（只有确认按钮）。
   */
  function alert(opts) {
    opts = opts || {};
    opts.cancelText = '';
    return confirm(opts).then(function () { return true; });
  }

  return { confirm: confirm, alert: alert };
})();
