/**
 * shell-collab-tools 工厂与白名单单测（任务 2.5）
 */

import { describe, expect, it } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { FileParser } from '../../src/parser/file-parser.js';
import { initializeToolSystem } from '../../src/tools/index.js';
import {
  SHELL_COLLAB_TOOL_NAMES,
  SHELL_FILE_TOOL_NAMES,
  SHELL_ONLY_TOOL_NAMES,
  createShellCollabTools,
  shellCollabDefinitionsMatchWhitelist,
  sortedShellCollabDefinitionNames,
} from '../../src/tools/shell-collab-tools.js';

describe('shell-collab-tools — factory & whitelist (task 2.5)', () => {
  it('createShellCollabTools returns shell PTY tools plus file CRUD tools', () => {
    const cwd = mkdtempSync(join(tmpdir(), 'ice-shell-collab-'));
    const tools = createShellCollabTools({ sessionId: 'sess-collab', cwd });
    expect(tools).toHaveLength(SHELL_COLLAB_TOOL_NAMES.length);
    for (const tool of tools) {
      expect(typeof tool.handler).toBe('function');
      expect(tool.definition.name).toBeTruthy();
    }
    const names = tools.map((tool) => tool.definition.name);
    for (const name of SHELL_FILE_TOOL_NAMES) {
      expect(names).toContain(name);
    }
  });

  it('definitions sorted strictly equal SHELL_COLLAB_TOOL_NAMES', () => {
    const cwd = mkdtempSync(join(tmpdir(), 'ice-shell-collab-defs-'));
    const tools = createShellCollabTools({ sessionId: 'sess-defs', cwd });

    const sorted = sortedShellCollabDefinitionNames(tools);
    const expected = [...SHELL_COLLAB_TOOL_NAMES].sort();

    expect(sorted).toEqual(expected);
    expect(shellCollabDefinitionsMatchWhitelist(tools)).toBe(true);
  });

  it('SHELL_COLLAB_TOOL_NAMES contains shell PTY tools and file CRUD tools', () => {
    expect([...SHELL_ONLY_TOOL_NAMES]).toEqual([
      'interactive_shell',
      'shell_exec',
      'shell_wait',
      'shell_send_keys',
    ]);
    expect([...SHELL_FILE_TOOL_NAMES]).toEqual([
      'read_file',
      'write_file',
      'edit_file',
      'fs_operation',
    ]);
    expect([...SHELL_COLLAB_TOOL_NAMES]).toEqual([
      ...SHELL_ONLY_TOOL_NAMES,
      ...SHELL_FILE_TOOL_NAMES,
    ]);
  });

  it('initializeToolSystem does not register shell-only PTY tools', () => {
    const cwd = mkdtempSync(join(tmpdir(), 'ice-global-tools-'));
    const { registry } = initializeToolSystem({
      workDir: cwd,
      sessionId: 'sess-global',
      fileParser: new FileParser(),
    });

    const globalNames = registry.getDefinitions().map((d) => d.name);
    for (const name of SHELL_ONLY_TOOL_NAMES) {
      expect(globalNames).not.toContain(name);
    }
    for (const name of SHELL_FILE_TOOL_NAMES) {
      expect(globalNames).toContain(name);
    }
  });
});
