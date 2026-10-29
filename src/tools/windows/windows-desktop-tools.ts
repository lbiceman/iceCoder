/**
 * useWindows 打开后才进入本轮工具列表和提示词的桌面操作工具。
 * 注册只发生在 Windows 上；真正发输入前再读一次开关。
 */

import { randomBytes } from 'node:crypto';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  readUseWindowsFromMainConfig,
  resolveMainConfigPath,
} from '../../config/main-config.js';
import type { RegisteredTool, ToolResult } from '../types.js';
import { encodePngFromBottomUpBgra } from './png32.js';
import {
  formatScreenHits,
  parseKeyboardCommand,
  parseLocateQuery,
  parseMouseCommand,
  WINDOWS_FIND_TOOL,
  WINDOWS_KEYBOARD_TOOL,
  WINDOWS_MOUSE_TOOL,
  WINDOWS_OCR_TOOL,
  WINDOWS_SCREENSHOT_TOOL,
} from './windows-actions.js';
import { filterHits, findUiElements, ocrImage, offsetHits } from './windows-locate.js';

const SHOT_DIR = path.join(os.tmpdir(), 'icecoder-windows');
const SHOT_MAX_AGE_MS = 24 * 60 * 60 * 1000;

interface ShotOrigin {
  filePath: string;
  originX: number;
  originY: number;
}

let lastShot: ShotOrigin | null = null;

function failed(error: string, effect: 'execute' | 'observe' = 'execute'): ToolResult {
  return { success: false, output: '', error, status: 'failed', effect, risk: 'low' };
}

function completed(output: string, effect: 'execute' | 'observe'): ToolResult {
  return { success: true, output, status: 'completed', effect, risk: 'low' };
}

async function useWindowsGate(): Promise<string | null> {
  if (process.platform !== 'win32') {
    return 'Windows desktop tools only run on Windows.';
  }
  const enabled = await readUseWindowsFromMainConfig(resolveMainConfigPath());
  if (!enabled) {
    return 'useWindows is off. Turn it on in Settings before these tools are available.';
  }
  return null;
}

async function desktop() {
  const mod = await import('./win32-desktop.js');
  return mod.getWin32Desktop();
}

function aborted(error: unknown): boolean {
  return error instanceof Error && error.message === 'aborted';
}

export function createWindowsDesktopTools(): RegisteredTool[] {
  if (process.platform !== 'win32') return [];
  return [
    createMouseTool(),
    createKeyboardTool(),
    createScreenshotTool(),
    createFindTool(),
    createOcrTool(),
  ];
}

function createMouseTool(): RegisteredTool {
  return {
    definition: {
      name: WINDOWS_MOUSE_TOOL,
      description: [
        'Move, click, drag, or scroll the real Windows mouse. Events go to the desktop, not to a browser page.',
        'x and y are screen coordinates. Use a center returned by windows_find or windows_ocr. Do not guess.',
        'Actions: move {x,y}; click {x,y,button?,clicks?}; drag {x,y,toX,toY,button?}; scroll {delta,x?,y?}.',
        'button is left, right, or middle. clicks is 1 or 2. delta is wheel notches, positive means up, from -30 to 30.',
      ].join(' '),
      parameters: {
        type: 'object',
        properties: {
          action: { type: 'string', enum: ['move', 'click', 'drag', 'scroll'] },
          x: { type: 'number', description: 'Screen x from windows_find or windows_ocr.' },
          y: { type: 'number', description: 'Screen y from windows_find or windows_ocr.' },
          toX: { type: 'number', description: 'Drag end x.' },
          toY: { type: 'number', description: 'Drag end y.' },
          button: { type: 'string', enum: ['left', 'right', 'middle'] },
          clicks: { type: 'number', description: '1 or 2. Default 1.' },
          delta: { type: 'number', description: 'Wheel notches. Positive is up.' },
        },
        required: ['action'],
      },
    },
    handler: async (args, _onOutput, signal) => {
      const blocked = await useWindowsGate();
      if (blocked) return failed(blocked);
      const parsed = parseMouseCommand(args);
      if (!parsed.ok) return failed(parsed.error);
      try {
        const win = await desktop();
        const command = parsed.value;
        if (command.action === 'move') {
          win.move(command.x, command.y);
          return completed(`Moved the pointer to (${command.x}, ${command.y}).`, 'execute');
        }
        if (command.action === 'click') {
          await win.click(command.x, command.y, command.button, command.clicks, signal);
          return completed(
            `Clicked ${command.button} ${command.clicks === 2 ? 'twice' : 'once'} at (${command.x}, ${command.y}).`,
            'execute',
          );
        }
        if (command.action === 'drag') {
          await win.drag(command.x, command.y, command.toX, command.toY, command.button, signal);
          return completed(
            `Dragged ${command.button} from (${command.x}, ${command.y}) to (${command.toX}, ${command.toY}).`,
            'execute',
          );
        }
        win.scroll(command.x, command.y, command.notches);
        const where = command.x === null ? 'at the current pointer' : `at (${command.x}, ${command.y})`;
        const direction = command.notches > 0 ? 'up' : 'down';
        return completed(`Scrolled ${Math.abs(command.notches)} notch(es) ${direction} ${where}.`, 'execute');
      } catch (error) {
        if (aborted(error) || signal?.aborted) return failed('工具执行已中止 (aborted)');
        return failed(error instanceof Error ? error.message : String(error));
      }
    },
  };
}

