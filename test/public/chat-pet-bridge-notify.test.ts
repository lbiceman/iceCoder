import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const BRIDGE_PATH = path.join(__dirname, '../../src/public/js/chat-pet-bridge.js');

interface NotifyPayload {
  success: boolean;
  summary: string;
}

interface LoadOptions {
  taskDoneNotification?: boolean;
  hasIceDesktop?: boolean;
  hasFocus?: boolean;
}

interface Harness {
  bridge: {
    init(pet: unknown): void;
    applyHarnessStepToPet(step: unknown, isStreaming: boolean, wsProcessing: boolean): void;
    setLastUserPrompt(text: string): void;
    showThinking(withFile: boolean): void;
    isToolUseActive(): boolean;
  };
  petStates: string[];
  bubbles: string[];
  notifyCalls: NotifyPayload[];
}

function loadBridge(options: LoadOptions = {}): Harness {
  const src = readFileSync(BRIDGE_PATH, 'utf-8');
  const notifyCalls: NotifyPayload[] = [];
  const petStates: string[] = [];
  const bubbles: string[] = [];
  const pet = {
    setVisible: () => {},
    setState: (s: string) => { petStates.push(s); },
    setBubbleText: (t: string) => { bubbles.push(t); },
    setTurnLabel: () => {},
    isVisible: () => true,
  };

  const sandboxWindow: Record<string, unknown> = {};
  const context: Record<string, unknown> = {
    window: sandboxWindow,
    document: { hasFocus: () => options.hasFocus ?? false },
    console,
    setTimeout,
    clearTimeout,
  };
  sandboxWindow.EtlPrefs = {
    get: () => ({ taskDoneNotification: options.taskDoneNotification ?? true }),
  };
  if (options.hasIceDesktop !== false) {
    sandboxWindow.iceDesktop = {
      notifyTaskDone: (p: NotifyPayload) => { notifyCalls.push(p); },
    };
  }

  vm.createContext(context);
  vm.runInContext(src, context);
  const bridge = (sandboxWindow as { ChatPetBridge: Harness['bridge'] }).ChatPetBridge;
  bridge.init(pet);
  return { bridge, petStates, bubbles, notifyCalls };
}

function runTaskWithToolCall(bridge: Harness['bridge'], hasToolCall: boolean): void {
  if (hasToolCall) {
    bridge.applyHarnessStepToPet({ type: 'tool_call', toolName: 'write_file' }, false, false);
  }
  bridge.applyHarnessStepToPet({ type: 'final', stopReason: 'model_done' }, false, false);
}

describe('chat-pet-bridge maybeNotifyTaskDone 行为', () => {
  it('开关关闭 → 不通知，但冰豆 UI 正常进入 clap', () => {
    const h = loadBridge({ taskDoneNotification: false, hasIceDesktop: true, hasFocus: false });
    runTaskWithToolCall(h.bridge, true);
    expect(h.notifyCalls).toHaveLength(0);
    expect(h.petStates).toContain('clap');
  });

  it('纯闲聊（本轮无 tool_call）→ 不通知', () => {
    const h = loadBridge({ taskDoneNotification: true, hasIceDesktop: true, hasFocus: false });
    runTaskWithToolCall(h.bridge, false);
    expect(h.notifyCalls).toHaveLength(0);
  });

  it('主窗处于前台（document.hasFocus）→ 不通知（R10 前端层）', () => {
    const h = loadBridge({ taskDoneNotification: true, hasIceDesktop: true, hasFocus: true });
    runTaskWithToolCall(h.bridge, true);
    expect(h.notifyCalls).toHaveLength(0);
  });

  it('无桌面桥（Web 端）→ 不通知且不报错', () => {
    const h = loadBridge({ taskDoneNotification: true, hasIceDesktop: false, hasFocus: false });
    expect(() => runTaskWithToolCall(h.bridge, true)).not.toThrow();
    expect(h.notifyCalls).toHaveLength(0);
  });

  it('开关开 + 有工具 + 后台 + 桌面桥 → 通知一次且带摘要', () => {
    const h = loadBridge({ taskDoneNotification: true, hasIceDesktop: true, hasFocus: false });
    h.bridge.setLastUserPrompt('帮我写一个脚本');
    runTaskWithToolCall(h.bridge, true);
    expect(h.notifyCalls).toHaveLength(1);
    expect(h.notifyCalls[0]).toEqual({ success: true, summary: '帮我写一个脚本' });
  });

  it('setLastUserPrompt 摘要超 30 字 → 截断加省略号', () => {
    const h = loadBridge({ taskDoneNotification: true, hasIceDesktop: true, hasFocus: false });
    h.bridge.setLastUserPrompt('这是一段非常长的用户提示词，超过了三十个字符的限制，需要被截断显示省略号');
    runTaskWithToolCall(h.bridge, true);
    expect(h.notifyCalls).toHaveLength(1);
    const summary = h.notifyCalls[0].summary;
    expect(h.notifyCalls[0].summary.endsWith('…')).toBe(true);
    expect(h.notifyCalls[0].summary.length).toBe(31);
  });
});

describe('chat-pet-bridge 表情贴合 harness 节点', () => {
  it('记忆并入 → memory，不是 clap / planning', () => {
    const h = loadBridge();
    h.bridge.applyHarnessStepToPet({
      type: 'memory_event',
      memoryKind: 'recall_coarse_hit',
      memoryDetail: '首轮已把记忆并入本回合提示：user_communi.md',
    }, false, true);
    expect(h.petStates[h.petStates.length - 1]).toBe('memory');
    expect(h.bubbles[h.bubbles.length - 1]).toContain('记忆并入');
  });

  it('thinking / 处理中 → running', () => {
    const h = loadBridge();
    h.bridge.applyHarnessStepToPet({ type: 'thinking', content: '处理中' }, false, true);
    expect(h.petStates[h.petStates.length - 1]).toBe('running');
  });

  it('showThinking 发送后忙碌 → running', () => {
    const h = loadBridge();
    h.bridge.showThinking(false);
    expect(h.petStates[h.petStates.length - 1]).toBe('running');
  });

  it('本轮所有用工具的操作共用 tool_calling', () => {
    const h = loadBridge();
    h.bridge.showThinking(false);
    h.bridge.applyHarnessStepToPet({ type: 'tool_call', toolName: 'read_file' }, false, true);
    expect(h.petStates[h.petStates.length - 1]).toBe('tool_calling');
    h.bridge.applyHarnessStepToPet({ type: 'tool_progress', content: '读取中' }, false, true);
    expect(h.petStates[h.petStates.length - 1]).toBe('tool_calling');
    h.bridge.applyHarnessStepToPet({ type: 'tool_result', toolName: 'read_file', toolSuccess: true }, false, true);
    expect(h.petStates[h.petStates.length - 1]).toBe('tool_calling');
    h.bridge.applyHarnessStepToPet({ type: 'thinking', content: '继续分析' }, false, true);
    expect(h.petStates[h.petStates.length - 1]).toBe('tool_calling');
    h.bridge.applyHarnessStepToPet({ type: 'stream_delta', delta: '…' }, true, true);
    expect(h.petStates[h.petStates.length - 1]).toBe('tool_calling');
    expect(h.bridge.isToolUseActive()).toBe(true);
  });
});
