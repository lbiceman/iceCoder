/**
 * 聊天气泡 / 队列缩略图点击查看大图。
 */

/* exported ChatImagePreview */

window.ChatImagePreview = (function () {
  'use strict';

  var overlay = null;
  var bound = false;

  function isSafeImageSrc(src) {
    if (!src || typeof src !== 'string') return false;
    return src.indexOf('data:image/') === 0
      || src.indexOf('/api/sessions/') === 0
      || src.indexOf('https://') === 0
      || src.indexOf('http://') === 0
      || src.indexOf('blob:') === 0;
  }

  function isPreviewThumb(el) {
    if (!el || el.tagName !== 'IMG' || !el.classList) return false;
    return el.classList.contains('msg-image-thumb')
      || el.classList.contains('chat-task-queue-thumb');
  }

  function close() {
    if (!overlay) return;
    if (overlay.parentNode) overlay.parentNode.removeChild(overlay);
    overlay = null;
    document.removeEventListener('keydown', onKeyDown, true);
  }

  function onKeyDown(e) {
    if (e.key === 'Escape') {
      e.preventDefault();
      close();
    }
  }

  function open(src, alt) {
    if (!isSafeImageSrc(src)) return;
    close();

    overlay = document.createElement('div');
    overlay.className = 'image-preview-overlay';
    overlay.setAttribute('role', 'dialog');
    overlay.setAttribute('aria-modal', 'true');
    overlay.setAttribute('aria-label', '图片预览');

    var img = document.createElement('img');
    img.className = 'image-preview-full';
    img.src = src;
    img.alt = alt || '预览图片';
    overlay.appendChild(img);

    var closeBtn = document.createElement('button');
    closeBtn.type = 'button';
    closeBtn.className = 'image-preview-close';
    closeBtn.setAttribute('aria-label', '关闭预览');
    closeBtn.textContent = '×';
    overlay.appendChild(closeBtn);

    overlay.addEventListener('click', function (e) {
      if (e.target === overlay || e.target === closeBtn) close();
    });
    img.addEventListener('click', function (e) {
      e.stopPropagation();
    });

    document.body.appendChild(overlay);
    document.addEventListener('keydown', onKeyDown, true);
    closeBtn.focus();
  }

  function onDocumentClick(e) {
    var img = e.target && e.target.closest ? e.target.closest('img') : e.target;
    if (!isPreviewThumb(img)) return;
    if (!isSafeImageSrc(img.src)) return;
    e.preventDefault();
    e.stopPropagation();
    open(img.currentSrc || img.src, img.alt);
  }

  function bind() {
    if (bound) return;
    bound = true;
    document.addEventListener('click', onDocumentClick, true);
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', bind);
  } else {
    bind();
  }

  return {
    bind: bind,
    open: open,
    close: close,
  };
})();
