// @ts-nocheck
import { t } from '../../i18n.ts';
/**
 * 移动端待办页：wrapper 复用 TodosPage render。
 */

/* exported MobileTodosPage */

export const MobileTodosPage = (() => {

  function render(parentEl) {
    parentEl.className = 'page-root page-root-mTodos mobile-page-root';
    if (window.MobileShell) window.MobileShell.setTopBarMode('todos');
    if (window.TodosPage) window.TodosPage.render(parentEl);
    else parentEl.innerHTML = `<div class="mobile-page-placeholder">${t('page.todosFailed')}</div>`;
  }

  function destroy() {
    if (window.TodosPage) window.TodosPage.destroy();
  }

  return { render, destroy };
})();

if (typeof window !== 'undefined') {
  window.MobileTodosPage = MobileTodosPage;
}
