/**
 * useWindows 的纯逻辑：参数解析、是否把工具交给模型、无人值守时的拒绝规则。
 * 不加载 koffi，单测可以在任意系统上跑。
 */

import { readUseWindowsFromMainConfig } from '../../config/main-config-supervisor-mode.js';

export const WINDOWS_MOUSE_TOOL = 'windows_mouse';
export const WINDOWS_KEYBOARD_TOOL = 'windows_keyboard';
export const WINDOWS_SCREENSHOT_TOOL = 'windows_screenshot';
export const WINDOWS_FIND_TOOL = 'windows_find';
export const WINDOWS_OCR_TOOL = 'windows_ocr';

export const WINDOWS_DESKTOP_TOOL_NAMES = [
  WINDOWS_MOUSE_TOOL,
  WINDOWS_KEYBOARD_TOOL,
  WINDOWS_SCREENSHOT_TOOL,
  WINDOWS_FIND_TOOL,
  WINDOWS_OCR_TOOL,
] as const;

const WINDOWS_TOOL_NAME_SET = new Set<string>(WINDOWS_DESKTOP_TOOL_NAMES);

export const WINDOWS_TYPE_MAX_CHARS = 4000;
export const WINDOWS_SCROLL_MAX_NOTCHES = 30;
export const WINDOWS_QUERY_MAX_CHARS = 80;

/** 定位结果。坐标是屏幕像素，可直接交给 windows_mouse。 */
export interface ScreenHit {
  text: string;
  x: number;
  y: number;
  w: number;
  h: number;
  cx: number;
  cy: number;
}

export function formatScreenHits(hits: ScreenHit[], emptyHint: string): string {
  if (hits.length === 0) return emptyHint;
  const lines = hits.slice(0, 30).map((hit) =>
    `[center ${hit.cx},${hit.cy}] ${JSON.stringify(hit.text)} rect ${hit.x},${hit.y} ${hit.w}x${hit.h}`,
  );
  return [
    'Click windows_mouse at a center below. Do not guess another point.',
    ...lines,
  ].join('\n');
}

export function parseLocateQuery(value: unknown, required: boolean): ParseResult<string> {
  const query = typeof value === 'string' ? value.trim() : '';
  if (!query) {
    return required
      ? { ok: false, error: 'query is required. Example: 微信.' }
      : { ok: true, value: '' };
  }
  if (query.length > WINDOWS_QUERY_MAX_CHARS) {
    return { ok: false, error: `query must be at most ${WINDOWS_QUERY_MAX_CHARS} characters.` };
  }
  return { ok: true, value: query };
}

export function isWindowsDesktopTool(name: string): boolean {
  return WINDOWS_TOOL_NAME_SET.has(name);
}

/** 关闭、非 Windows、或无人值守时，从本轮工具列表和提示词里拿掉。 */
export function filterToolsForUseWindows<T extends { name: string }>(tools: T[], enabled: boolean): T[] {
  if (enabled) return tools;
  return tools.filter((tool) => !isWindowsDesktopTool(tool.name));
}

export async function applyUseWindowsToolOffering<T extends { name: string }>(
  tools: T[],
  configPath: string,
  options?: { unattended?: boolean },
): Promise<T[]> {
  if (process.platform !== 'win32' || options?.unattended) {
    return filterToolsForUseWindows(tools, false);
  }
  const enabled = await readUseWindowsFromMainConfig(configPath);
  return filterToolsForUseWindows(tools, enabled);
}

/** 定时任务会自动通过确认。键鼠不进入无人值守轮次，调用也被拒绝。 */
export function windowsDesktopUnattendedDenyRule(): {
  pattern: string;
  permission: 'deny';
  reason: string;
} {
  return {
    pattern: 'windows_*',
    permission: 'deny',
    reason: 'Windows desktop tools are not injected during unattended scheduled runs',
  };
}

export type MouseButton = 'left' | 'right' | 'middle';

export type MouseCommand =
  | { action: 'move'; x: number; y: number }
  | { action: 'click'; x: number; y: number; button: MouseButton; clicks: 1 | 2 }
  | { action: 'drag'; x: number; y: number; toX: number; toY: number; button: MouseButton }
  | { action: 'scroll'; x: number | null; y: number | null; notches: number };

export type KeyboardCommand =
  | { action: 'type'; text: string }
  | { action: 'press'; tokens: string[] };

export type ParseResult<T> = { ok: true; value: T } | { ok: false; error: string };

const VK_NAMED: Record<string, number> = {
  ctrl: 0x11,
  control: 0x11,
  alt: 0x12,
  shift: 0x10,
  win: 0x5B,
  meta: 0x5B,
  super: 0x5B,
  enter: 0x0D,
  return: 0x0D,
  tab: 0x09,
  esc: 0x1B,
  escape: 0x1B,
  backspace: 0x08,
  delete: 0x2E,
  del: 0x2E,
  insert: 0x2D,
  home: 0x24,
  end: 0x23,
  pageup: 0x21,
  pgup: 0x21,
  pagedown: 0x22,
  pgdn: 0x22,
  up: 0x26,
  down: 0x28,
  left: 0x25,
  right: 0x27,
  space: 0x20,
  spacebar: 0x20,
  capslock: 0x14,
};

for (let i = 1; i <= 24; i++) {
  VK_NAMED[`f${i}`] = 0x6F + i;
}

export type ResolvedKeyToken =
  | { ok: true; vk: number }
  | { ok: true; scanChar: string }
  | { ok: false; error: string };

