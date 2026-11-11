/**
 * 主窗口自绘标题栏。
 * Windows / Linux 去掉系统标题栏；macOS 保留红绿灯，只让网页铺到顶。
 * 启动页和主界面共用同一套按钮语义。
 */

export type WindowCommand = 'minimize' | 'toggle-maximize' | 'close';

export interface WindowCommandTarget {
  isDestroyed(): boolean;
  isMaximized(): boolean;
  isFullScreen(): boolean;
  minimize(): void;
  maximize(): void;
  unmaximize(): void;
  setFullScreen(flag: boolean): void;
  close(): void;
}

/** 与页面顶栏高度一致。Windows 系统按钮覆盖层用同一高度。 */
export const WINDOW_CAPTION_HEIGHT = 30;

export interface TitleBarOverlayOptions {
  color: string;
  symbolColor: string;
  height: number;
}

export interface MainWindowChromeFields {
  frame: boolean;
  autoHideMenuBar: true;
  thickFrame?: boolean;
  titleBarStyle?: 'hidden' | 'hiddenInset';
  titleBarOverlay?: TitleBarOverlayOptions;
  trafficLightPosition?: { x: number; y: number };
}

const ICON_MINIMIZE =
  '<svg viewBox="0 0 16 16" fill="none" aria-hidden="true"><path d="M3.25 8h9.5" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/></svg>';
const ICON_MAXIMIZE =
  '<svg viewBox="0 0 16 16" fill="none" aria-hidden="true"><rect x="3.15" y="3.15" width="9.7" height="9.7" rx="1.5" stroke="currentColor" stroke-width="1.5"/></svg>';
const ICON_RESTORE =
  '<svg viewBox="0 0 16 16" fill="none" aria-hidden="true"><rect x="5.2" y="3.15" width="7.65" height="7.65" rx="1.35" stroke="currentColor" stroke-width="1.5"/><path d="M5.2 5.4H4.15a1.2 1.2 0 0 0-1.2 1.2v5.05a1.2 1.2 0 0 0 1.2 1.2h5.05a1.2 1.2 0 0 0 1.2-1.2V10.8" stroke="currentColor" stroke-width="1.5" stroke-linejoin="round"/></svg>';
const ICON_CLOSE =
  '<svg viewBox="0 0 16 16" fill="none" aria-hidden="true"><path d="M4.2 4.2l7.6 7.6M11.8 4.2L4.2 11.8" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/></svg>';

/**
 * 右上角三个按钮交给系统画，不在网页里画。
 * macOS 是红绿灯；Windows / Linux 是标题栏按钮覆盖层，命中由系统算。
 */
export function windowChromeKind(platform: NodeJS.Platform = process.platform): 'overlay' | 'traffic-lights' {
  return platform === 'darwin' ? 'traffic-lights' : 'overlay';
}

/** 网页里不再自绘最小化 / 最大化 / 关闭。 */
export function windowUsesCustomControls(_platform: NodeJS.Platform = process.platform): boolean {
  return false;
}

/** macOS 红绿灯落在顶栏高度里；Windows / Linux 用系统按钮覆盖层。 */
export function mainWindowChromeFields(platform: NodeJS.Platform = process.platform): MainWindowChromeFields {
  if (platform === 'darwin') {
    return {
      frame: true,
      autoHideMenuBar: true,
      titleBarStyle: 'hiddenInset',
      trafficLightPosition: { x: 16, y: 9 },
    };
  }
  return {
    frame: false,
    thickFrame: true,
    autoHideMenuBar: true,
    titleBarStyle: 'hidden',
    titleBarOverlay: {
      height: WINDOW_CAPTION_HEIGHT,
      color: '#0e0f12',
      symbolColor: '#e6e8ee',
    },
  };
}

