/**
 * 移动端配置页：wrapper 复用 ConfigPage render。
 */

/* exported MobileConfigPage */

window.MobileConfigPage = (function () {
  'use strict';

  var mounted = false;

  function render(parentEl) {
    parentEl.className = 'page-root page-root-mConfig mobile-page-root';

    if (window.MobileShell) {
      window.MobileShell.setTopBarMode('config');
    }

    if (!mounted) {
      mounted = true;
      if (window.ConfigPage && typeof window.ConfigPage.render === 'function') {
        window.ConfigPage.render(parentEl);
      } else {
        parentEl.innerHTML = '<div class="mobile-page-placeholder">设置页加载失败</div>';
      }
    }
  }

  return {
    render: render,
  };
})();
