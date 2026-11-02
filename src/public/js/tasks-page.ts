// @ts-nocheck
/**
 * 任务页（#/tasks、移动端 mTasks）：页头页签 + 定时任务面板（ScheduledTasksPage）。
 */

/* exported TasksPage */

export const TasksPage = (() => {

  function render(parentEl) {
    destroy();
    if (window.TaskTabs) window.TaskTabs.remember('scheduled');
    const tabs = window.TaskTabs ? window.TaskTabs.html('scheduled') : '';
    parentEl.innerHTML =
      '<div class="tasks-root">' +
        '<header class="tasks-header">' +
          '<div class="tasks-header-text">' +
            '<h1 class="tasks-title">任务</h1>' +
            '<p class="tasks-hint">定时任务按间隔把提示词连同引用的技能、图片和文件发送到各自的专属会话。</p>' +
          '</div>' +
          tabs +
        '</header>' +
        '<section class="tasks-body"></section>' +
      '</div>';
    const header = parentEl.querySelector('.tasks-header');
    if (window.TaskTabs) window.TaskTabs.bind(header);
    const body = parentEl.querySelector('.tasks-body');
    if (window.ScheduledTasksPage) window.ScheduledTasksPage.render(body);
    else body.innerHTML = '<div class="skills-empty">任务模块加载失败</div>';
  }

  function destroy() {
    if (window.ScheduledTasksPage) window.ScheduledTasksPage.destroy();
  }

  return { render, destroy };
})();

if (typeof window !== 'undefined') {
  window.TasksPage = TasksPage;
}
