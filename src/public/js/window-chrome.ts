/**
 * Electron 主窗口的自绘标题栏。
 * 项目图标里没有最小化 / 最大化 / 关闭，这里按现有 16px 描边风格直接画。
 * 浏览器里没有 iceDesktop，本文件什么都不挂。
 */
import { t } from './i18n.ts';

const ICON_MINIMIZE =
  '<svg viewBox="0 0 16 16" fill="none" aria-hidden="true"><path d="M3.25 8h9.5" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/></svg>';
const ICON_MAXIMIZE =
  '<svg viewBox="0 0 16 16" fill="none" aria-hidden="true"><rect x="3.15" y="3.15" width="9.7" height="9.7" rx="1.5" stroke="currentColor" stroke-width="1.5"/></svg>';
const ICON_RESTORE =
  '<svg viewBox="0 0 16 16" fill="none" aria-hidden="true"><rect x="5.2" y="3.15" width="7.65" height="7.65" rx="1.35" stroke="currentColor" stroke-width="1.5"/><path d="M5.2 5.4H4.15a1.2 1.2 0 0 0-1.2 1.2v5.05a1.2 1.2 0 0 0 1.2 1.2h5.05a1.2 1.2 0 0 0 1.2-1.2V10.8" stroke="currentColor" stroke-width="1.5" stroke-linejoin="round"/></svg>';
const ICON_CLOSE =
  '<svg viewBox="0 0 16 16" fill="none" aria-hidden="true"><path d="M4.2 4.2l7.6 7.6M11.8 4.2L4.2 11.8" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/></svg>';

function attr(value: string): string {
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/"/g, '&quot;')
    .replace(/</g, '&lt;');
}

function label(key: string): string {
  return t(key, undefined);
}

function cssColorToHex(color: string): string | null {
  const matched = color.match(/rgba?\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)/);
  if (!matched) return /^#[0-9a-fA-F]{6}$/.test(color) ? color : null;
  const channel = (value: string) => Number(value).toString(16).padStart(2, '0');
  return `#${channel(matched[1])}${channel(matched[2])}${channel(matched[3])}`;
}

/** 系统按钮覆盖层的底色跟着顶栏走，避免主题一切就露出一条异色。 */
function syncTitleBarOverlay(caption: HTMLElement): void {
  const api = window.iceDesktop;
  if (api?.windowChrome !== 'overlay' || typeof api.windowSetTitleBarOverlay !== 'function') return;
  const style = getComputedStyle(caption);
  const color = cssColorToHex(style.backgroundColor);
  const symbolColor = cssColorToHex(style.color);
  if (!color || !symbolColor) return;
  api.windowSetTitleBarOverlay({ color, symbolColor });
}

export function mountWindowChrome(): void {
  const api = window.iceDesktop;
  if (!api || typeof api.windowMinimize !== 'function') return;
  if (document.querySelector('.window-caption')) return;
  const app = document.getElementById('app');
  if (!app) return;

  document.documentElement.classList.add('ice-window-chrome');
  const overlay = api.windowChrome === 'overlay';
  const customControls = !overlay && api.windowControls !== false;
  document.documentElement.classList.toggle('ice-window-overlay', overlay);
  document.documentElement.classList.toggle(
    'ice-window-native-controls',
    api.windowChrome === 'traffic-lights' || (!overlay && !customControls),
  );

  const controls = customControls
    ? `<div class="window-caption-controls">
        <button type="button" class="window-caption-btn" data-window-action="minimize" aria-label="${attr(label('window.minimize'))}">${ICON_MINIMIZE}</button>
        <button type="button" class="window-caption-btn" data-window-action="maximize" aria-label="${attr(label('window.maximize'))}"><span class="window-caption-glyph is-max">${ICON_MAXIMIZE}</span><span class="window-caption-glyph is-restore">${ICON_RESTORE}</span></button>
        <button type="button" class="window-caption-btn window-caption-close" data-window-action="close" aria-label="${attr(label('window.close'))}">${ICON_CLOSE}</button>
      </div>`
    : '';

  const caption = document.createElement('header');
  caption.className = 'window-caption';
  caption.setAttribute('aria-label', label('window.caption'));
  caption.innerHTML = `<span class="window-caption-title">${attr(label('window.appTitle'))}</span>${controls}`;
  const shell = app.querySelector('.app-shell');
  if (shell) app.insertBefore(caption, shell);
  else app.insertBefore(caption, app.firstChild);

  const maxBtn = caption.querySelector('[data-window-action="maximize"]');
  const setMaximized = (maximized: boolean) => {
    document.documentElement.classList.toggle('is-window-maximized', maximized);
    if (maxBtn) maxBtn.setAttribute('aria-label', maximized ? label('window.restore') : label('window.maximize'));
  };
  const setFocused = (focused: boolean) => {
    document.documentElement.classList.toggle('is-window-blurred', !focused);
  };

  caption.querySelector('[data-window-action="minimize"]')?.addEventListener('click', () => {
    api.windowMinimize?.();
  });
  caption.querySelector('[data-window-action="maximize"]')?.addEventListener('click', () => {
    api.windowToggleMaximize?.();
  });
  caption.querySelector('[data-window-action="close"]')?.addEventListener('click', () => {
    api.windowClose?.();
  });
  if (!overlay) {
    caption.addEventListener('dblclick', (event) => {
      const target = event.target;
      if (target instanceof Element && target.closest('.window-caption-controls')) return;
      api.windowToggleMaximize?.();
    });
  }

  if (typeof api.windowGetChromeState === 'function') {
    api.windowGetChromeState().then((state) => {
      if (!state) return;
      setMaximized(!!state.maximized);
      setFocused(state.focused !== false);
    }).catch(() => { /* 启动瞬间窗口可能已关掉 */ });
  }
  if (typeof api.onWindowMaximized === 'function') {
    api.onWindowMaximized((maximized) => setMaximized(!!maximized));
  }
  if (typeof api.onWindowFocus === 'function') {
    api.onWindowFocus((focused) => setFocused(!!focused));
  }
  if (overlay) {
    const publishOverlay = () => syncTitleBarOverlay(caption);
    publishOverlay();
    window.requestAnimationFrame(publishOverlay);
    const themeObserver = new MutationObserver(publishOverlay);
    themeObserver.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });
  }
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', () => mountWindowChrome());
} else {
  mountWindowChrome();
}

window.WindowChrome = { mount: mountWindowChrome };
