// @ts-nocheck
/**
 * ChatPage 的 shell dock 任务缓存管理（从 chat-page.js 拆分，2026-08-11）。
 * 职责：维护当前 session 的后台 shell 任务缓存，并与执行透明层 EtlShellDock 双向同步。
 * 依赖：window.ChatSession（getActiveId）、window.EtlShellDock（mount/hydrate/isRunningTask/setTaskRemovedHandler）。
 * 暴露：window.ChatShellDock，供 ChatPage 及外部调用。
 */

/* exported ChatShellDock */

export const ChatShellDock = (() => {

  const Session = window.ChatSession;

  /** 当前 session 后台 shell 任务内存缓存（权威源：服务端 session 文件 + WS bgTasks） */
  let shellDockTaskCache = [];
  let shellDockResyncTimer = null;
  let shellDockFetchGeneration = 0;

  function tryMount() {
    if (!window.EtlShellDock || typeof window.EtlShellDock.mount !== 'function') return;
    const host = document.getElementById('etl-shell-dock-host');
    if (host) window.EtlShellDock.mount(host);
  }

  function scheduleResync() {
    if (shellDockResyncTimer) clearTimeout(shellDockResyncTimer);
    shellDockResyncTimer = setTimeout(() => {
      shellDockResyncTimer = null;
      sync();
    }, 80);
    setTimeout(sync, 450);
  }

  function isRunningTask(t) {
    if (window.EtlShellDock && typeof window.EtlShellDock.isRunningTask === 'function') {
      return window.EtlShellDock.isRunningTask(t);
    }
    return !!(t && t.taskId && t.status === 'running' && !t.isTerminal);
  }

  function mergeTasks(tasks) {
    if (!Array.isArray(tasks)) return;
    for (let i = 0; i < tasks.length; i++) {
      const t = tasks[i];
      if (!t || !t.taskId) continue;
      if (!isRunningTask(t)) {
        shellDockTaskCache = shellDockTaskCache.filter((row) =>  row && row.taskId !== t.taskId);
        continue;
      }
      let found = -1;
      for (let j = 0; j < shellDockTaskCache.length; j++) {
        if (shellDockTaskCache[j].taskId === t.taskId) {
          found = j;
          break;
        }
      }
      if (found >= 0) shellDockTaskCache[found] = t;
      else shellDockTaskCache.push(t);
    }
  }

  function sync() {
    tryMount();
    if (window.EtlShellDock && typeof window.EtlShellDock.hydrate === 'function') {
      window.EtlShellDock.hydrate(shellDockTaskCache);
    }
  }

  function replaceTasks(tasks) {
    if (!Array.isArray(tasks)) {
      scheduleResync();
      return;
    }
    shellDockTaskCache = tasks.filter(isRunningTask);
    sync();
    scheduleResync();
  }

  function fetchSessionBgTasks(sessionId, callback) {
    const sid = sessionId || (Session.getActiveId ? Session.getActiveId() : 'default');
    const generation = ++shellDockFetchGeneration;
    fetch(`/api/sessions/${encodeURIComponent(sid)}/bg-tasks`, { cache: 'no-store' })
      .then((res) =>  res.ok ? res.json() : { tasks: [] })
      .then((body) => {
        if (generation !== shellDockFetchGeneration) return;
        const tasks = body && Array.isArray(body.tasks) ? body.tasks : [];
        if (callback) callback(tasks);
      })
      .catch(() => {
        if (generation !== shellDockFetchGeneration) return;
        if (callback) callback([]);
      });
  }

  /** WS bgTasks 优先；缺失时 REST 读 session 文件（跨端同步）。 */
  function hydrate(sessionId, wsTasks) {
    if (Array.isArray(wsTasks)) {
      replaceTasks(wsTasks);
      return;
    }
    fetchSessionBgTasks(sessionId, (tasks) => {
      replaceTasks(tasks);
    });
  }

  function clearCache(sessionId) {
    const activeId = Session.getActiveId ? Session.getActiveId() : 'default';
    const sid = sessionId || activeId;
    if (sid === activeId) {
      shellDockTaskCache = [];
      sync();
    }
  }

  /** 注册 EtlShellDock 任务移除回调（render 时调用一次）。 */
  function initTaskRemovedHandler() {
    if (window.EtlShellDock && window.EtlShellDock.setTaskRemovedHandler) {
      window.EtlShellDock.setTaskRemovedHandler((taskId) => {
        if (!taskId) return;
        shellDockTaskCache = shellDockTaskCache.filter((t) =>  t && t.taskId !== taskId);
        // 原 chat-page.js:2499 调用未定义的 persistShellDockCache（严格模式会抛 ReferenceError，
        // 属既有 bug）；拆分时移除该无效调用，回调仅做缓存过滤。
      });
    }
  }

  return {
    tryMount,
    scheduleResync,
    mergeTasks,
    sync,
    replaceTasks,
    hydrate,
    clearCache,
    initTaskRemovedHandler,
  };
})();

if (typeof window !== 'undefined') {
  window.ChatShellDock = ChatShellDock;
}
