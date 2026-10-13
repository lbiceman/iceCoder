// @ts-nocheck
/**
 * 移动端规则页：wrapper 复用 RulesPage render。
 */

/* exported MobileRulesPage */

export const MobileRulesPage = (() => {

  function render(parentEl) {
    parentEl.className = 'page-root page-root-mRules mobile-page-root';

    if (window.MobileShell) {
      window.MobileShell.setTopBarMode('rules');
    }

    if (window.RulesPage && typeof window.RulesPage.render === 'function') {
      window.RulesPage.render(parentEl);
    } else {
      parentEl.innerHTML = '<div class="mobile-page-placeholder">规则页加载失败</div>';
    }
  }

  function destroy() {
    if (window.RulesPage && typeof window.RulesPage.destroy === 'function') {
      window.RulesPage.destroy();
    }
  }

  return {
    render,
    destroy,
  };
})();

if (typeof window !== 'undefined') {
  window.MobileRulesPage = MobileRulesPage;
}
