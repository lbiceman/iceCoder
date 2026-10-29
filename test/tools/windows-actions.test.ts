import { describe, expect, it } from 'vitest';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { isToolExcludedForAllAgents } from '../../src/harness/agents/agent-types.js';
import { resolveToolPermission } from '../../src/harness/harness-permission-runtime.js';
import { createToolUsageSection } from '../../src/prompts/sections.js';
import { filterPlanModeToolDefinitions } from '../../src/session/plan-mode-tool-policy.js';
import {
  readUseWindowsFromMainConfig,
  resolveUseWindows,
  writeUseWindowsToMainConfig,
} from '../../src/config/main-config.js';
import { encodePngFromBottomUpBgra } from '../../src/tools/windows/png32.js';
import {
  applyUseWindowsToolOffering,
  filterToolsForUseWindows,
  formatScreenHits,
  parseKeyboardCommand,
  parseKeyChord,
  parseMouseCommand,
  resolveKeyToken,
  windowsDesktopUnattendedDenyRule,
  WINDOWS_DESKTOP_TOOL_NAMES,
} from '../../src/tools/windows/windows-actions.js';
import { filterHits, offsetHits } from '../../src/tools/windows/windows-locate.js';
import type { ToolDefinition } from '../../src/llm/types.js';

const tools = WINDOWS_DESKTOP_TOOL_NAMES.map((name) => ({ name, description: name, parameters: {} }));

describe('useWindows offering', () => {
  it('defaults off and only an explicit true turns it on', async () => {
    expect(resolveUseWindows(undefined)).toBe(false);
    expect(resolveUseWindows(false)).toBe(false);
    expect(resolveUseWindows('true')).toBe(false);
    expect(resolveUseWindows(true)).toBe(true);

    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'ice-use-windows-'));
    const configPath = path.join(dir, 'config.json');
    await fs.writeFile(configPath, JSON.stringify({ providers: [] }), 'utf-8');
    expect(await readUseWindowsFromMainConfig(configPath)).toBe(false);
    expect(await writeUseWindowsToMainConfig(configPath, true)).toBe(true);
    expect(await readUseWindowsFromMainConfig(configPath)).toBe(true);
    expect(await writeUseWindowsToMainConfig(configPath, false)).toBe(false);
  });

  it('keeps the tools only when the switch is on', async () => {
    expect(filterToolsForUseWindows(tools, false).map((tool) => tool.name)).toEqual([]);
    expect(filterToolsForUseWindows(tools, true).map((tool) => tool.name)).toEqual([...WINDOWS_DESKTOP_TOOL_NAMES]);

    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'ice-use-windows-offer-'));
    const configPath = path.join(dir, 'config.json');
    await fs.writeFile(configPath, JSON.stringify({ providers: [], useWindows: true }), 'utf-8');
    const unattended = await applyUseWindowsToolOffering(tools, configPath, { unattended: true });
    expect(unattended).toEqual([]);
    const offered = await applyUseWindowsToolOffering(tools, configPath);
    if (process.platform === 'win32') {
      expect(offered.map((tool) => tool.name)).toEqual([...WINDOWS_DESKTOP_TOOL_NAMES]);
    } else {
      expect(offered).toEqual([]);
    }
  });

  it('injects the desktop instructions only while the tools are offered', () => {
    const without = createToolUsageSection(['read_file', 'grep']);
    expect(without.content).not.toContain('Windows desktop');
    expect(without.content).not.toContain('windows_mouse');

    const withTools = createToolUsageSection(['read_file', ...WINDOWS_DESKTOP_TOOL_NAMES]);
    expect(withTools.content).toContain('## Windows desktop');
    expect(withTools.content).toContain('windows_find');
    expect(withTools.content).toContain('windows_ocr');
    expect(withTools.content).toContain('Do not guess click coordinates');
    expect(withTools.content).toContain('Do not write OCR');
  });

  it('keeps desktop tools away from plan mode, sub-agents, and unattended runs', () => {
    const defs = WINDOWS_DESKTOP_TOOL_NAMES.map((name): ToolDefinition => ({
      name,
      description: name,
      parameters: {},
    }));
    expect(filterPlanModeToolDefinitions([...defs, {
      name: 'read_file',
      description: 'read',
      parameters: {},
    }]).map((tool) => tool.name)).toEqual(['read_file']);

    for (const name of WINDOWS_DESKTOP_TOOL_NAMES) {
      expect(isToolExcludedForAllAgents(name)).toBe(true);
    }

    const denied = resolveToolPermission(
      { id: 'c1', name: 'windows_mouse', arguments: { action: 'move', x: 1, y: 1 } },
      [windowsDesktopUnattendedDenyRule()],
    );
    expect(denied.permission).toBe('deny');
  });
});

