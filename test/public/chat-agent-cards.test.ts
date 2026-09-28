import { readFileSync } from 'node:fs';
import path from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';

/**
 * 最小 DOM，只覆盖卡片模块实际用到的查询和事件。
 * 卡片逻辑在浏览器里跑；这里验证分组、折叠、轨迹条数和历史分流，不依赖页面。
 */
class ClassList {
  tokens = new Set<string>();

  add(...names: string[]): void {
    for (const name of names) if (name) this.tokens.add(name);
  }

  contains(name: string): boolean {
    return this.tokens.has(name);
  }

  toggle(name: string, force?: boolean): boolean {
    const on = force === undefined ? !this.tokens.has(name) : force;
    if (on) this.tokens.add(name);
    else this.tokens.delete(name);
    return on;
  }

  remove(...names: string[]): void {
    for (const name of names) this.tokens.delete(name);
  }

  replaceAll(value: string): void {
    this.tokens = new Set(value.split(/\s+/).filter(Boolean));
  }
}

class DomEl {
  tagName: string;
  classList = new ClassList(this);
  children: DomEl[] = [];
  parentElement: DomEl | null = null;
  attrs: Record<string, string> = {};
  listeners: Record<string, Array<(ev: DomEvent) => void>> = {};
  hidden = false;
  disabled = false;
  textContent = '';
  style: Record<string, string> = {};
  type = '';
  constructor(tag: string) {
    this.tagName = tag.toUpperCase();
  }

  get className(): string {
    return [...this.classList.tokens].join(' ');
  }

  set className(value: string) {
    this.classList.replaceAll(value);
  }

  setAttribute(name: string, value: string): void {
    this.attrs[name] = value;
  }

  getAttribute(name: string): string | null {
    return this.attrs[name] ?? null;
  }

  appendChild(child: DomEl): DomEl {
    if (child.parentElement) {
      const index = child.parentElement.children.indexOf(child);
      if (index >= 0) child.parentElement.children.splice(index, 1);
    }
    child.parentElement = this;
    this.children.push(child);
    return child;
  }

  insertBefore(child: DomEl, before: DomEl | null): DomEl {
    child.parentElement = this;
    const index = before ? this.children.indexOf(before) : -1;
    if (index < 0) this.children.push(child);
    else this.children.splice(index, 0, child);
    return child;
  }

  remove(): void {
    if (!this.parentElement) return;
    const index = this.parentElement.children.indexOf(this);
    if (index >= 0) this.parentElement.children.splice(index, 1);
    this.parentElement = null;
  }

  addEventListener(type: string, fn: (ev: DomEvent) => void): void {
    (this.listeners[type] ??= []).push(fn);
  }

  get firstChild(): DomEl | null {
    return this.children[0] ?? null;
  }

  get previousElementSibling(): DomEl | null {
    if (!this.parentElement) return null;
    const index = this.parentElement.children.indexOf(this);
    return index > 0 ? this.parentElement.children[index - 1]! : null;
  }

  get nextElementSibling(): DomEl | null {
    if (!this.parentElement) return null;
    const index = this.parentElement.children.indexOf(this);
    return this.parentElement.children[index + 1] ?? null;
  }

  set innerHTML(_value: string) {
    this.children = [];
  }

  querySelector(selector: string): DomEl | null {
    return this.querySelectorAll(selector)[0] ?? null;
  }

  querySelectorAll(selector: string): DomEl[] {
    return collect(this).filter(node => node !== this && matches(node, selector, this));
  }

  click(): void {
    dispatch(this, 'click');
  }
}

interface DomEvent {
  target: DomEl;
  key?: string;
  stopped: boolean;
  stopPropagation(): void;
  preventDefault(): void;
}

function collect(root: DomEl): DomEl[] {
  const out: DomEl[] = [];
  const walk = (node: DomEl) => {
    out.push(node);
    for (const child of node.children) walk(child);
  };
  walk(root);
  return out;
}

function matchSimple(el: DomEl, selector: string): boolean {
  let rest = selector.trim();
  if (!rest) return false;
  const tag = /^[a-z]+/i.exec(rest);
  if (tag) {
    if (el.tagName !== tag[0].toUpperCase()) return false;
    rest = rest.slice(tag[0].length);
  }
  while (rest.startsWith('.')) {
    const found = /^\.([A-Za-z0-9_-]+)/.exec(rest);
    if (!found || !el.classList.contains(found[1]!)) return false;
    rest = rest.slice(found[0].length);
  }
  while (rest.startsWith('[')) {
    const found = /^\[([^\]=]+)="([^"]*)"\]/.exec(rest);
    if (!found || el.getAttribute(found[1]!) !== found[2]) return false;
    rest = rest.slice(found[0].length);
  }
  return rest === '';
}

