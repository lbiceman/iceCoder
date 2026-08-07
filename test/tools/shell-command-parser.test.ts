import { describe, expect, it } from 'vitest';

import {
  collectExpandedShellCommands,
  extractNestedShellPayloads,
  splitShellCommandSegments,
} from '../../src/tools/shell-command-parser.js';

describe('shell-command-parser', () => {
  it('splits all supported separators only outside quotes', () => {
    expect(splitShellCommandSegments(
      'echo "a;b|c\nd" && one || two; three | four\r\nfive',
    )).toEqual([
      'echo "a;b|c\nd"',
      'one',
      'two',
      'three',
      'four',
      'five',
    ]);
  });

  it('extracts POSIX, cmd, and PowerShell command payloads', () => {
    expect(extractNestedShellPayloads('bash -lc "echo ok"')).toEqual(['echo ok']);
    expect(extractNestedShellPayloads('cmd.exe /d /c "echo ok"')).toEqual(['echo ok']);
    expect(extractNestedShellPayloads('C:\\Windows\\System32\\cmd.exe /c echo ok')).toEqual(['echo ok']);
    expect(extractNestedShellPayloads('pwsh -NoProfile -Command "echo ok"')).toEqual(['echo ok']);
    expect(extractNestedShellPayloads('sh -c echo ignored-positional-args')).toEqual(['echo']);
  });

  it('recursively expands nested and multiline payloads', () => {
    const expanded = collectExpandedShellCommands(
      'powershell -Command "bash -lc \'echo ok\nrm -rf /\'"',
    );

    expect(expanded).toContain('echo ok');
    expect(expanded).toContain('rm -rf /');
  });
});
