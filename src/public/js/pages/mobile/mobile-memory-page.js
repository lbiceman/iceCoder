/**
 * 移动端记忆页：wrapper 复用 MemoryPage render。
 */

/* exported MobileMemoryPage */

window.MobileMemoryPage = (function () {
  'use strict';

  var mounted = false;

  function render(parentEl) {
    parentEl.className = 'page-root page-root-mMemory mobile-page-root';

    if (window.MobileShell) {
      window.MobileShell.setTopBarMode('memory');
    }

    if (!mounted) {
      mounted = true;
      if (window.MemoryPage && typeof window.MemoryPage.render === 'function') {
        window.MemoryPage.render(parentEl);
      } else {
        parentEl.innerHTML = '<div class="mobile-page-placeholder">记忆页加载失败</div>';
      }
    }
  }

  function destroy() {
    if (window.MemoryPage && typeof window.MemoryPage.destroy === 'function') {
      window.MemoryPage.destroy();
    }
    mounted = false;
  }

  return {
    render: render,
    destroy: destroy,
  };
})();