export function resolveKeyToken(token: string): ResolvedKeyToken {
  const lower = token.toLowerCase();
  const named = VK_NAMED[lower];
  if (named !== undefined) return { ok: true, vk: named };
  if (/^[a-z0-9]$/i.test(token)) {
    return { ok: true, vk: token.toUpperCase().charCodeAt(0) };
  }
  if (token.length === 1) return { ok: true, scanChar: token };
  return { ok: false, error: `Unknown key "${token}". Use a named key (enter, tab, ctrl) or type text.` };
}

function finiteInt(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) return Math.round(value);
  if (typeof value === 'string' && value.trim() !== '' && Number.isFinite(Number(value))) {
    return Math.round(Number(value));
  }
  return null;
}

function readPoint(args: Record<string, unknown>, xKey: string, yKey: string): ParseResult<{ x: number; y: number }> {
  const x = finiteInt(args[xKey]);
  const y = finiteInt(args[yKey]);
  if (x === null || y === null) {
    return { ok: false, error: `${xKey} and ${yKey} are required integers (pixels on the primary monitor).` };
  }
  return { ok: true, value: { x, y } };
}

function readButton(value: unknown): ParseResult<MouseButton> {
  if (value === undefined || value === null || value === '') return { ok: true, value: 'left' };
  if (value === 'left' || value === 'right' || value === 'middle') return { ok: true, value };
  return { ok: false, error: 'button must be left, right, or middle.' };
}

export function parseMouseCommand(args: Record<string, unknown> | undefined): ParseResult<MouseCommand> {
  const action = typeof args?.action === 'string' ? args.action.trim().toLowerCase() : '';
  if (action !== 'move' && action !== 'click' && action !== 'drag' && action !== 'scroll') {
    return { ok: false, error: 'action must be move, click, drag, or scroll.' };
  }
  const source = args ?? {};

  if (action === 'scroll') {
    const notches = finiteInt(source.delta);
    if (notches === null || notches === 0) {
      return { ok: false, error: 'scroll requires delta, a non-zero integer number of wheel notches (positive = up).' };
    }
    if (Math.abs(notches) > WINDOWS_SCROLL_MAX_NOTCHES) {
      return { ok: false, error: `delta must be between -${WINDOWS_SCROLL_MAX_NOTCHES} and ${WINDOWS_SCROLL_MAX_NOTCHES}.` };
    }
    const hasX = source.x !== undefined && source.x !== null;
    const hasY = source.y !== undefined && source.y !== null;
    if (hasX !== hasY) return { ok: false, error: 'scroll x and y must be provided together.' };
    if (!hasX) return { ok: true, value: { action: 'scroll', x: null, y: null, notches } };
    const point = readPoint(source, 'x', 'y');
    if (!point.ok) return point;
    return { ok: true, value: { action: 'scroll', x: point.value.x, y: point.value.y, notches } };
  }

  const point = readPoint(source, 'x', 'y');
  if (!point.ok) return point;
  const button = readButton(source.button);
  if (!button.ok) return button;

  if (action === 'move') {
    return { ok: true, value: { action: 'move', x: point.value.x, y: point.value.y } };
  }
  if (action === 'drag') {
    const target = readPoint(source, 'toX', 'toY');
    if (!target.ok) return target;
    return {
      ok: true,
      value: {
        action: 'drag',
        x: point.value.x,
        y: point.value.y,
        toX: target.value.x,
        toY: target.value.y,
        button: button.value,
      },
    };
  }

  const clicks = source.clicks === undefined || source.clicks === null ? 1 : finiteInt(source.clicks);
  if (clicks !== 1 && clicks !== 2) return { ok: false, error: 'clicks must be 1 or 2.' };
  return {
    ok: true,
    value: {
      action: 'click',
      x: point.value.x,
      y: point.value.y,
      button: button.value,
      clicks,
    },
  };
}

export function parseKeyChord(raw: string): ParseResult<string[]> {
  const trimmed = raw.trim();
  if (!trimmed) return { ok: false, error: 'keys is empty.' };
  const tokens = trimmed.split('+').map((part) => part.trim());
  if (tokens.some((token) => token.length === 0)) {
    return { ok: false, error: 'keys has an empty part. Example: ctrl+l or enter.' };
  }
  if (tokens.length > 5) return { ok: false, error: 'keys accepts at most 5 parts.' };
  for (const token of tokens) {
    const resolved = resolveKeyToken(token);
    if (!resolved.ok) return resolved;
  }
  return { ok: true, value: tokens };
}

export function parseKeyboardCommand(args: Record<string, unknown> | undefined): ParseResult<KeyboardCommand> {
  const action = typeof args?.action === 'string' ? args.action.trim().toLowerCase() : '';
  if (action !== 'type' && action !== 'press') {
    return { ok: false, error: 'action must be type or press.' };
  }
  if (action === 'type') {
    const text = typeof args?.text === 'string' ? args.text : '';
    if (text.length === 0) return { ok: false, error: 'type requires text.' };
    if (text.length > WINDOWS_TYPE_MAX_CHARS) {
      return { ok: false, error: `text is longer than ${WINDOWS_TYPE_MAX_CHARS} characters.` };
    }
    return { ok: true, value: { action: 'type', text } };
  }
  const keys = typeof args?.keys === 'string' ? args.keys : '';
  const chord = parseKeyChord(keys);
  if (!chord.ok) return chord;
  return { ok: true, value: { action: 'press', tokens: chord.value } };
}