describe('windows action parsing', () => {
  it('parses mouse actions', () => {
    expect(parseMouseCommand({ action: 'move', x: 10.2, y: '20' })).toEqual({
      ok: true,
      value: { action: 'move', x: 10, y: 20 },
    });
    expect(parseMouseCommand({ action: 'click', x: 1, y: 2, clicks: 2, button: 'right' })).toEqual({
      ok: true,
      value: { action: 'click', x: 1, y: 2, button: 'right', clicks: 2 },
    });
    expect(parseMouseCommand({ action: 'scroll', delta: 3 }).ok).toBe(true);
    expect(parseMouseCommand({ action: 'scroll', delta: 0 }).ok).toBe(false);
    expect(parseMouseCommand({ action: 'drag', x: 1, y: 2 }).ok).toBe(false);
  });

  it('parses keyboard chords and literal text', () => {
    expect(parseKeyChord('Ctrl+Shift+S')).toEqual({ ok: true, value: ['Ctrl', 'Shift', 'S'] });
    expect(resolveKeyToken('enter')).toEqual({ ok: true, vk: 0x0D });
    expect(resolveKeyToken('s')).toEqual({ ok: true, vk: 'S'.charCodeAt(0) });
    expect(resolveKeyToken('!')).toEqual({ ok: true, scanChar: '!' });
    expect(parseKeyboardCommand({ action: 'type', text: '你好' })).toEqual({
      ok: true,
      value: { action: 'type', text: '你好' },
    });
    expect(parseKeyboardCommand({ action: 'press', keys: 'alt+f4' }).ok).toBe(true);
    expect(parseKeyboardCommand({ action: 'type', text: '' }).ok).toBe(false);
  });
});

describe('screen hit formatting', () => {
  it('prints a clickable center and does not invent one when empty', () => {
    expect(formatScreenHits([], 'No match.')).toBe('No match.');
    const text = formatScreenHits([{
      text: '微信',
      x: 10,
      y: 20,
      w: 30,
      h: 40,
      cx: 25,
      cy: 40,
    }], 'No match.');
    expect(text).toContain('[center 25,40]');
    expect(text).toContain('微信');
    expect(text).toContain('Do not guess');
  });

  it('shifts OCR boxes by the screenshot origin and filters by query', () => {
    const hits = offsetHits([{
      text: '文件传输助手',
      x: 100,
      y: 200,
      w: 80,
      h: 20,
      cx: 140,
      cy: 210,
    }], -1920, 0);
    expect(hits[0]?.cx).toBe(-1780);
    expect(filterHits(hits, '传输')).toHaveLength(1);
    expect(filterHits([{ ...hits[0]!, text: '文 件 传 输 助 手' }], '文件传输助手')).toHaveLength(1);
    expect(filterHits(hits, '天气')).toHaveLength(0);
  });
});

describe('encodePngFromBottomUpBgra', () => {
  it('writes a PNG whose IHDR matches the pixel size', () => {
    const pixels = Buffer.from([1, 2, 3, 4]);
    const file = encodePngFromBottomUpBgra(1, 1, pixels);
    expect(file.subarray(0, 8)).toEqual(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
    expect(file.subarray(12, 16).toString('ascii')).toBe('IHDR');
    expect(file.readUInt32BE(16)).toBe(1);
    expect(file.readUInt32BE(20)).toBe(1);
  });
});
