// @ts-nocheck
/**
 * 「知识库」页签：技能、记忆、规则是三个独立路由（#/skills、#/memory、#/rules；移动端 mSkills、mMemory、mRules），
 * 由这里统一渲染页签、记住上次所在页签，并提供侧栏 / 底栏入口的跳转目标。
 */

/* exported KnowledgeTabs */

export const KnowledgeTabs = (() => {

  const STORAGE_KEY = 'ice-knowledge-tab';
  const TABS = [
    { id: 'skills', label: '技能' },
    { id: 'memory', label: '记忆' },
    { id: 'rules', label: '规则' },
  ];

  const MOBILE_PAGES = { skills: 'mSkills', memory: 'mMemory', rules: 'mRules' };

  function isTab(id) {
    return id === 'skills' || id === 'memory' || id === 'rules';
  }

  function lastTab() {
    try {
      const saved = localStorage.getItem(STORAGE_KEY);
      return isTab(saved) ? saved : 'skills';
    } catch (_e) {
      return 'skills';
    }
  }

  function remember(tab) {
    if (!isTab(tab)) return;
    try { localStorage.setItem(STORAGE_KEY, tab); } catch (_e) { /* 隐私模式 */ }
  }

  function isMobileShell() {
    return !!(window.AppRouter && typeof window.AppRouter.getShell === 'function'
      && window.AppRouter.getShell() === 'mobile');
  }

  function open(tab) {
    const target = isTab(tab) ? tab : lastTab();
    remember(target);
    if (isMobileShell()) {
      if (window.AppRouter) window.AppRouter.navigate(MOBILE_PAGES[target]);
      return;
    }
    const hash = `#/${target}`;
    if (window.location.hash !== hash) window.location.hash = hash;
  }

  function html(active, extraClass) {
    return (
      `<div class="knowledge-tabs${extraClass ? ` ${extraClass}` : ''}" role="tablist" aria-label="知识库">` +
      TABS.map((t) => {
        const on = t.id === active;
        return `<button type="button" class="knowledge-tab${on ? ' is-active' : ''}" role="tab" data-knowledge-tab="${t.id}" aria-selected="${on}">${t.label}</button>`;
      }).join('') +
      '</div>'
    );
  }

  /** 在 root 内委托处理页签点击；返回解绑函数。 */
  function bind(root) {
    if (!root) return () => {};
    const onClick = (e) => {
      const btn = e.target.closest('[data-knowledge-tab]');
      if (!btn || btn.classList.contains('is-active')) return;
      open(btn.getAttribute('data-knowledge-tab'));
    };
    root.addEventListener('click', onClick);
    return () => root.removeEventListener('click', onClick);
  }

  return { html, bind, open, remember, lastTab };
})();

if (typeof window !== 'undefined') {
  window.KnowledgeTabs = KnowledgeTabs;
}
