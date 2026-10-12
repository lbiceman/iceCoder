# Skills / Scheduled Tasks Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 将现有技能页升级为“技能/任务”，并实现一个持久化、单 `setTimeout` 驱动、可按秒/分/时/天重复执行提示词和可选技能的定时任务系统。

**Architecture:** 定时任务由独立 JSON Store 持久化，Scheduler 始终只持有一个计时器并在每次唤醒后重扫最近任务。HTTP API 负责 CRUD、启停、立即执行和专属会话创建；执行器把任务写入现有会话队列，队列终态通过轻量事件桥回写任务状态。前端在保留 `#/skills` 路由的前提下拆为技能和定时任务两个页签。

**Tech Stack:** TypeScript 6、Node.js 22、Express 5、Vitest 4、原生 DOM/CSS、现有 WebSocket/Harness 会话队列。

## Global Constraints

- 调度主循环必须是“醒来 → 执行到点任务 → 重扫任务表 → 找最近时间 → `setTimeout` 睡眠”，不能改为 `setInterval` 或每任务一个计时器。
- 间隔单位只能是 `second | minute | hour | day`，数值只能是正整数。
- 每个任务绑定一个自动创建且长期复用的独立会话。
- `skillFilenames` 可以为空，也可以包含任意多个技能。
- 新建启用任务在一个完整间隔后首次执行。
- 重启时跳过全部错过次数，只保留未来最近一次。
- 立即执行不得改变原有 `nextRunAt`。
- 保留现有 `#/skills`、`#/m/skills` 和 `/m/skills` 路由。
- 不覆盖或提交当前工作区内与本功能无关的用户改动。

---

## File Structure

### New files

- `src/session/scheduled-task-store.ts`：任务类型、间隔换算、校验、JSON 原子持久化和串行 CRUD。
- `src/session/scheduled-task-scheduler.ts`：单计时器调度循环、过期推进、长超时分段和立即执行。
- `src/session/scheduled-task-events.ts`：队列执行终态到任务 Store 的解耦事件桥。
- `src/web/session-create.ts`：REST 和定时任务共用的专属会话创建函数。
- `src/web/scheduled-task-runtime.ts`：技能解析、队列投递、无客户端执行和终态回写。
- `src/web/routes/scheduled-tasks.ts`：定时任务 HTTP API。
- `src/public/js/scheduled-tasks-page.ts`：任务列表、表单、倒计时和操作行为。
- `src/public/css/scheduled-tasks.css`：桌面和移动端任务 UI。
- `test/session/scheduled-task-store.test.ts`：Store 与时间计算单测。
- `test/session/scheduled-task-scheduler.test.ts`：单计时器调度单测。
- `test/web/scheduled-task-runtime.test.ts`：队列投递和终态回写测试。
- `test/web/scheduled-tasks-route.test.ts`：API 集成测试。
- `test/public/scheduled-tasks-page.test.ts`：前端源码与 DOM 行为约定测试。

### Modified files

- `src/session/task-queue.ts`：队列项携带可选 `scheduledTaskId`。
- `src/web/chat-ws-loop.ts`：透传任务来源 ID，并在运行终态发事件。
- `src/web/routes/sessions.ts`：复用 `createSessionRecord`。
- `src/cli/commands/serve.ts`：挂载 API、启动 Scheduler、关闭时清理。
- `src/public/js/skills-page.ts`：升级页面标题和页签容器。
- `src/public/js/main.ts`：加载任务页模块。
- `src/public/js/chat-session-sidebar.ts`：入口文案改为“技能/任务”。
- `src/public/js/shell/mobile-shell.ts`：移动端入口和顶栏文案改为“技能/任务”。
- `src/public/js/pages/mobile/mobile-skills-page.ts`：移动端错误文案同步。
- `src/public/css/style.css`：导入任务样式。
- `test/cli/serve-routes-parity.test.ts`：要求 `/api/scheduled-tasks` 已挂载。
- `test/public/chat-multi-session-switch.test.ts`：更新入口文案断言。

---

### Task 1: Scheduled Task Store

**Files:**
- Create: `src/session/scheduled-task-store.ts`
- Create: `test/session/scheduled-task-store.test.ts`