function createKeyboardTool(): RegisteredTool {
  return {
    definition: {
      name: WINDOWS_KEYBOARD_TOOL,
      description: [
        'Type text or press a key chord into the foreground Windows window. This is real keyboard input.',
        'action "type" sends text, including Chinese, via Unicode key events. Newlines become Enter.',
        'action "press" sends a chord such as enter, tab, escape, ctrl+l, ctrl+shift+s, or alt+f4.',
        'Use type for words and characters. Use press for shortcuts and named keys. Letters in press are unshifted; hold shift in the chord when you need a capital.',
      ].join(' '),
      parameters: {
        type: 'object',
        properties: {
          action: { type: 'string', enum: ['type', 'press'] },
          text: { type: 'string', description: 'Characters to type. Required for action type.' },
          keys: { type: 'string', description: 'Chord such as ctrl+c or enter. Required for action press.' },
        },
        required: ['action'],
      },
    },
    handler: async (args) => {
      const blocked = await useWindowsGate();
      if (blocked) return failed(blocked);
      const parsed = parseKeyboardCommand(args);
      if (!parsed.ok) return failed(parsed.error);
      try {
        const win = await desktop();
        const command = parsed.value;
        if (command.action === 'type') {
          win.typeText(command.text);
          const preview = command.text.length > 80 ? `${command.text.slice(0, 80)}…` : command.text;
          return completed(`Typed ${command.text.length} character(s): ${JSON.stringify(preview)}`, 'execute');
        }
        win.pressTokens(command.tokens);
        return completed(`Pressed ${command.tokens.join('+')}.`, 'execute');
      } catch (error) {
        return failed(error instanceof Error ? error.message : String(error));
      }
    },
  };
}

function createScreenshotTool(): RegisteredTool {
  return {
    definition: {
      name: WINDOWS_SCREENSHOT_TOOL,
      description: [
        'Capture the desktop to a PNG and return its path, screen origin, and pointer position.',
        'Image pixel (0, 0) plus the reported origin is the screen coordinate. Prefer windows_find or windows_ocr for a click point.',
        'The capture does not move the pointer.',
      ].join(' '),
      parameters: { type: 'object', properties: {}, required: [] },
    },
    handler: async () => {
      const blocked = await useWindowsGate();
      if (blocked) return failed(blocked, 'observe');
      try {
        const win = await desktop();
        const shot = win.capturePrimary();
        const filePath = await writeScreenshot(shot.width, shot.height, shot.pixels);
        lastShot = { filePath, originX: shot.originX, originY: shot.originY };
        const scope = shot.fullDesktop ? 'desktop' : 'primary monitor only';
        return completed(
          [
            `Captured the ${scope} ${shot.width}x${shot.height}. Screen origin (${shot.originX}, ${shot.originY}).`,
            `Image pixel (0, 0) is screen (${shot.originX}, ${shot.originY}).`,
            `Pointer: (${shot.cursorX}, ${shot.cursorY}).`,
            `Image: ${filePath}`,
            'Use windows_find or windows_ocr for a click center. Do not guess a pixel from the image.',
          ].join('\n'),
          'observe',
        );
      } catch (error) {
        return failed(error instanceof Error ? error.message : String(error), 'observe');
      }
    },
  };
}

