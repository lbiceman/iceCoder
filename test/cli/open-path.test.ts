import { describe, expect, it } from 'vitest';
import { pathToFileURL } from 'node:url';
import {
  buildRevealFolderFallbackInvocation,
  buildRevealInFolderInvocation,
  revealPathInFolder,
  sanitizeWindowsExplorerPath,
} from '../../src/cli/open-path.js';

describe('sanitizeWindowsExplorerPath', () => {
  it('去掉会吃掉收尾引号的尾部反斜杠', () => {
    expect(sanitizeWindowsExplorerPath('C:\\repo\\notes\\')).toBe('C:\\repo\\notes');
  });
});

describe('buildRevealInFolderInvocation', () => {
  const abs = 'C:\\repo\\notes\\todo.md';

  it('Windows 把 /select 和带引号路径合成一条原始命令行', () => {
    expect(buildRevealInFolderInvocation(abs, 'win32')).toEqual({
      command: 'explorer.exe',
      args: ['/select,"C:\\repo\\notes\\todo.md"'],
      windowsVerbatimArguments: true,
      windowsHide: false,
    });
  });

  it('Windows 路径含空格时只给路径加引号', () => {
    expect(buildRevealInFolderInvocation('C:\\Users\\a b\\todo.md', 'win32').args).toEqual([
      '/select,"C:\\Users\\a b\\todo.md"',
    ]);
  });

  it('macOS 使用 open -R', () => {
    expect(buildRevealInFolderInvocation('/tmp/a.md', 'darwin')).toEqual({
      command: 'open',
      args: ['-R', '/tmp/a.md'],
    });
  });

  it('Linux 使用 FileManager1.ShowItems', () => {
    const inv = buildRevealInFolderInvocation('/tmp/a.md', 'linux');
    expect(inv.command).toBe('dbus-send');
    expect(inv.args).toContain('org.freedesktop.FileManager1.ShowItems');
    expect(inv.args).toContain(`array:string:${pathToFileURL('/tmp/a.md').href}`);
  });
});

describe('buildRevealFolderFallbackInvocation', () => {
  it('Linux 回退时打开父目录', () => {
    expect(buildRevealFolderFallbackInvocation('/tmp/dir/a.md', 'linux')).toEqual({
      command: 'xdg-open',
      args: ['/tmp/dir'],
    });
  });
});

describe('revealPathInFolder', () => {
  it('调用系统命令并传入绝对路径', async () => {
    const execCommand = async (command: string, args: string[]) => {
      expect(command).toBe('explorer.exe');
      expect(args).toEqual(['/select,"D:\\ws\\a.txt"']);
      return true;
    };
    await expect(revealPathInFolder('D:\\ws\\a.txt', {
      platform: 'win32',
      execCommand,
    })).resolves.toBe(true);
  });

  it('Linux 在 dbus-send 失败时回退到打开父目录', async () => {
    const calls: { command: string; args: string[] }[] = [];
    const execCommand = async (command: string, args: string[]) => {
      calls.push({ command, args });
      return command !== 'dbus-send';
    };
    await expect(revealPathInFolder('/tmp/dir/a.md', {
      platform: 'linux',
      execCommand,
    })).resolves.toBe(true);
    expect(calls[0]?.command).toBe('dbus-send');
    expect(calls[1]).toEqual({ command: 'xdg-open', args: ['/tmp/dir'] });
  });

  it('拒绝空路径和含引号路径', async () => {
    const execCommand = async () => true;
    await expect(revealPathInFolder('  ', { execCommand })).resolves.toBe(false);
    await expect(revealPathInFolder('C:\\a"b.txt', { execCommand })).resolves.toBe(false);
  });
});
