import { describe, expect, it } from 'vitest';
import { buildOpenPathInvocation, openPathWithDefaultApp } from '../../src/cli/open-path.js';

describe('buildOpenPathInvocation', () => {
  const abs = 'C:\\repo\\notes\\todo.md';

  it('Windows 用 start 交给系统关联程序', () => {
    expect(buildOpenPathInvocation(abs, 'win32')).toEqual({
      command: 'cmd.exe',
      args: ['/c', 'start', '', abs],
    });
  });

  it('macOS 使用 open', () => {
    expect(buildOpenPathInvocation('/tmp/a.md', 'darwin')).toEqual({
      command: 'open',
      args: ['/tmp/a.md'],
    });
  });

  it('Linux 使用 xdg-open', () => {
    expect(buildOpenPathInvocation('/tmp/a.md', 'linux')).toEqual({
      command: 'xdg-open',
      args: ['/tmp/a.md'],
    });
  });
});

describe('openPathWithDefaultApp', () => {
  it('调用系统命令并传入绝对路径', async () => {
    const execCommand = async (command: string, args: string[]) => {
      expect(command).toBe('cmd.exe');
      expect(args).toEqual(['/c', 'start', '', 'D:\\ws\\a.txt']);
      return true;
    };
    await expect(openPathWithDefaultApp('D:\\ws\\a.txt', {
      platform: 'win32',
      execCommand,
    })).resolves.toBe(true);
  });

  it('拒绝空路径和含引号路径', async () => {
    const execCommand = async () => true;
    await expect(openPathWithDefaultApp('  ', { execCommand })).resolves.toBe(false);
    await expect(openPathWithDefaultApp('C:\\a"b.txt', { execCommand })).resolves.toBe(false);
  });
});