function matches(el: DomEl, selector: string, scope: DomEl): boolean {
  const direct = selector.startsWith(':scope > ');
  const body = direct ? selector.slice(':scope > '.length) : selector;
  if (direct) {
    return el.parentElement === scope && matchSimple(el, body);
  }
  const parts = body.split(/\s+/).filter(Boolean);
  const matchChain = (node: DomEl, index: number): boolean => {
    if (!matchSimple(node, parts[index]!)) return false;
    if (index === 0) return true;
    let parent = node.parentElement;
    while (parent) {
      if (matchChain(parent, index - 1)) return true;
      parent = parent.parentElement;
    }
    return false;
  };
  return matchChain(el, parts.length - 1);
}

function dispatch(target: DomEl, type: string, extra: Partial<DomEvent> = {}): void {
  const event: DomEvent = {
    target,
    stopped: false,
    stopPropagation() { this.stopped = true; },
    preventDefault() {},
    ...extra,
  };
  let node: DomEl | null = target;
  while (node) {
    for (const fn of node.listeners[type] ?? []) fn(event);
    if (event.stopped) break;
    node = node.parentElement;
  }
}

function installDom(): void {
  const documentElement = new DomEl('html');
  const body = new DomEl('body');
  documentElement.appendChild(body);
  const document = {
    documentElement,
    body,
    createElement: (tag: string) => new DomEl(tag),
    querySelector: (selector: string) => body.querySelector(selector),
    querySelectorAll: (selector: string) => body.querySelectorAll(selector),
    addEventListener: () => {},
  };
  const store = new Map<string, string>();
  const g = globalThis as typeof globalThis & {
    window: typeof globalThis;
    document: typeof document;
    localStorage: Storage;
    CSS?: { escape(value: string): string };
    fetch: typeof fetch;
  };
  g.window = g;
  g.document = document;
  g.localStorage = {
    getItem: (key) => store.get(key) ?? null,
    setItem: (key, value) => { store.set(key, value); },
    removeItem: (key) => { store.delete(key); },
    clear: () => { store.clear(); },
    key: () => null,
    length: 0,
  };
  g.CSS = { escape: (value) => value };
  g.fetch = (async (url: string) => {
    const href = String(url);
    if (href.includes('/messages')) {
      return {
        ok: true,
        json: async () => ({
          messages: [
            { role: 'user', content: '修复支付超时' },
            { role: 'assistant', content: '改完了', toolCalls: [{ name: 'edit_file', arguments: { path: 'src/pay.js' } }] },
            { role: 'tool', content: 'wrote src/pay.js' },
          ],
        }),
      };
    }
    if (/\/agents\/[^/]+$/.test(href)) {
      return { ok: true, json: async () => ({ agent: { report: 'FULL REPORT', prompt: '任务说明正文' } }) };
    }
    return { ok: true, json: async () => ({ agents: [] }) };
  }) as typeof fetch;
  (g as { Notification?: { show: () => void } }).Notification = { show: () => {} };
}

function toolBlock(id: string, detail: string): DomEl {
  const block = document.createElement('div') as unknown as DomEl;
  block.className = 'tool-action-row-block';
  block.setAttribute('data-tool-call-id', id);
  const row = document.createElement('div') as unknown as DomEl;
  row.className = 'tool-action';
  row.textContent = detail;
  block.appendChild(row);
  document.body.appendChild(block);
  return block;
}

let ChatAgentCards: typeof import('../../src/public/js/chat-agent-cards.ts').ChatAgentCards;
let ChatSession: typeof import('../../src/public/js/chat-session.ts').ChatSession;
let ChatAgentDrawer: typeof import('../../src/public/js/chat-agent-session-drawer.ts').ChatAgentDrawer;

beforeAll(async () => {
  installDom();
  (globalThis as { ChatUI?: unknown }).ChatUI = {
    createAgentToolRowBlock(name: string, detail: string, status: string, id: string) {
      const block = document.createElement('div') as unknown as DomEl;
      block.className = 'tool-action-row-block';
      block.setAttribute('data-tool-call-id', id);
      const row = document.createElement('div') as unknown as DomEl;
      row.className = 'tool-action';
      row.setAttribute('data-tool', name);
      const icon = document.createElement('span') as unknown as DomEl;
      icon.className = `tool-icon ${status}`;
      row.appendChild(icon);
      const text = document.createElement('span') as unknown as DomEl;
      text.textContent = detail;
      row.appendChild(text);
      block.appendChild(row);
      return block;
    },
    updateToolActionByCallId(id: string, _name: string, status: string) {
      const block = document.querySelector(`[data-tool-call-id="${id}"]`) as unknown as DomEl | null;
      const icon = block?.querySelector('.tool-icon') as DomEl | null;
      if (icon) icon.className = `tool-icon ${status}`;
    },
    notifyNodeLayoutChange() {},
    scrollToToolCall() { return true; },
  };
  (window as unknown as { ChatUI: unknown }).ChatUI = (globalThis as { ChatUI: unknown }).ChatUI;
  ChatSession = (await import('../../src/public/js/chat-session.ts')).ChatSession;
  ChatAgentCards = (await import('../../src/public/js/chat-agent-cards.ts')).ChatAgentCards;
  ChatAgentDrawer = (await import('../../src/public/js/chat-agent-session-drawer.ts')).ChatAgentDrawer;
});

