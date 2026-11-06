// @ts-nocheck
import { t } from '../../i18n.ts';
/**
 * 移动端记忆页：wrapper 复用 MemoryPage render。
 */

/* exported MobileMemoryPage */

export const MobileMemoryPage = (() => {

  let mounted = false;

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
        parentEl.innerHTML = `<div class="mobile-page-placeholder">${t('page.memoryFailed')}</div>`;
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
    render,
    destroy,
  };
})();

if (typeof window !== 'undefined') {
  window.MobileMemoryPage = MobileMemoryPage;
}
