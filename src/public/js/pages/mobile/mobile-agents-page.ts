// @ts-nocheck
/**
 * 移动端代理页：复用 AgentsPage。
 */

/* exported MobileAgentsPage */

export const MobileAgentsPage = (() => {

  let mounted = false;

  function render(parentEl) {
    parentEl.className = 'page-root page-root-mAgents mobile-page-root';
    if (window.MobileShell) window.MobileShell.setTopBarMode('agents');
    if (window.AgentsPage && typeof window.AgentsPage.render === 'function') {
      window.AgentsPage.render(parentEl);
      mounted = true;
    } else {
      parentEl.innerHTML = '<div class="mobile-page-placeholder">代理页加载失败</div>';
    }
  }

  function destroy() {
    if (window.AgentsPage && typeof window.AgentsPage.destroy === 'function') {
      window.AgentsPage.destroy();
    }
    mounted = false;
  }

  return { render, destroy };
})();

if (typeof window !== 'undefined') {
  window.MobileAgentsPage = MobileAgentsPage;
}