function view(partial: Record<string, unknown>) {
  return {
    agentId: 'a1',
    parentToolCallId: 'tcA',
    messageId: 'm',
    type: 'general',
    description: '修复支付超时重试',
    status: 'running',
    startedAt: Date.now() - 125_000,
    rounds: 4,
    toolCalls: 23,
    tokens: 48000,
    filesChanged: [{ path: 'src/payment/retry.ts', additions: 18, deletions: 3 }],
    commands: [{ command: 'npm test -- test/payment', exitCode: 1 }],
    leaseRejects: 0,
    ...partial,
  };
}

describe('子 Agent 卡片', () => {
  it('运行中展示最近 5 条轨迹、计时和当前一句', async () => {
    ChatAgentCards.reset();
    toolBlock('tcA', '[general] 修复支付超时重试');
    ChatAgentCards.decorateTaskBlock(
      document.querySelector('[data-tool-call-id="tcA"]'),
      'tcA',
      '[general] 修复支付超时重试',
    );
    ChatAgentCards.applyView(view({}));
    const tools = [
      ['read_file', 'src/payment/client.ts', 'success'],
      ['edit_file', 'src/payment/retry.ts', 'success'],
      ['run_command', 'npm test -- test/payment', 'error'],
      ['grep', 'retryPolicy', 'success'],
      ['read_file', 'src/payment/config.ts', 'success'],
      ['edit_file', 'src/payment/retry.ts', 'pending'],
      ['read_file', 'src/payment/types.ts', 'success'],
    ];
    tools.forEach((row, index) => {
      ChatAgentCards.onAgentToolCall(
        { agentId: 'a1', toolCallId: `a1:t${index}`, toolName: row[0] },
        row[1],
        'pending',
        null,
      );
      if (row[2] !== 'pending') {
        ChatAgentCards.onAgentToolResult({ agentId: 'a1', toolCallId: `a1:t${index}`, toolName: row[0] }, row[2]);
      }
    });
    ChatAgentCards.onAgentStream({ agentId: 'a1', kind: 'text', delta: '正在分析测试失败原因' });

    const card = document.querySelector('.agent-card[data-agent-id="a1"]') as unknown as DomEl;
    expect(card.classList.contains('is-expanded')).toBe(true);
    expect(card.querySelector('.agent-card__stop')!.hidden).toBe(false);
    expect(card.querySelector('.agent-card__meta')!.textContent).toContain('运行中');
    expect(card.querySelector('.agent-card__meta')!.textContent).toContain('23 次工具调用');
    expect(card.querySelector('.agent-card__recent')!.children).toHaveLength(5);
    expect(card.querySelector('.agent-card__older')!.children).toHaveLength(2);
    expect(card.querySelector('.agent-card__older-toggle')!.textContent).toBe('还有 2 条 · 展开');
    expect(card.querySelector('.agent-card__now')!.textContent).toContain('正在分析测试失败原因');
    const failed = card.querySelectorAll('.tool-icon').find(icon => icon.className.includes('error'));
    expect(failed).toBeTruthy();
  });

  it('完成后折叠为一行，展开后显示报告', async () => {
    ChatAgentCards.reset();
    (document.body as unknown as DomEl).innerHTML = '';
    toolBlock('tcDone', '[explore] 找出共享依赖');
    ChatAgentCards.decorateTaskBlock(document.querySelector('[data-tool-call-id="tcDone"]'), 'tcDone', '');
    ChatAgentCards.applyView(view({
      agentId: 'a3',
      parentToolCallId: 'tcDone',
      type: 'explore',
      description: '找出共享依赖',
      status: 'completed',
      finishedAt: Date.now() - 1000,
      toolCalls: 9,
      filesChanged: [],
      commands: [],
      reportPreview: '共享依赖预览',
    }));
    const card = document.querySelector('.agent-card[data-agent-id="a3"]') as unknown as DomEl;
    expect(card.classList.contains('is-expanded')).toBe(false);
    expect(card.querySelector('.agent-card__stop')!.hidden).toBe(true);
    expect(card.querySelector('.agent-card__meta')!.textContent).toContain('已完成');

    card.querySelector('.agent-card__head')!.click();
    await new Promise(resolve => setTimeout(resolve, 0));
    expect(card.classList.contains('is-expanded')).toBe(true);
    expect(card.querySelector('.agent-card__report')!.textContent).toBe('FULL REPORT');
  });

  it('相邻的多个 task 合成一组并计数', async () => {
    ChatAgentCards.reset();
    (document.body as unknown as DomEl).innerHTML = '';
    const defs = [
      ['a1', 'tc1', 'running'],
      ['a2', 'tc2', 'running'],
      ['a3', 'tc3', 'completed'],
    ] as const;
    for (const [id, tc] of defs) toolBlock(tc, id);
    for (const [id, tc, status] of defs) {
      ChatAgentCards.decorateTaskBlock(document.querySelector(`[data-tool-call-id="${tc}"]`), tc, '');
      ChatAgentCards.applyView(view({
        agentId: id,
        parentToolCallId: tc,
        status,
        description: id,
        finishedAt: status === 'completed' ? Date.now() : undefined,
      }));
    }
    await new Promise(resolve => setTimeout(resolve, 20));
    const head = document.querySelector('.agent-group-head') as unknown as DomEl;
    expect(head.textContent).toBe('并行 3 个 Agent · 2 运行中 · 1 已完成');
  });

  it('有租约拦截时标题行显示橙色提示', () => {
    ChatAgentCards.reset();
    (document.body as unknown as DomEl).innerHTML = '';
    toolBlock('tcL', 'lease');
    ChatAgentCards.decorateTaskBlock(document.querySelector('[data-tool-call-id="tcL"]'), 'tcL', '');
    ChatAgentCards.applyView(view({ agentId: 'aL', parentToolCallId: 'tcL', leaseRejects: 1 }));
    const lease = document.querySelector('.agent-card__lease') as unknown as DomEl;
    expect(lease.hidden).toBe(false);
    expect(lease.textContent).toBe('1 次写入被拦截');
  });

  it('历史 tool_trace 里带 agentId 的行不进主轨迹', () => {
    ChatAgentCards.reset();
    const separated = ChatSession.separateToolTraces([
      { role: 'tool_trace', parentId: 'msg', toolName: 'task', toolCallId: 't1', detail: '[general] x', status: 'success' },
      { role: 'tool_trace', parentId: 'msg', agentId: 'ag', toolName: 'read_file', toolCallId: 'ag:r', detail: 'a.ts', status: 'success' },
      { role: 'agent', id: 'msg', content: 'done' },
    ]);
    expect(separated.traces.msg.map((row: { toolName: string }) => row.toolName)).toEqual(['task']);
    expect(ChatAgentCards.getState('ag').rows[0].toolName).toBe('read_file');
    expect(ChatAgentCards.getState('ag').rows[0].detail).toBe('a.ts');
  });

  it('打开子会话能看到任务、回复和工具调用', async () => {
    ChatAgentCards.reset();
    (document.body as unknown as DomEl).innerHTML = '';
    toolBlock('tcS', 'session');
    ChatAgentCards.decorateTaskBlock(document.querySelector('[data-tool-call-id="tcS"]'), 'tcS', '');
    ChatAgentCards.applyView(view({
      agentId: 'aS',
      parentToolCallId: 'tcS',
      status: 'completed',
      finishedAt: Date.now(),
    }));
    const card = document.querySelector('.agent-card[data-agent-id="aS"]') as unknown as DomEl;
    card.querySelector('.agent-card__head')!.click();
    await new Promise(resolve => setTimeout(resolve, 0));
    card.querySelector('.agent-card__open')!.click();
    await new Promise(resolve => setTimeout(resolve, 0));
    const drawer = document.querySelector('.agent-drawer') as unknown as DomEl;
    expect(drawer.hidden).toBe(false);
    expect(drawer.getAttribute('data-mode')).toBe('session');
    const text = collect(drawer).map(node => node.textContent).join('\n');
    expect(text).toContain('任务说明正文');
    expect(text).toContain('修复支付超时');
    expect(text).toContain('edit_file');
    expect(text).toContain('wrote src/pay.js');
    ChatAgentDrawer.close();
  });
});

describe('子 Agent 前端接线', () => {
  const root = path.join(__dirname, '../../src/public/js');
  const read = (name: string) => readFileSync(path.join(root, name), 'utf-8');

  it('确认弹窗标题带来源子 Agent，流式事件不进主消息', () => {
    const restore = read('chat-ws-restore-handlers.ts');
    expect(restore).toContain('子 Agent『${src.description}』请求执行：');
    const stream = read('chat-ws-stream-handlers.ts');
    expect(stream).toContain('if (step.agentId)');
    expect(stream).toContain('onAgentStep(step)');
    expect(stream).toContain('if (data.agentId) return');
    const plan = read('chat-execution-plan.ts');
    expect(plan).toContain('派出 ${agentTasks.length} 个 Agent');
  });
});
