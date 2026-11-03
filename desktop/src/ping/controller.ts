/**
 * 把钩子、浮层和截图串起来。
 * 左边和右边都是自己框选。左边把这块画面交给模型，右边复制到剪贴板并放进输入框。
 * 正下记下一条待办，正上只落图标。连续提问只认最后一次。浮层对截图不可见。
 */
import { clipboard, nativeImage } from 'electron';
import { writeConsole } from '../console-output';
import { physicalToLocal, wheelReleaseAction, wheelSlice, type ScreenRect } from './geometry';
import { createScreenPingHook, type ScreenPingHook } from './hook-win';
import { capturePhysicalRect, type RegionShot } from './capture-win';
import { createPingOverlay, readPingDisplayMaps, type PingOverlay } from './overlay';
import { createSnipSession, reduceSnip, SNIP_MIN_PX, snipShowsChrome, type SnipSession } from './snip-session';
import { shrinkPngDataUrl } from './shrink-shot';
import { createTodoDraft, type TodoDraft } from './todo-draft';
import { readScreenPingEnabled, writeScreenPingSettings } from './settings';
import type { GestureEffect } from './gesture';

const WATCHDOG_INTERVAL_MS = 1000;
const MARKER_TTL_MS = 30_000;
/** 问号请求要小于 Express 的 5mb JSON 上限。过大的框选先缩小再送。 */
const ASK_IMAGE_MAX_CHARS = 1_400_000;

type SnipPurpose = 'copy' | 'ask' | 'todo';

export interface ScreenPingController {
  setEnabled(enabled: boolean): void;
  isEnabled(): boolean;
  stop(): void;
}