**Interfaces:**
- Produces:
  - `type ScheduledTaskIntervalUnit = 'second' | 'minute' | 'hour' | 'day'`
  - `interface ScheduledTask`
  - `intervalToMs(value, unit): number`
  - `advanceToFuture(nextRunAt, intervalMs, now): number`
  - `class ScheduledTaskStore`
  - `list()`, `get(id)`, `create(input)`, `update(id, patch)`, `remove(id)`, `replaceNextRunAt(id, nextRunAt)`, `updateRunState(id, patch)`

- [ ] **Step 1: Write failing interval and validation tests**

```ts
import { afterEach, describe, expect, it } from 'vitest';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {
  ScheduledTaskStore,
  advanceToFuture,
  intervalToMs,
} from '../../src/session/scheduled-task-store.js';

describe('scheduled task store', () => {
  const dirs: string[] = [];
  afterEach(async () => Promise.all(dirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true }))));

  async function fixture() {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'ice-scheduled-'));
    dirs.push(dir);
    return new ScheduledTaskStore(path.join(dir, 'scheduled-tasks.json'), () => 1_000);
  }

  it('只支持秒分时天并换算为毫秒', () => {
    expect(intervalToMs(2, 'second')).toBe(2_000);
    expect(intervalToMs(2, 'minute')).toBe(120_000);
    expect(intervalToMs(2, 'hour')).toBe(7_200_000);
    expect(intervalToMs(2, 'day')).toBe(172_800_000);
  });

  it('把错过多次的时间直接推进到未来', () => {
    expect(advanceToFuture(1_000, 1_000, 4_500)).toBe(5_000);
    expect(advanceToFuture(5_000, 1_000, 4_500)).toBe(5_000);
  });

  it('创建启用任务时等待一个完整间隔', async () => {
    const store = await fixture();
    const task = await store.create({
      name: '日报',
      prompt: '生成日报',
      skillFilenames: [],
      intervalValue: 5,
      intervalUnit: 'minute',
      sessionId: 'session-1',
      enabled: true,
    });
    expect(task.nextRunAt).toBe(301_000);
    expect((await store.list())).toEqual([task]);
  });

  it('拒绝空名称、空提示词、非正整数和非法单位', async () => {
    const store = await fixture();
    await expect(store.create({
      name: ' ',
      prompt: 'x',
      skillFilenames: [],
      intervalValue: 1,
      intervalUnit: 'second',
      sessionId: 'session-1',
      enabled: true,
    })).rejects.toThrow('任务名称不能为空');
    await expect(store.create({
      name: 'x',
      prompt: ' ',
      skillFilenames: [],
      intervalValue: 0,
      intervalUnit: 'second',
      sessionId: 'session-1',
      enabled: true,
    })).rejects.toThrow('任务提示词不能为空');
  });
});
```

- [ ] **Step 2: Run tests and verify RED**

Run: `npx vitest --run test/session/scheduled-task-store.test.ts`

Expected: FAIL because `src/session/scheduled-task-store.ts` does not exist.

- [ ] **Step 3: Implement types, validation, serialized mutations, and atomic JSON persistence**

Use `writeFileAtomic` from `src/memory/file-memory/atomic-write.ts`. Keep one `opTail: Promise<void>` in the Store and run every mutation behind it. Normalize strings with `trim()`, deduplicate `skillFilenames`, clone all returned objects, and persist `{ version: 1, tasks }`.

```ts
export interface ScheduledTask {
  id: string;
  name: string;
  prompt: string;
  skillFilenames: string[];
  intervalValue: number;
  intervalUnit: ScheduledTaskIntervalUnit;
  sessionId: string;
  enabled: boolean;
  createdAt: number;
  updatedAt: number;
  lastRunAt: number | null;
  nextRunAt: number | null;
  lastStatus: 'idle' | 'queued' | 'success' | 'error';
  lastError: string | null;
}

export function advanceToFuture(nextRunAt: number, intervalMs: number, now: number): number {
  if (nextRunAt > now) return nextRunAt;
  return nextRunAt + (Math.floor((now - nextRunAt) / intervalMs) + 1) * intervalMs;
}
```

`update()` must preserve `id/sessionId/createdAt`; changing interval or changing disabled → enabled resets `nextRunAt` to `now + interval`; disabling sets it to `null`. `updateRunState()` may only alter `lastRunAt/lastStatus/lastError`.

- [ ] **Step 4: Add CRUD, reload, and concurrent write tests**

