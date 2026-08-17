import { describe, expect, it, vi, afterEach } from 'vitest';
import {
  buildOpenBrowserCommand,
  maybeOpenAppInBrowser,
  resolveLaunchUrl,
  shouldOpenBrowser,
} from '../../src/cli/open-browser.js';

afterEach(() => {
  vi.restoreAllMocks();
});

describe('resolveLaunchUrl', () => {
  it('首次配置打开设置页', () => {
    expect(resolveLaunchUrl(1024, true)).toBe('http://127.0.0.1:1024/#/settings');
  });

  it('已配置打开聊天页', () => {
    expect(resolveLaunchUrl(3784, false)).toBe('http://127.0.0.1:3784/#/chat');
  });
});

describe('shouldOpenBrowser', () => {
  it('默认打开', () => {
    expect(shouldOpenBrowser({ flags: {}, env: {} })).toBe(true);
  });

  it('--no-open 不打开', () => {
    expect(shouldOpenBrowser({ flags: { 'no-open': true }, env: {} })).toBe(false);
  });

  it('ICE_NO_OPEN=1 不打开', () => {
    expect(shouldOpenBrowser({ flags: {}, env: { ICE_NO_OPEN: '1' } })).toBe(false);
  });

  it('CI=true 不打开', () => {
    expect(shouldOpenBrowser({ flags: {}, env: { CI: 'true' } })).toBe(false);
  });
});

describe('buildOpenBrowserCommand', () => {
  const url = 'http://127.0.0.1:1024/#/settings';

  it('Windows 给 URL 加引号，避免 cmd 把 # 当注释', () => {
    expect(buildOpenBrowserCommand(url, 'win32')).toBe(
      'cmd /c start "" "http://127.0.0.1:1024/#/settings"',
    );
  });

  it('macOS 使用 open', () => {
    expect(buildOpenBrowserCommand(url, 'darwin')).toBe(
      'open "http://127.0.0.1:1024/#/settings"',
    );
  });

  it('Linux 使用 xdg-open', () => {
    expect(buildOpenBrowserCommand(url, 'linux')).toBe(
      'xdg-open "http://127.0.0.1:1024/#/settings"',
    );
  });
});

describe('maybeOpenAppInBrowser', () => {
  it('--no-open 时不执行打开命令', async () => {
    const execCommand = vi.fn(async () => true);
    const result = await maybeOpenAppInBrowser({
      port: 1024,
      needsSetup: false,
      flags: { 'no-open': true },
      env: {},
      execCommand,
    });
    expect(result).toEqual({ opened: false, url: 'http://127.0.0.1:1024/#/chat' });
    expect(execCommand).not.toHaveBeenCalled();
  });

  it('允许打开时执行命令并返回 url', async () => {
    const execCommand = vi.fn(async () => true);
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    const result = await maybeOpenAppInBrowser({
      port: 1024,
      needsSetup: true,
      flags: {},
      env: {},
      platform: 'win32',
      execCommand,
    });
    expect(result.opened).toBe(true);
    expect(result.url).toBe('http://127.0.0.1:1024/#/settings');
    expect(execCommand).toHaveBeenCalledWith(
      'cmd /c start "" "http://127.0.0.1:1024/#/settings"',
    );
    expect(log).toHaveBeenCalled();
  });

  it('打开失败时返回 opened=false 且不抛错', async () => {
    const execCommand = vi.fn(async () => false);
    vi.spyOn(console, 'log').mockImplementation(() => {});
    const result = await maybeOpenAppInBrowser({
      port: 1024,
      needsSetup: false,
      flags: {},
      env: {},
      execCommand,
    });
    expect(result.opened).toBe(false);
    expect(result.url).toBe('http://127.0.0.1:1024/#/chat');
  });
});
