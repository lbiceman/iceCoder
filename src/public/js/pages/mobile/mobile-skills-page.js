/**
 * 移动端技能页：wrapper 复用 SkillsPage render。
 */

/* exported MobileSkillsPage */

window.MobileSkillsPage = (function () {
  'use strict';

  var mounted = false;

  function render(parentEl) {
    parentEl.className = 'page-root page-root-mSkills mobile-page-root';

    if (window.MobileShell) {
      window.MobileShell.setTopBarMode('skills');
    }

    if (!mounted) {
      mounted = true;
      if (window.SkillsPage && typeof window.SkillsPage.render === 'function') {
        window.SkillsPage.render(parentEl);
      } else {
        parentEl.innerHTML = '<div class="mobile-page-placeholder">技能页加载失败</div>';
      }
    } else if (window.SkillsPage && typeof window.SkillsPage.render === 'function') {
      window.SkillsPage.render(parentEl);
    }
  }

  function destroy() {
    if (window.SkillsPage && typeof window.SkillsPage.destroy === 'function') {
      window.SkillsPage.destroy();
    }
    mounted = false;
  }

  return {
    render: render,
    destroy: destroy,
  };
})();