Add tests proving edit/delete survive constructing a second Store for the same file, disabled tasks have `nextRunAt: null`, and `Promise.all` of multiple creates does not lose rows.

- [ ] **Step 5: Run Store tests and commit**

Run: `npx vitest --run test/session/scheduled-task-store.test.ts`

Expected: all tests PASS.

```bash
git add src/session/scheduled-task-store.ts test/session/scheduled-task-store.test.ts
git commit -m "feat(tasks): add scheduled task store"
```

---

### Task 2: Single-Timer Scheduler

**Files:**
- Create: `src/session/scheduled-task-scheduler.ts`
- Create: `test/session/scheduled-task-scheduler.test.ts`

**Interfaces:**
- Consumes: `ScheduledTaskStore`, `ScheduledTask`, `advanceToFuture`, `intervalToMs`
- Produces:
  - `const MAX_TIMEOUT_MS = 2_147_000_000`
  - `class ScheduledTaskScheduler`
  - `start(): Promise<void>`
  - `stop(): void`
  - `reschedule(): Promise<void>`
  - `runNow(id: string): Promise<void>`

- [ ] **Step 1: Write failing fake-timer tests**

```ts
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ScheduledTaskScheduler } from '../../src/session/scheduled-task-scheduler.js';

describe('ScheduledTaskScheduler', () => {
  beforeEach(() => vi.useFakeTimers());

  it('任何时刻只安排最近任务的一个 setTimeout', async () => {
    const execute = vi.fn(async () => {});
    const store = fakeStore([
      task({ id: 'later', nextRunAt: 20_000 }),
      task({ id: 'near', nextRunAt: 10_000 }),
    ]);
    const scheduler = new ScheduledTaskScheduler({ store, execute, now: () => Date.now() });
    vi.setSystemTime(0);
    await scheduler.start();
    expect(vi.getTimerCount()).toBe(1);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(execute).toHaveBeenCalledWith(expect.objectContaining({ id: 'near' }));
    expect(vi.getTimerCount()).toBe(1);
  });

  it('同一时刻到点的任务全部执行且单个失败不阻断', async () => {
    const execute = vi.fn(async (item) => {
      if (item.id === 'bad') throw new Error('boom');
    });
    const store = fakeStore([
      task({ id: 'bad', nextRunAt: 1_000 }),
      task({ id: 'good', nextRunAt: 1_000 }),
    ]);
    const scheduler = new ScheduledTaskScheduler({ store, execute, now: () => Date.now() });
    vi.setSystemTime(0);
    await scheduler.start();
    await vi.advanceTimersByTimeAsync(1_000);
    expect(execute).toHaveBeenCalledTimes(2);
  });

  it('立即执行不修改周期时间', async () => {
    const execute = vi.fn(async () => {});
    const item = task({ id: 'manual', nextRunAt: 9_000 });
    const store = fakeStore([item]);
    const scheduler = new ScheduledTaskScheduler({ store, execute, now: () => Date.now() });
    await scheduler.runNow('manual');
    expect(execute).toHaveBeenCalledWith(item);
    expect(store.replaceNextRunAt).not.toHaveBeenCalledWith('manual', expect.anything());
  });
});
```

Test helpers `task()` and `fakeStore()` must implement the actual Store methods used by Scheduler (`list`, `get`, `replaceNextRunAt`, `updateRunState`) and return cloned tasks.

- [ ] **Step 2: Run tests and verify RED**

Run: `npx vitest --run test/session/scheduled-task-scheduler.test.ts`

Expected: FAIL because Scheduler module does not exist.

- [ ] **Step 3: Implement the wake/scan/sleep loop**

Scheduler behavior:

```ts
private async wake(): Promise<void> {
  if (!this.running) return;
  const now = this.now();
  const due = (await this.store.list())
    .filter((task) => task.enabled && task.nextRunAt !== null && task.nextRunAt <= now);

  for (const task of due) {
    const next = advanceToFuture(
      task.nextRunAt!,
      intervalToMs(task.intervalValue, task.intervalUnit),
      now,
    );
    await this.store.replaceNextRunAt(task.id, next);
  }
  await Promise.allSettled(due.map((task) => this.trigger(task)));
  await this.armNearest();
}
```