function createFindTool(): RegisteredTool {
  return {
    definition: {
      name: WINDOWS_FIND_TOOL,
      description: [
        'Find a named Windows control and return its screen center for windows_mouse.',
        'Use this for a taskbar icon, window title, or button. query is matched inside the control name, for example 微信.',
        'If nothing matches, the control has no accessible name. Use windows_ocr instead of guessing a coordinate or writing a script.',
      ].join(' '),
      parameters: {
        type: 'object',
        properties: {
          query: { type: 'string', description: 'Text contained in the control name, such as 微信.' },
        },
        required: ['query'],
      },
    },
    handler: async (args, _onOutput, signal) => {
      const blocked = await useWindowsGate();
      if (blocked) return failed(blocked, 'observe');
      const query = parseLocateQuery(args?.query, true);
      if (!query.ok) return failed(query.error, 'observe');
      try {
        const hits = await findUiElements(query.value, signal);
        return completed(
          formatScreenHits(hits, `No control name contains ${JSON.stringify(query.value)}. Do not guess a click point. Try windows_ocr if the text is drawn by the app.`),
          'observe',
        );
      } catch (error) {
        if (aborted(error) || signal?.aborted) return failed('工具执行已中止 (aborted)', 'observe');
        return failed(error instanceof Error ? error.message : String(error), 'observe');
      }
    },
  };
}

function createOcrTool(): RegisteredTool {
  return {
    definition: {
      name: WINDOWS_OCR_TOOL,
      description: [
        'Read on-screen text and return each line with a screen center for windows_mouse.',
        'Pass query to keep only lines that contain it, such as a chat name. Omit path to read the current desktop.',
        'If query has no match, the text is not visible. Do not click a nearby guess and do not write an OCR script.',
      ].join(' '),
      parameters: {
        type: 'object',
        properties: {
          query: { type: 'string', description: 'Optional text that the line must contain.' },
          path: { type: 'string', description: 'Optional PNG from windows_screenshot. Omit to capture the desktop now.' },
        },
        required: [],
      },
    },
    handler: async (args, _onOutput, signal) => {
      const blocked = await useWindowsGate();
      if (blocked) return failed(blocked, 'observe');
      const query = parseLocateQuery(args?.query, false);
      if (!query.ok) return failed(query.error, 'observe');
      try {
        const source = await ocrSource(args?.path, signal);
        const recognized = offsetHits(await ocrImage(source.filePath, signal), source.originX, source.originY);
        const hits = filterHits(recognized, query.value);
        const empty = query.value
          ? `No line contains ${JSON.stringify(query.value)} (${recognized.length} lines read). Do not guess a click point.`
          : 'No text recognized. Do not guess a click point.';
        return completed(formatScreenHits(hits, empty), 'observe');
      } catch (error) {
        if (aborted(error) || signal?.aborted) return failed('工具执行已中止 (aborted)', 'observe');
        return failed(error instanceof Error ? error.message : String(error), 'observe');
      }
    },
  };
}

async function ocrSource(
  rawPath: unknown,
  signal?: AbortSignal,
): Promise<ShotOrigin> {
  if (typeof rawPath === 'string' && rawPath.trim()) {
    const filePath = path.resolve(rawPath.trim());
    await fs.access(filePath);
    if (lastShot && path.normalize(lastShot.filePath) === path.normalize(filePath)) return lastShot;
    return { filePath, originX: 0, originY: 0 };
  }
  const win = await desktop();
  const shot = win.capturePrimary();
  if (signal?.aborted) throw new Error('aborted');
  const filePath = await writeScreenshot(shot.width, shot.height, shot.pixels);
  const origin: ShotOrigin = { filePath, originX: shot.originX, originY: shot.originY };
  lastShot = origin;
  return origin;
}

async function writeScreenshot(width: number, height: number, pixels: Buffer): Promise<string> {
  await fs.mkdir(SHOT_DIR, { recursive: true });
  await pruneOldScreenshots();
  const filePath = path.join(SHOT_DIR, `screen-${Date.now()}-${randomBytes(4).toString('hex')}.png`);
  await fs.writeFile(filePath, encodePngFromBottomUpBgra(width, height, pixels));
  return filePath;
}

async function pruneOldScreenshots(): Promise<void> {
  let names: string[] = [];
  try {
    names = await fs.readdir(SHOT_DIR);
  } catch {
    return;
  }
  const cutoff = Date.now() - SHOT_MAX_AGE_MS;
  await Promise.all(names.map(async (name) => {
    if (!name.endsWith('.png') && !name.endsWith('.bmp')) return;
    const filePath = path.join(SHOT_DIR, name);
    try {
      const stat = await fs.stat(filePath);
      if (stat.mtimeMs < cutoff) await fs.unlink(filePath);
    } catch {
      /* 清理失败不影响这次截屏 */
    }
  }));
}