export function applyWindowCommand(win: WindowCommandTarget, command: WindowCommand): void {
  if (win.isDestroyed()) return;
  if (command === 'minimize') {
    win.minimize();
    return;
  }
  if (command === 'close') {
    win.close();
    return;
  }
  if (win.isFullScreen()) {
    win.setFullScreen(false);
    return;
  }
  if (win.isMaximized()) win.unmaximize();
  else win.maximize();
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/** 服务起来之前的启动页。没有系统标题栏，所以这里也要能拖、能关。 */
export function startupDocumentHtml(appName: string, options?: { controls?: boolean }): string {
  const name = escapeHtml(appName);
  const controls = options?.controls ?? windowUsesCustomControls();
  const buttons = controls
    ? `<div class="window-caption-controls">
        <button type="button" class="window-caption-btn" data-window-action="minimize" aria-label="最小化">${ICON_MINIMIZE}</button>
        <button type="button" class="window-caption-btn" data-window-action="maximize" aria-label="最大化"><span class="is-max">${ICON_MAXIMIZE}</span><span class="is-restore">${ICON_RESTORE}</span></button>
        <button type="button" class="window-caption-btn is-close" data-window-action="close" aria-label="关闭">${ICON_CLOSE}</button>
      </div>`
    : '';
  return `<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8"><title>${name}</title>
<style>
  html,body{height:100%}
  body{margin:0;background:#0e0f12;color:#e6e8ee;font:14px system-ui,sans-serif;display:flex;flex-direction:column;height:100vh;overflow:hidden;-webkit-app-region:no-drag}
  .window-caption{height:30px;display:flex;align-items:stretch;justify-content:flex-end;flex-shrink:0;background:#0e0f12;-webkit-app-region:drag}
  .loading{flex:1}
  .window-caption-controls{display:flex;-webkit-app-region:no-drag}
  .window-caption-btn{width:42px;height:100%;border:0;padding:0;background:transparent;color:#c8cad3;display:inline-flex;align-items:center;justify-content:center;-webkit-app-region:no-drag}
  .window-caption-btn svg{width:15px;height:15px;display:block}
  .window-caption-btn:hover{background:rgba(255,255,255,.08);color:#fff}
  .window-caption-btn.is-close:hover{background:#e5484d;color:#fff}
  .window-caption-btn .is-restore{display:none}
  .window-caption-btn.is-maximized .is-max{display:none}
  .window-caption-btn.is-maximized .is-restore{display:inline-flex}
  .loading{flex:1;display:flex;gap:12px;align-items:center;justify-content:center}
  .dot{width:10px;height:10px;border:2px solid #f2f2f3;border-top-color:transparent;border-radius:50%;animation:spin .8s linear infinite}
  @keyframes spin{to{transform:rotate(360deg)}}
</style></head><body>
<header class="window-caption">${buttons}</header>
<div class="loading"><span class="dot"></span><span>正在启动 ${name}…</span></div>
<script>
(function () {
  var api = window.iceDesktop;
  if (!api) return;
  function bind(action, fn) {
    var el = document.querySelector('[data-window-action="' + action + '"]');
    if (el) el.addEventListener('click', fn);
  }
  bind('minimize', function () { api.windowMinimize(); });
  bind('maximize', function () { api.windowToggleMaximize(); });
  bind('close', function () { api.windowClose(); });
  function setMaximized(on) {
    var btn = document.querySelector('[data-window-action="maximize"]');
    if (!btn) return;
    btn.classList.toggle('is-maximized', !!on);
    btn.setAttribute('aria-label', on ? '还原' : '最大化');
  }
  var cap = document.querySelector('.window-caption');
  if (cap) cap.addEventListener('dblclick', function (e) {
    if (e.target && e.target.closest && e.target.closest('.window-caption-controls')) return;
    api.windowToggleMaximize();
  });
  if (typeof api.windowGetChromeState === 'function') {
    api.windowGetChromeState().then(function (state) {
      if (state) setMaximized(!!state.maximized);
    });
  }
  if (typeof api.onWindowMaximized === 'function') {
    api.onWindowMaximized(function (on) { setMaximized(!!on); });
  }
})();
</script>
</body></html>`;
}