`armNearest()` clears the previous timer, scans enabled tasks, and schedules exactly one timeout with `Math.min(Math.max(0, nearest - now), MAX_TIMEOUT_MS)`. `start()` first advances all stale enabled tasks to the future (without execution), then arms. `reschedule()` serializes against an active wake to prevent duplicate timers. `stop()` clears the timer and sets `running = false`.

`trigger()` first writes `{ lastRunAt: now, lastStatus: 'queued', lastError: null }`. If queue delivery itself throws, it writes `{ lastStatus: 'error', lastError: message }` and rethrows; successful Harness completion is handled by Task 3's result event.

- [ ] **Step 4: Add restart-skip, reschedule, stop, and long-delay tests**

Prove:
- `start()` advances stale tasks without calling `execute`.
- adding/enabling a nearer task then calling `reschedule()` replaces, rather than adds, the timer.
- `stop()` leaves `vi.getTimerCount() === 0`.
- a target later than `MAX_TIMEOUT_MS` schedules the capped delay and does not execute early.

- [ ] **Step 5: Run Scheduler tests and commit**

Run: `npx vitest --run test/session/scheduled-task-scheduler.test.ts`

Expected: all tests PASS.

```bash
git add src/session/scheduled-task-scheduler.ts test/session/scheduled-task-scheduler.test.ts
git commit -m "feat(tasks): add single timer scheduler"
```

---

### Task 3: Dedicated Sessions and Queue Lifecycle

**Files:**
- Create: `src/web/session-create.ts`
- Create: `src/session/scheduled-task-events.ts`
- Create: `src/web/scheduled-task-runtime.ts`
- Modify: `src/web/routes/sessions.ts`
- Modify: `src/session/task-queue.ts`
- Modify: `src/web/chat-ws-loop.ts`
- Create: `test/web/scheduled-task-runtime.test.ts`
- Modify: `test/web/chat-ws-loop.test.ts`

**Interfaces:**
- Produces:
  - `createSessionRecord(title: string): Promise<SessionMeta>`
  - `registerScheduledTaskResultHandler(handler | null): void`
  - `notifyScheduledTaskResult(result): Promise<void>`
  - `createScheduledTaskExecutor(deps): (task: ScheduledTask) => Promise<void>`
- Queue extension: `scheduledTaskId?: string` on `QueuedTask`, `TaskEnqueueInput`, and `PendingChatMessage`

- [ ] **Step 1: Write failing runtime tests**

Test that:

```ts
it('把提示词和任意多个技能作为一条带来源 ID 的队列任务投递', async () => {
  const enqueue = vi.fn(async () => {});
  const execute = createScheduledTaskExecutor({
    chatDeps,
    listSkillFilenames: async () => new Set(['review.md', 'report.md']),
    enqueue,
  });
  await execute(task({
    id: 'scheduled-1',
    prompt: '检查项目并生成报告',
    skillFilenames: ['review.md', 'missing.md', 'report.md'],
  }));
  expect(enqueue).toHaveBeenCalledWith(
    expect.anything(),
    expect.any(String),
    expect.objectContaining({ readyState: WebSocket.CLOSED }),
    expect.objectContaining({
      scheduledTaskId: 'scheduled-1',
      skills: ['review.md', 'report.md'],
      text: '#review.md\n#report.md\n检查项目并生成报告',
    }),
  );
});
```

Also test `notifyScheduledTaskResult` updates status to `success` for terminal phase `done`, `error` otherwise, and ignores a deleted task.

- [ ] **Step 2: Run runtime tests and verify RED**

Run: `npx vitest --run test/web/scheduled-task-runtime.test.ts`

Expected: FAIL because runtime/event modules do not exist.

- [ ] **Step 3: Extract reusable session creation**

Move the body of `POST /api/sessions` into `createSessionRecord(title)`. It must create an 8-character ID, prepend `SessionMeta` through `mutateSessionIndex`, create `{sessionId}.json` containing `[]`, and return the metadata. Keep `sessionListLiveSync?.notifyIndexUpdated()` in the route after the service succeeds.

- [ ] **Step 4: Preserve scheduled source metadata through the queue**

Add `scheduledTaskId?: string` to queue and pending types, copy it in `toQueuedTask()` and `queuedTaskToPending()`. In the terminal path of `runSessionMessageLoop`, call:

