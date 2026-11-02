// @ts-nocheck
/**
 * 「任务」页签：定时、待办是两个路由（#/tasks、#/todos；移动端 mTasks、mTodos）。
 * 侧栏和底栏的「任务」打开上次停留的页签。第一次仍是定时。
 */

/* exported TaskTabs */

export const TaskTabs = (() => {

  const STORAGE_KEY = 'ice-task-tab';
  const TABS = [
    { id: 'scheduled', label: '定时' },
    { id: 'todos', label: '待办' },
  ];

  const HASH = { scheduled: '#/tasks', todos: '#/todos' };
  const MOBILE_PAGES = { scheduled: 'mTasks', todos: 'mTodos' };

  function isTab(id) {
    return id === 'scheduled' || id === 'todos';
  }

  function lastTab() {
    try {
      const saved = localStorage.getItem(STORAGE_KEY);
      return isTab(saved) ? saved : 'scheduled';
    } catch (_e) {
      return 'scheduled';
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
    const hash = HASH[target];
    if (window.location.hash !== hash) window.location.hash = hash;
  }

  function html(active, extraClass) {
    return (
      `<div class="knowledge-tabs task-tabs${extraClass ? ` ${extraClass}` : ''}" role="tablist" aria-label="任务">` +
      TABS.map((t) => {
        const on = t.id === active;
        return `<button type="button" class="knowledge-tab${on ? ' is-active' : ''}" role="tab" data-task-tab="${t.id}" aria-selected="${on}">${t.label}</button>`;
      }).join('') +
      '</div>'
    );
  }

  /** 在 root 内委托处理页签点击；返回解绑函数。 */
  function bind(root) {
    if (!root) return () => {};
    const onClick = (e) => {
      const btn = e.target.closest('[data-task-tab]');
      if (!btn || btn.classList.contains('is-active')) return;
      open(btn.getAttribute('data-task-tab'));
    };
    root.addEventListener('click', onClick);
    return () => root.removeEventListener('click', onClick);
  }

  return { html, bind, open, remember, lastTab };
})();

if (typeof window !== 'undefined') {
  window.TaskTabs = TaskTabs;
}
