/**
 * 统一下拉浮层。
 * 取代之前 chat-commands 的 #cmd-dropdown 与 chat-model-picker 的 #model-palette。
 *
 * 用法：
 *   ChatDropdown.open({
 *     anchor: buttonEl,             // 触发元素；用于定位 + 关闭
 *     items: [{ key, name, description, isCurrent }],   // 也可只传 {name, ...}
 *     onSelect: function (item, idx, ev) { ... },       // 点击 item 触发
 *     onClose: function () { ... },                     // 关闭后回调
 *     placement: 'top' | 'bottom' | 'auto',             // 默认 'top'（悬浮在 anchor 上方）
 *     minWidth: 220,                                    // 浮层最小宽
 *     maxWidth: 300,                                    // 浮层最大宽
 *     align: 'end' | 'start' | 'center',                // 默认 'end'；center 相对 anchor 水平居中
 *     fitContent: false,                                // true 时宽度随内容，不超过 maxWidth
 *     placementRef: 'anchor' | 'toolbar',               // top 定位基准：anchor 或 composer-toolbar 顶边
 *     variant: 'default' | 'model',                       // model：仅名称、普通字体样式
 *     markAnchorActive: true,                             // 是否在 anchor 上添加 active（技能 # 下拉应传 false）
 *   });
 *   ChatDropdown.close();
 *   ChatDropdown.isOpen();
 *   ChatDropdown.toggle(opts);     // 切换：已开则关，未开则开
 *
 * 单例浮层：同一时刻只能开一个；open 第二个会先关掉前一个。
 */

/* exported ChatDropdown */