```ts
if (first.scheduledTaskId && terminalPhase && terminalPhase !== 'running') {
  await notifyScheduledTaskResult({
    taskId: first.scheduledTaskId,
    success: terminalPhase === 'done',
    error: terminalPhase === 'done'
      ? null
      : (terminalReason ? `任务结束：${terminalReason}` : '任务执行失败'),
  });
}
```

Do this before relaying the next queue item so each scheduled task receives its own terminal event.

- [ ] **Step 5: Implement the headless scheduled executor**

Use a closed no-op WebSocket object so the Harness runs even when no browser is connected; normal progress still goes through `broadcastToSession`.

```ts
const headlessWs = {
  readyState: WebSocket.CLOSED,
  send() {},
} as unknown as WebSocket;
```

Resolve current skill filenames before each run, silently omit deleted skill refs from the message, pass valid filenames in `skills`, set `source: 'implicit'`, generate a `messageId`, and call `persistImplicitQueuedUserMessage` before `enqueueAndMaybeKickoff`.

The event bridge stores one process-wide handler with this exact shape:

```ts
export interface ScheduledTaskResult {
  taskId: string;
  success: boolean;
  error: string | null;
}

export type ScheduledTaskResultHandler =
  (result: ScheduledTaskResult) => void | Promise<void>;
```

- [ ] **Step 6: Run runtime and queue tests and commit**

Run: `npx vitest --run test/web/scheduled-task-runtime.test.ts test/web/chat-ws-loop.test.ts test/web/session-title.test.ts`

Expected: all tests PASS.

```bash
git add src/web/session-create.ts src/session/scheduled-task-events.ts src/web/scheduled-task-runtime.ts src/web/routes/sessions.ts src/session/task-queue.ts src/web/chat-ws-loop.ts test/web/scheduled-task-runtime.test.ts test/web/chat-ws-loop.test.ts
git commit -m "feat(tasks): run scheduled prompts in dedicated sessions"
```

---

### Task 4: HTTP API and Server Lifecycle

**Files:**
- Create: `src/web/routes/scheduled-tasks.ts`
- Create: `test/web/scheduled-tasks-route.test.ts`
- Modify: `src/cli/commands/serve.ts`
- Modify: `test/cli/serve-routes-parity.test.ts`

**Interfaces:**
- `createScheduledTasksRouter({ store, scheduler, createSession }): Router`
- Routes: `GET /`, `POST /`, `PUT /:id`, `DELETE /:id`, `POST /:id/toggle`, `POST /:id/run`

- [ ] **Step 1: Write failing API tests**

Mount the router on a temporary Express app and inject a temporary Store, fake Scheduler, and fake `createSession`. Assert:
- `POST /` returns 200, creates `"定时任务：<name>"` session, stores its ID, and calls `reschedule()`.
- invalid interval and blank prompt return 400 with `{ success: false, error }`.
- `PUT`, toggle, delete call `reschedule()`.
- run calls `runNow(id)` but preserves `nextRunAt`.
- unknown IDs return 404.

```ts
const response = await fetch(`${baseUrl}/api/scheduled-tasks`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({
    name: '日报',
    prompt: '生成日报',
    skillFilenames: [],
    intervalValue: 1,
    intervalUnit: 'day',
    enabled: true,
  }),
});
expect(await response.json()).toMatchObject({
  success: true,
  task: { name: '日报', sessionId: 'task-session' },
});
```

- [ ] **Step 2: Run route tests and verify RED**

Run: `npx vitest --run test/web/scheduled-tasks-route.test.ts`

Expected: FAIL because the router does not exist.

- [ ] **Step 3: Implement API error mapping**

Return `{ success: true, task/tasks }` on success. Map validation errors to 400, unknown tasks to 404, and unexpected errors to 500. DELETE preserves the dedicated session.

- [ ] **Step 4: Wire the runtime into `startWebServer`**

Before `createServer`, construct:

```ts
const scheduledTaskStore = new ScheduledTaskStore(
  path.join(paths.dataDir, 'scheduled-tasks.json'),
);
const scheduledTaskScheduler = new ScheduledTaskScheduler({
  store: scheduledTaskStore,
  execute: createScheduledTaskExecutor({
    chatDeps: { orchestrator, toolRegistry, toolExecutor, mcpManager },
  }),
});
```

