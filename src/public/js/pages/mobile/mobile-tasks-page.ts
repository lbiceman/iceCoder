// @ts-nocheck
/**
 * 移动端定时任务页：wrapper 复用 TasksPage render。顶栏页签切到待办。
 */

/* exported MobileTasksPage */

export const MobileTasksPage = (() => {

  function render(parentEl) {
    parentEl.className = 'page-root page-root-mTasks mobile-page-root';
    if (window.MobileShell) window.MobileShell.setTopBarMode('tasks');
    if (window.TasksPage) window.TasksPage.render(parentEl);
    else parentEl.innerHTML = '<div class="mobile-page-placeholder">任务页加载失败</div>';
  }

  function destroy() {
    if (window.TasksPage) window.TasksPage.destroy();
  }

  return { render, destroy };
})();

if (typeof window !== 'undefined') {
  window.MobileTasksPage = MobileTasksPage;
}
