/**
 * 把钩子、浮层和截图串起来：松手在问号上 → 藏起浮层 → 截 200px → 问模型 → 把回答画回落点。
 */
import { writeConsole } from '../console-output';
import { QUESTION_SLICE, wheelSlice } from './geometry';
import { createScreenPingHook, type ScreenPingHook } from './hook-win';
import { captureRegionAround } from './capture-win';
import { createPingOverlay, type PingOverlay } from './overlay';
import { readScreenPingEnabled, readScreenPingSettings, writeScreenPingSettings } from './settings';
import type { GestureEffect } from './gesture';

const CAPTURE_SETTLE_MS = 80;
const WATCHDOG_INTERVAL_MS = 1000;
const MARKER_TTL_MS = 30_000;
/** 连续落问号时只解析最后一次。这段时间够再开一次轮盘。 */
const ASK_DEBOUNCE_MS = 1000;

export interface ScreenPingController {
  setEnabled(enabled: boolean): void;
  isEnabled(): boolean;
  stop(): void;
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => { setTimeout(resolve, ms); });
}

export function createScreenPingController(opts: { serverBaseUrl: string }): ScreenPingController {
  const serverBaseUrl = opts.serverBaseUrl.replace(/\/$/, '');
  let enabled = false;
  let hook: ScreenPingHook | null = null;
  let overlay: PingOverlay | null = null;
  let watchdog: NodeJS.Timeout | null = null;
  let askGen = 0;
  let captureToken = 0;
  let lastSlice: number | null = null;
  let markerTimer: ReturnType<typeof setTimeout> | null = null;
  let askTimer: ReturnType<typeof setTimeout> | null = null;
  let pendingAsk: { x: number; y: number } | null = null;

  function clearAskTimer(): void {
    if (!askTimer) return;
    clearTimeout(askTimer);
    askTimer = null;
    pendingAsk = null;
  }

  function clearMarkerTimer(): void {
    if (!markerTimer) return;
    clearTimeout(markerTimer);
    markerTimer = null;
  }

  function closeMarker(): void {
    clearMarkerTimer();
    overlay?.hideMarker();
    hook?.setMarkerOpen(false);
  }

  function armMarkerTimer(): void {
    clearMarkerTimer();
    const gen = askGen;
    markerTimer = setTimeout(() => {
      markerTimer = null;
      if (!enabled || gen !== askGen) return;
      closeMarker();
    }, MARKER_TTL_MS);
  }

  function log(line: string): void {
    writeConsole(process.stdout, `[screen-ping] ${line}\n`);
  }

  function ensureOverlay(): PingOverlay {
    if (!overlay) {
      overlay = createPingOverlay(() => {
        hook?.abort();
        lastSlice = null;
      });
    }
    return overlay;
  }

  function onEffect(effect: GestureEffect): void {
    const view = overlay;
    if (!view || !enabled) return;
    if (effect.type === 'open') {
      askGen += 1;
      clearAskTimer();
      clearMarkerTimer();
      hook?.setMarkerOpen(false);
      lastSlice = wheelSlice(effect.x - effect.originX, effect.y - effect.originY);
      view.showWheel(effect.originX, effect.originY, effect.x, effect.y, lastSlice);
      return;
    }
    if (effect.type === 'move') {
      const slice = wheelSlice(effect.x - effect.originX, effect.y - effect.originY);
      if (slice === lastSlice) return;
      lastSlice = slice;
      view.setWheelSlice(slice);
      return;
    }
    if (effect.type === 'cancel' || effect.type === 'dismiss') {
      lastSlice = null;
      view.hideWheel();
      if (effect.type === 'dismiss') {
        clearAskTimer();
        closeMarker();
      }
      return;
    }
    if (effect.type !== 'release') return;
    lastSlice = null;
    view.hideWheel();
    const slice = wheelSlice(effect.x - effect.originX, effect.y - effect.originY);
    if (slice !== QUESTION_SLICE) return;
    scheduleAsk(effect.originX, effect.originY);
  }

  function scheduleAsk(x: number, y: number): void {
    const view = overlay;
    if (!view) return;
    askGen += 1;
    clearAskTimer();
    clearMarkerTimer();
    pendingAsk = { x, y };
    view.showMarker(x, y, 'wait', '', readScreenPingSettings().cropPx);
    hook?.setMarkerOpen(true);
    askTimer = setTimeout(() => {
      askTimer = null;
      const point = pendingAsk;
      pendingAsk = null;
      if (!enabled || !point) return;
      void askAt(point.x, point.y);
    }, ASK_DEBOUNCE_MS);
  }

  async function askAt(originX: number, originY: number): Promise<void> {
    const view = overlay;
    if (!view) return;
    const gen = ++askGen;
    const token = ++captureToken;
    const cropPx = readScreenPingSettings().cropPx;
    clearMarkerTimer();
    // 问号和黄框已经在落点上。截图只藏窗口，不要先拆掉标记再画一次。
    view.hideForCapture();
    await delay(CAPTURE_SETTLE_MS);
    if (!enabled || token !== captureToken) return;
    if (gen !== askGen) {
      view.reveal();
      return;
    }
    let shot: ReturnType<typeof captureRegionAround>;
    try {
      shot = captureRegionAround(originX, originY, cropPx);
    } catch (err) {
      log(`capture failed: ${err instanceof Error ? err.message : String(err)}`);
      if (gen !== askGen) return;
      view.reveal();
      if (gen !== askGen) return;
      view.showMarker(originX, originY, 'error', '这块画面没有截下来', cropPx);
      hook?.setMarkerOpen(true);
      armMarkerTimer();
      return;
    }
    if (gen !== askGen) return;
    view.reveal();
    if (!enabled || gen !== askGen) return;
    view.showMarker(originX, originY, 'loading', '在看这块画面…', cropPx);
    hook?.setMarkerOpen(true);
    try {
      const response = await fetch(`${serverBaseUrl}/api/screen-ping/ask`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          image: shot.dataUrl,
          anchorX: shot.anchorX,
          anchorY: shot.anchorY,
          width: shot.width,
          height: shot.height,
        }),
        signal: AbortSignal.timeout(50_000),
      });
      const payload = await response.json().catch(() => ({})) as { text?: unknown; error?: unknown };
      if (gen !== askGen) return;
      if (!response.ok) {
        const message = typeof payload.error === 'string' && payload.error.trim()
          ? payload.error.trim()
          : '没有问到回答';
        view.showMarker(originX, originY, 'error', message, cropPx);
        armMarkerTimer();
        return;
      }
      const text = typeof payload.text === 'string' ? payload.text.trim() : '';
      view.showMarker(originX, originY, text ? 'answer' : 'error', text || '模型没有给出回答', cropPx);
      armMarkerTimer();
    } catch (err) {
      if (gen !== askGen) return;
      log(`ask failed: ${err instanceof Error ? err.message : String(err)}`);
      view.showMarker(originX, originY, 'error', '提问失败，看一下模型配置', cropPx);
      armMarkerTimer();
    }
  }

  function start(): void {
    if (enabled || process.platform !== 'win32') return;
    enabled = true;
    try {
      const view = ensureOverlay();
      view.warm();
      hook = createScreenPingHook(onEffect);
      hook.start();
      watchdog = setInterval(() => hook?.pulse(Date.now()), WATCHDOG_INTERVAL_MS);
      log('hook on');
    } catch (err) {
      enabled = false;
      hook?.stop();
      hook = null;
      if (watchdog) clearInterval(watchdog);
      watchdog = null;
      log(`hook failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  function stopHook(): void {
    enabled = false;
    askGen += 1;
    clearAskTimer();
    clearMarkerTimer();
    if (watchdog) clearInterval(watchdog);
    watchdog = null;
    hook?.stop();
    hook = null;
    overlay?.hideWheel();
    overlay?.hideMarker();
    overlay?.destroy();
    overlay = null;
    lastSlice = null;
  }

  if (process.platform === 'win32' && readScreenPingEnabled()) start();

  return {
    isEnabled: () => enabled,
    setEnabled(next: boolean) {
      writeScreenPingSettings({ enabled: next });
      if (process.platform !== 'win32') return;
      if (next) start();
      else stopHook();
    },
    stop() {
      stopHook();
    },
  };
}