Mount `{ path: '/api/scheduled-tasks', router: createScheduledTasksRouter(...) }`. After `attachChatWebSocket`, register the result handler and `await scheduledTaskScheduler.start()`. In `cleanup`, unregister the result handler and call `scheduledTaskScheduler.stop()` before cleaning chat resources.

Register the terminal callback explicitly:

```ts
registerScheduledTaskResultHandler(async ({ taskId, success, error }) => {
  await scheduledTaskStore.updateRunState(taskId, {
    lastStatus: success ? 'success' : 'error',
    lastError: error,
  });
});
```

Add `/api/scheduled-tasks` to `REQUIRED_API_PREFIXES`.

- [ ] **Step 5: Run route/parity tests and commit**

Run: `npx vitest --run test/web/scheduled-tasks-route.test.ts test/cli/serve-routes-parity.test.ts`

Expected: all tests PASS.

```bash
git add src/web/routes/scheduled-tasks.ts src/cli/commands/serve.ts test/web/scheduled-tasks-route.test.ts test/cli/serve-routes-parity.test.ts
git commit -m "feat(tasks): expose scheduled task API"
```

---

### Task 5: Skills / Tasks UI

**Files:**
- Create: `src/public/js/scheduled-tasks-page.ts`
- Create: `src/public/css/scheduled-tasks.css`
- Create: `test/public/scheduled-tasks-page.test.ts`
- Modify: `src/public/js/skills-page.ts`
- Modify: `src/public/js/main.ts`
- Modify: `src/public/js/chat-session-sidebar.ts`
- Modify: `src/public/js/shell/mobile-shell.ts`
- Modify: `src/public/js/pages/mobile/mobile-skills-page.ts`
- Modify: `src/public/css/style.css`
- Modify: `test/public/chat-multi-session-switch.test.ts`

**Interfaces:**
- `window.ScheduledTasksPage.render(parentEl)`
- `window.ScheduledTasksPage.activate()`
- `window.ScheduledTasksPage.destroy()`
- Existing `SkillsPage.render/destroy` remains the router-facing page.

- [ ] **Step 1: Write failing frontend contract tests**

Read source files as UTF-8 and assert:

```ts
expect(sidebarSource).toContain('chat-sidebar-nav-btn-label">技能/任务</span>');
expect(mobileShellSource).toContain("label: '技能/任务'");
expect(skillsPageSource).toContain('data-skills-tab="skills"');
expect(skillsPageSource).toContain('data-skills-tab="tasks"');
expect(tasksPageSource).toContain("fetch('/api/scheduled-tasks'");
expect(tasksPageSource).toContain("intervalUnit");
expect(tasksPageSource).toContain("['second', 'minute', 'hour', 'day']");
expect(tasksPageSource).toContain("data-action=\"run\"");
expect(tasksPageSource).toContain("data-action=\"toggle\"");
expect(tasksPageSource).toContain("data-action=\"open-session\"");
```

Also assert `style.css` imports `scheduled-tasks.css` and `main.ts` imports `scheduled-tasks-page.ts`.

- [ ] **Step 2: Run frontend tests and verify RED**

Run: `npx vitest --run test/public/scheduled-tasks-page.test.ts test/public/chat-multi-session-switch.test.ts`

Expected: FAIL because the task page and new copy do not exist.

- [ ] **Step 3: Convert SkillsPage into a two-tab host**

Header title becomes “技能/任务”. Add accessible tab buttons “技能” and “定时任务”; preserve the existing skill list/detail DOM in the skill panel. When selecting tasks, hide the skill panel, show a task panel, and call `ScheduledTasksPage.activate()`. `destroy()` must remove tab listeners and call `ScheduledTasksPage.destroy()`.

- [ ] **Step 4: Implement task rendering and operations**

The task page must:
- fetch tasks and skills in parallel;
- render loading, empty, error, and card states;
- show enabled/disabled badge, `每 N 秒/分/时/天`, next-run absolute time and countdown, latest status, and skill chips;
- update countdown text once per second only while active;
- expose create/edit form with name, prompt textarea, checkbox skill list, positive integer interval, and four-unit select;
- call POST/PUT/toggle/run/delete endpoints;
- confirm destructive delete with `Modal.confirm`;
- open the dedicated session through `ChatSessionStore.switchSession`, then navigate to desktop `#/chat` or mobile work route;
- refresh after every mutation and show `Notification.success/error`.