window.ChatDropdown = (function () {
  'use strict';

  var elContainer = null;
  var elList = null;
  var isOpen = false;
  var current = {
    anchor: null,
    items: [],
    onSelect: null,
    onClose: null,
    placement: 'top',
    minWidth: 220,
    maxWidth: 300,
    align: 'end',
    fitContent: false,
    placementRef: 'anchor',
    variant: 'default',
    markAnchorActive: true,
  };
  var outsideBound = false;

  function escapeHtml(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  function ensureContainer() {
    if (elContainer) return elContainer;
    var c = document.createElement('div');
    c.className = 'cmd-dropdown hidden';
    c.id = 'chat-dropdown';
    c.setAttribute('role', 'menu');
    c.setAttribute('aria-label', '下拉选项');
    // 阻止浮层内 mousedown 触发 outside-click
    c.addEventListener('mousedown', function (e) { e.stopPropagation(); });
    c.addEventListener('click', function (e) {
      var item = e.target.closest('.cmd-item');
      if (!item) return;
      e.preventDefault();
      e.stopPropagation();
      var idx = parseInt(item.getAttribute('data-index'), 10);
      if (isNaN(idx)) return;
      var it = current.items[idx];
      if (!it) return;
      var cb = current.onSelect;
      if (typeof cb === 'function') {
        try { cb(it, idx, e); } catch (_e) { /* ignore */ }
      }
      close();
    });
    document.body.appendChild(c);
    elContainer = c;
    return c;
  }

  function render() {
    if (!elContainer) return;
    if (!current.items || !current.items.length) {
      elContainer.innerHTML = '<div class="cmd-empty">暂无可选项</div>';
      return;
    }
    var html = '';
    for (var i = 0; i < current.items.length; i++) {
      var it = current.items[i];
      var name = it.name || it.key || '';
      var desc = it.description != null ? it.description : (it.desc || '');
      if (desc === '' && it.apiUrl && current.variant !== 'model') desc = it.apiUrl;
      var isCurrent = !!it.isCurrent;
      var prefix = it.prefix || '';
      var title = (desc ? desc + ' · ' : '') + (it.key || name);
      html +=
        '<div class="cmd-item' + (isCurrent ? ' active' : '') + '" data-index="' + i + '" role="menuitem" title="' + escapeHtml(title) + '">' +
          '<span class="cmd-name">' + escapeHtml(prefix + name) + '</span>' +
          (desc ? '<span class="cmd-desc">' + escapeHtml(desc) + '</span>' : '') +
        '</div>';
    }
    elContainer.innerHTML = html;
    if (current.items.length > 6) {
      elContainer.classList.add('is-scrollable');
    } else {
      elContainer.classList.remove('is-scrollable');
    }
  }

  function getTopRef(rect) {
    if (current.placementRef !== 'toolbar' || !current.anchor) return rect.top;
    var tb = current.anchor.closest && current.anchor.closest('.composer-toolbar');
    return tb ? tb.getBoundingClientRect().top : rect.top;
  }

  function position() {
    if (!elContainer || !current.anchor) return;
    var rect = current.anchor.getBoundingClientRect();
    var margin = 6;
    var maxW = Math.min(current.maxWidth, window.innerWidth - 32);
    var w;
    elContainer.style.position = 'fixed';
    elContainer.style.visibility = 'hidden';
    elContainer.style.left = '0px';
    elContainer.style.top = '0px';
    if (current.fitContent) {
      elContainer.style.width = 'max-content';
      elContainer.style.minWidth = current.minWidth ? current.minWidth + 'px' : '';
      elContainer.style.maxWidth = maxW + 'px';
    } else {
      w = Math.max(current.minWidth, maxW);
      elContainer.style.width = w + 'px';
      elContainer.style.minWidth = '';
      elContainer.style.maxWidth = '';
    }
    void elContainer.offsetHeight;
    w = elContainer.offsetWidth;
    var h = elContainer.offsetHeight;
    elContainer.style.visibility = '';
    var left;
    if (current.align === 'start') {
      left = rect.left;
    } else if (current.align === 'center') {
      left = rect.left + (rect.width - w) / 2;
    } else {
      left = rect.right - w;
    }
    if (left < 8) left = 8;
    if (left + w > window.innerWidth - 8) left = window.innerWidth - w - 8;
    var topRef = getTopRef(rect);
    var top;
    if (current.placement === 'bottom') {
      top = rect.bottom + margin;
    } else if (current.placement === 'top') {
      top = topRef - h - margin;
      if (top < 8) top = 8;
    } else {
      if (topRef - h - margin >= 8) {
        top = topRef - h - margin;
      } else {
        top = rect.bottom + margin;
      }
    }
    elContainer.style.left = left + 'px';
    elContainer.style.top = top + 'px';
  }

  function bindOutside() {
    if (outsideBound) return;
    outsideBound = true;
    document.addEventListener('mousedown', function (e) {
      if (!isOpen) return;
      if (elContainer && elContainer.contains(e.target)) return;
      if (current.anchor && current.anchor.contains && current.anchor.contains(e.target)) return;
      close();
    });
    window.addEventListener('keydown', function (e) {
      if (!isOpen) return;
      if (e.key === 'Escape') { e.preventDefault(); close(); }
    });
    window.addEventListener('resize', function () { if (isOpen) position(); });
    window.addEventListener('scroll', function () { if (isOpen) position(); }, true);
  }

  function close() {
    if (!isOpen) return;
    if (elContainer) {
      elContainer.classList.add('hidden');
      elContainer.classList.remove('is-model-menu');
    }
    isOpen = false;
    if (current.anchor && current.anchor.classList && current.markAnchorActive) {
      current.anchor.classList.remove('active');
      current.anchor.setAttribute && current.anchor.setAttribute('aria-expanded', 'false');
    }
    var cb = current.onClose;
    current.anchor = null;
    current.items = [];
    current.onSelect = null;
    current.onClose = null;
    if (typeof cb === 'function') {
      try { cb(); } catch (_e) { /* ignore */ }
    }
  }

  function open(opts) {
    opts = opts || {};
    if (isOpen) close();
    current.anchor = opts.anchor || null;
    current.items = Array.isArray(opts.items) ? opts.items : [];
    current.onSelect = typeof opts.onSelect === 'function' ? opts.onSelect : null;
    current.onClose = typeof opts.onClose === 'function' ? opts.onClose : null;
    current.placement = opts.placement || 'top';
    current.minWidth = opts.minWidth != null ? opts.minWidth : 220;
    current.maxWidth = opts.maxWidth != null ? opts.maxWidth : 300;
    current.align = opts.align || 'end';
    current.fitContent = !!opts.fitContent;
    current.placementRef = opts.placementRef || 'anchor';
    current.variant = opts.variant || 'default';
    current.markAnchorActive = opts.markAnchorActive !== false;
    ensureContainer();
    bindOutside();
    elContainer.classList.remove('is-model-menu');
    if (current.variant === 'model') elContainer.classList.add('is-model-menu');
    render();
    elContainer.classList.remove('hidden');
    isOpen = true;
    if (current.anchor && current.anchor.classList && current.markAnchorActive) {
      current.anchor.classList.add('active');
      current.anchor.setAttribute && current.anchor.setAttribute('aria-expanded', 'true');
    }
    position();
  }

  function toggle(opts) {
    if (isOpen) close();
    else open(opts);
  }

  return {
    open: open,
    close: close,
    toggle: toggle,
    isOpen: function () { return isOpen; },
    getContainer: function () { return elContainer; },
  };
})();
