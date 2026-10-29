/**
 * 把钩子、浮层和截图串起来。
 * 问号只落一次。矩形按这个落点补上，不再改问号的坐标。
 * 连续问号只认最后一次。到点直接截图再发请求。浮层对截图不可见，问号不用先藏起来。
 */
import { writeConsole } from '../console-output';
import { PASTE_SLICE, QUESTION_SLICE, wheelSlice } from './geometry';
import { createScreenPingHook, type ScreenPingHook } from './hook-win';
import { captureRegionAround, type RegionShot } from './capture-win';
import { createPingOverlay, type PingOverlay } from './overlay';
import { readScreenPingEnabled, readScreenPingSettings, writeScreenPingSettings } from './settings';
import type { GestureEffect } from './gesture';

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

export function createScreenPingController(opts: {
  serverBaseUrl: string;
  /** 正下方截图放进主窗口输入框。 */
  onPasteShot?: (dataUrl: string) => void;
}): ScreenPingController {
  const serverBaseUrl = opts.serverBaseUrl.replace(/\/$/, '');
  let enabled = false;
  let hook: ScreenPingHook | null = null;
  let overlay: PingOverlay | null = null;
  let watchdog: NodeJS.Timeout | null = null;
  let askGen = 0;
  let lastSlice: number | null = null;
  let markerTimer: ReturnType<typeof setTimeout> | null = null;

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
      clearMarkerTimer();
      view.reveal();
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
        askGen += 1;
        view.reveal();
        closeMarker();
      }
      return;
    }
    if (effect.type !== 'release') return;
    lastSlice = null;
    view.hideWheel();
    const slice = wheelSlice(effect.x - effect.originX, effect.y - effect.originY);
    if (slice == null) return;
    if (slice === QUESTION_SLICE) {
      scheduleAsk(effect.originX, effect.originY);
      return;
    }
    if (slice === PASTE_SLICE) {
      void pasteShot(effect.originX, effect.originY);
      return;
    }
    view.showSignal(effect.originX, effect.originY, slice);
  }

  async function pasteShot(x: number, y: number): Promise<void> {
    const { cropWidth, cropHeight } = readScreenPingSettings();
    try {
      const shot = captureRegionAround(x, y, cropWidth, cropHeight);
      opts.onPasteShot?.(shot.dataUrl);
    } catch (err) {
      log(`paste capture failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  function scheduleAsk(x: number, y: number): void {
    const view = overlay;
    if (!view) return;
    const gen = ++askGen;
    clearMarkerTimer();
    hook?.setMarkerOpen(true);
    void placeThenAsk(view, gen, x, y);
  }

  async function placeThenAsk(view: PingOverlay, gen: number, x: number, y: number): Promise<void> {
    const { cropWidth, cropHeight } = readScreenPingSettings();
    const due = Date.now() + ASK_DEBOUNCE_MS;
    view.showMarker(x, y, 'wait', '');
    await delay(32);
    if (!enabled || gen !== askGen) return;
    view.showCrop(cropWidth, cropHeight);
    const remain = due - Date.now();
    if (remain > 0) await delay(remain);
    if (!enabled || gen !== askGen) return;

    let shot: RegionShot;
    try {
      shot = captureRegionAround(x, y, cropWidth, cropHeight);
    } catch (err) {
      log(`capture failed: ${err instanceof Error ? err.message : String(err)}`);
      if (!enabled || gen !== askGen) return;
      view.showMarker(x, y, 'error', '这块画面没有截下来');
      await delay(32);
      if (!enabled || gen !== askGen) return;
      view.showCrop(cropWidth, cropHeight);
      armMarkerTimer();
      return;
    }
    if (!enabled || gen !== askGen) return;
    void askAt(view, gen, shot);
  }

  async function askAt(view: PingOverlay, gen: number, shot: RegionShot): Promise<void> {
    if (!enabled || gen !== askGen) return;
    clearMarkerTimer();
    view.patchMarker('loading', '在看这块画面…');
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
        view.patchMarker('error', message);
        armMarkerTimer();
        return;
      }
      const text = typeof payload.text === 'string' ? payload.text.trim() : '';
      view.patchMarker(text ? 'answer' : 'error', text || '模型没有给出回答');
      armMarkerTimer();
    } catch (err) {
      if (gen !== askGen) return;
      log(`ask failed: ${err instanceof Error ? err.message : String(err)}`);
      view.patchMarker('error', '提问失败，看一下模型配置');
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