Escape every server-provided string through the existing text-node `escapeHtml` pattern. Disable submit/run buttons while requests are in flight.

- [ ] **Step 5: Add responsive CSS**

Use existing tokens only. Desktop: task toolbar + responsive card grid, maximum two columns. Mobile (`max-width: 720px`): one column, sticky form actions, touch targets at least 40px, no skills-page desktop header. Do not introduce hard-coded light/dark colors.

- [ ] **Step 6: Run frontend tests, typecheck web, and commit**

Run:

```bash
npx vitest --run test/public/scheduled-tasks-page.test.ts test/public/chat-multi-session-switch.test.ts
npm run lint:web
```

Expected: tests PASS and TypeScript exits 0.

```bash
git add src/public/js/scheduled-tasks-page.ts src/public/css/scheduled-tasks.css src/public/js/skills-page.ts src/public/js/main.ts src/public/js/chat-session-sidebar.ts src/public/js/shell/mobile-shell.ts src/public/js/pages/mobile/mobile-skills-page.ts src/public/css/style.css test/public/scheduled-tasks-page.test.ts test/public/chat-multi-session-switch.test.ts
git commit -m "feat(ui): add skills and scheduled tasks page"
```

---

### Task 6: Integration, Regression, and Delivery Report

**Files:**
- Modify only files required by failures directly caused by Tasks 1-5.

- [ ] **Step 1: Run focused feature suite**

Run:

```bash
npx vitest --run \
  test/session/scheduled-task-store.test.ts \
  test/session/scheduled-task-scheduler.test.ts \
  test/web/scheduled-task-runtime.test.ts \
  test/web/scheduled-tasks-route.test.ts \
  test/public/scheduled-tasks-page.test.ts \
  test/cli/serve-routes-parity.test.ts
```

Expected: all tests PASS with zero unhandled errors.

- [ ] **Step 2: Run the full automated suite**

Run: `npm test`

Expected: Vitest exits 0. Fix only regressions caused by this feature; report unrelated pre-existing failures separately with exact test names.

- [ ] **Step 3: Run static checks**

Run: `npm run lint`

Expected: both server and web TypeScript checks exit 0.

- [ ] **Step 4: Build the web application**

Run: `npm run build:web`

Expected: Vite build exits 0 and emits the web bundle.

- [ ] **Step 5: Perform manual smoke test**

Start the development server with `npm run dev`, then verify:
1. desktop and mobile entries display “技能/任务”;
2. skill list/detail/use behavior remains intact;
3. create a 5-second prompt-only task and observe it execute in its dedicated session;
4. create a task with two skills and verify both chips and injected behavior;
5. disable it and verify countdown/execution stops;
6. “立即执行” runs without changing the scheduled next time;
7. restart the server after missing a run and verify it does not catch up;
8. edit interval to seconds/minutes/hours/days and verify the next time recalculates;
9. delete the task and verify its historical session remains accessible.

- [ ] **Step 6: Review diff and commit final fixes**

Run:

```bash
git diff --check
git status --short
```

Confirm unrelated pre-existing changes remain untouched and unstaged.

```bash
git add src/session/scheduled-task-store.ts src/session/scheduled-task-scheduler.ts src/session/scheduled-task-events.ts src/session/task-queue.ts src/web/session-create.ts src/web/scheduled-task-runtime.ts src/web/routes/scheduled-tasks.ts src/web/routes/sessions.ts src/web/chat-ws-loop.ts src/cli/commands/serve.ts src/public/js/scheduled-tasks-page.ts src/public/css/scheduled-tasks.css src/public/js/skills-page.ts src/public/js/main.ts src/public/js/chat-session-sidebar.ts src/public/js/shell/mobile-shell.ts src/public/js/pages/mobile/mobile-skills-page.ts src/public/css/style.css test/session/scheduled-task-store.test.ts test/session/scheduled-task-scheduler.test.ts test/web/scheduled-task-runtime.test.ts test/web/scheduled-tasks-route.test.ts test/web/chat-ws-loop.test.ts test/public/scheduled-tasks-page.test.ts test/public/chat-multi-session-switch.test.ts test/cli/serve-routes-parity.test.ts
git commit -m "test(tasks): verify scheduled task workflow"
```

Skip the final commit if no files changed during verification.