export function createScreenPingController(opts: {
  serverBaseUrl: string;
  /** 右侧框选放进主窗口输入框。 */
  onPasteShot?: (dataUrl: string) => void;
}): ScreenPingController {
  const serverBaseUrl = opts.serverBaseUrl.replace(/\/$/, '');
  let enabled = false;
  let hook: ScreenPingHook | null = null;
  let overlay: PingOverlay | null = null;
  let watchdog: NodeJS.Timeout | null = null;
  let askGen = 0;
  let snipGen = 0;
  let snipLive = false;
  let snipPurpose: SnipPurpose = 'copy';
  let snipState: SnipSession = createSnipSession();
  let lastSlice: number | null = null;
  let markerTimer: ReturnType<typeof setTimeout> | null = null;
  let draftWindow: TodoDraft | null = null;
  let draftEpoch = 0;
  let draftText = '';
  let draftImage: string | null = null;
  let draftError = '';
  let draftDip: { x: number; y: number } | null = null;

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
        cancelActiveSnip();
      });
    }
    return overlay;
  }

  function resetSnip(): void {
    snipLive = false;
    snipState = createSnipSession();
    hook?.setSnipOpen(false);
  }

  function cancelSnip(): void {
    snipGen += 1;
    resetSnip();
    overlay?.endSnip();
  }

  function finishRegionSnip(): void {
    const rect = snipState.rect;
    if (!snipLive || !rect || rect.width < SNIP_MIN_PX || rect.height < SNIP_MIN_PX) return;
    const purpose = snipPurpose;
    snipGen += 1;
    resetSnip();
    overlay?.endSnip();
    if (purpose === 'ask') void askRegion(rect);
    else if (purpose === 'todo') void attachTodoShot(rect);
    else void deliverRegionSnip(rect);
  }

  function paintLiveSnip(): void {
    if (!snipLive) return;
    overlay?.paintSnip(snipState.rect, snipShowsChrome(snipState.phase));
  }

  function onSnipPointer(phase: 'down' | 'move' | 'up', x: number, y: number): void {
    if (!snipLive) return;
    const result = reduceSnip(snipState, { kind: phase, x, y, now: Date.now() }, readPingDisplayMaps());
    snipState = result.state;
    if (result.done === 'ok') {
      finishRegionSnip();
      return;
    }
    if (result.done === 'cancel') {
      cancelActiveSnip();
      return;
    }
    if (result.paint) paintLiveSnip();
  }

  function beginRegionSnip(purpose: SnipPurpose): void {
    const view = overlay;
    if (!view) return;
    const gen = ++snipGen;
    snipLive = true;
    snipPurpose = purpose;
    snipState = createSnipSession();
    hook?.setSnipOpen(true);
    view.beginSnip({
      onOk: () => {
        if (gen !== snipGen) return;
        finishRegionSnip();
      },
      onCancel: () => {
        if (gen !== snipGen) return;
        cancelActiveSnip();
      },
    }, purpose);
  }

  async function deliverRegionSnip(rect: ScreenRect): Promise<void> {
    try {
      const shot = capturePhysicalRect(rect);
      const image = nativeImage.createFromDataURL(shot.dataUrl);
      if (!image.isEmpty()) clipboard.writeImage(image);
      opts.onPasteShot?.(shot.dataUrl);
      log(`snip ${shot.width}x${shot.height}`);
    } catch (err) {
      log(`snip capture failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  function releaseToDip(physX: number, physY: number): { x: number; y: number } | null {
    const maps = readPingDisplayMaps();
    const local = physicalToLocal(physX, physY, maps);
    if (!local) return null;
    const map = maps.find((item) => item.id === local.id);
    if (!map) return null;
    return { x: map.dip.x + local.x, y: map.dip.y + local.y };
  }

  function ensureDraft(): TodoDraft {
    if (!draftWindow) {
      draftWindow = createTodoDraft({
        onSubmit: (text) => { void submitTodoDraft(text); },
        onSnip: (text) => { beginTodoSnip(text); },
        onCancel: () => { discardTodoDraft(); },
      });
    }
    return draftWindow;
  }

  function showTodoDraft(): void {
    if (!draftDip) return;
    try {
      hook?.setDraftOpen(true);
      ensureDraft().show({
        dipX: draftDip.x,
        dipY: draftDip.y,
        text: draftText,
        image: draftImage,
        error: draftError,
      });
    } catch (err) {
      log(`todo draft failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  function discardTodoDraft(): void {
    draftEpoch += 1;
    draftText = '';
    draftImage = null;
    draftError = '';
    draftDip = null;
    hook?.setDraftOpen(false);
    draftWindow?.hide();
  }

  function interruptTodoDraft(): void {
    if (!draftDip && !draftImage && !draftText) return;
    discardTodoDraft();
  }

  function openTodoDraft(originX: number, originY: number): void {
    if (snipLive) cancelSnip();
    const dip = releaseToDip(originX, originY);
    if (!dip) {
      log('todo draft skipped: no display');
      return;
    }
    draftEpoch += 1;
    draftText = '';
    draftImage = null;
    draftError = '';
    draftDip = dip;
    showTodoDraft();
  }

  function beginTodoSnip(text: string): void {
    draftText = text;
    draftError = '';
    if (!overlay) {
      showTodoDraft();
      return;
    }
    hook?.setDraftOpen(false);
    draftWindow?.hide();
    beginRegionSnip('todo');
  }

  function cancelActiveSnip(): void {
    const purpose = snipLive ? snipPurpose : null;
    cancelSnip();
    if (purpose === 'todo') showTodoDraft();
  }

  async function attachTodoShot(rect: ScreenRect): Promise<void> {
    const epoch = draftEpoch;
    try {
      const shot = capturePhysicalRect(rect);
      const image = shrinkPngDataUrl(shot.dataUrl);
      if (epoch !== draftEpoch) return;
      draftImage = image;
      draftError = '';
    } catch (err) {
      if (epoch !== draftEpoch) return;
      log(`todo snip failed: ${err instanceof Error ? err.message : String(err)}`);
      draftError = '这块画面没有截下来';
    }
    showTodoDraft();
  }

  async function submitTodoDraft(text: string): Promise<void> {
    const epoch = draftEpoch;
    const image = draftImage;
    const trimmed = text.trim();
    if (!trimmed && !image) {
      discardTodoDraft();
      return;
    }
    hook?.setDraftOpen(false);
    draftWindow?.hide();
    let saved = false;
    let message = '没有记上，再试一次';
    try {
      const response = await fetch(`${serverBaseUrl}/api/todos`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(image ? { text, image } : { text }),
        signal: AbortSignal.timeout(20_000),
      });
      const payload = await response.json().catch(() => ({})) as { error?: unknown };
      if (response.ok) saved = true;
      else if (typeof payload.error === 'string' && payload.error.trim()) message = payload.error.trim();
    } catch (err) {
      log(`todo save failed: ${err instanceof Error ? err.message : String(err)}`);
    }
    if (epoch !== draftEpoch) return;
    if (!saved) {
      draftText = text;
      draftError = message;
      showTodoDraft();
      return;
    }
    draftText = '';
    draftImage = null;
    draftError = '';
    draftDip = null;
    log('todo saved');
  }

  function onEffect(effect: GestureEffect): void {
    if (effect.type === 'draft-cancel') {
      discardTodoDraft();
      return;
    }
    if (effect.type === 'snip-cancel') {
      cancelActiveSnip();
      return;
    }
    if (effect.type === 'snip-confirm') {
      finishRegionSnip();
      return;
    }
    if (effect.type === 'snip-pointer') {
      onSnipPointer(effect.phase, effect.x, effect.y);
      return;
    }
    const view = overlay;
    if (!view || !enabled) return;
    if (effect.type === 'open') {
      interruptTodoDraft();
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
    const action = wheelReleaseAction(slice);
    if (action === 'cancel' || slice == null) return;
    if (action === 'ask') {
      beginRegionSnip('ask');
      return;
    }
    if (action === 'snip') {
      beginRegionSnip('copy');
      return;
    }
    if (action === 'todo') {
      openTodoDraft(effect.originX, effect.originY);
      return;
    }
    view.showSignal(effect.originX, effect.originY, slice);
  }

  async function askRegion(rect: ScreenRect): Promise<void> {
    const view = overlay;
    if (!view) return;
    const gen = ++askGen;
    let shot: RegionShot;
    try {
      shot = capturePhysicalRect(rect);
    } catch (err) {
      log(`ask capture failed: ${err instanceof Error ? err.message : String(err)}`);
      if (!enabled || gen !== askGen) return;
      clearMarkerTimer();
      hook?.setMarkerOpen(true);
      view.showAsk(rect, 'error', '这块画面没有截下来');
      armMarkerTimer();
      return;
    }
    if (!enabled || gen !== askGen) return;
    clearMarkerTimer();
    hook?.setMarkerOpen(true);
    view.showAsk(rect, 'loading', '在看这块画面…');
    void askAt(view, gen, fitAskShot(shot));
  }

  /** 框选很大时 PNG 会撑爆提问接口。按比例缩小，画面内容还在。 */
  function fitAskShot(shot: RegionShot): RegionShot {
    if (shot.dataUrl.length <= ASK_IMAGE_MAX_CHARS) return shot;
    let image = nativeImage.createFromDataURL(shot.dataUrl);
    if (image.isEmpty()) return shot;
    let url = shot.dataUrl;
    for (let i = 0; i < 8 && url.length > ASK_IMAGE_MAX_CHARS; i++) {
      const size = image.getSize();
      const width = Math.max(1, Math.round(size.width * 0.75));
      const height = Math.max(1, Math.round(size.height * 0.75));
      if (width === size.width && height === size.height) break;
      image = image.resize({ width, height, quality: 'good' });
      url = `data:image/png;base64,${image.toPNG().toString('base64')}`;
    }
    const size = image.getSize();
    log(`ask image shrunk to ${size.width}x${size.height}`);
    return {
      dataUrl: url,
      width: size.width,
      height: size.height,
      anchorX: Math.round(size.width / 2),
      anchorY: Math.round(size.height / 2),
    };
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
    snipGen += 1;
    draftEpoch += 1;
    resetSnip();
    clearMarkerTimer();
    draftText = '';
    draftImage = null;
    draftError = '';
    draftDip = null;
    hook?.setDraftOpen(false);
    draftWindow?.destroy();
    draftWindow = null;
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
