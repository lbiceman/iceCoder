// @ts-nocheck
/**
 * 底部输入栏「推理强度」步骤器。
 * 档位来自当前默认模型配置的逗号列表；未配置时隐藏且不随消息发送。
 */

/* exported ChatReasoningStepper */

export const ChatReasoningStepper = (() => {

  let LEVELS = [];
  const DRAG_THRESHOLD_PX = 6;
  const STORAGE_KEY = 'ice-reasoning-effort';
  const TOKEN_RE = /^[a-z][\w.-]{0,31}$/i;
  let inited = false;
  let rootEl = null;

  function parseLevels(raw) {
    let text = '';
    if (Array.isArray(raw)) text = raw.join(',');
    else if (typeof raw === 'string') text = raw;
    else return [];
    const seen = {};
    const out = [];
    const parts = text.split(',');
    for (let i = 0; i < parts.length; i++) {
      const token = parts[i].trim().toLowerCase();
      if (!token || !TOKEN_RE.test(token) || seen[token]) continue;
      seen[token] = true;
      out.push(token);
    }
    return out;
  }

  function clampIndex(n) {
    n = n | 0;
    const max = Math.max(0, LEVELS.length - 1);
    if (n < 0) return 0;
    if (n > max) return max;
    return n;
  }

  function defaultIndex() {
    if (LEVELS.length <= 1) return 0;
    return Math.floor((LEVELS.length - 1) / 2);
  }

  function parseLevel(raw) {
    if (typeof raw !== 'string') return null;
    const token = raw.trim().toLowerCase();
    if (!LEVELS.length) return null;
    return LEVELS.includes(token) ? token : null;
  }

  function loadStoredLevel() {
    try {
      return parseLevel(localStorage.getItem(STORAGE_KEY));
    } catch (_err) {
      return null;
    }
  }

  function persist(level) {
    try { localStorage.setItem(STORAGE_KEY, level); } catch (_err) { /* ignore */ }
  }

  function renderLevels(root) {
    const track = root.querySelector('.reasoning-stepper-track');
    const label = root.querySelector('.reasoning-stepper-label');
    if (track) {
      let bars = '';
      for (let i = 0; i < LEVELS.length; i++) {
        bars += '<span class="reasoning-stepper-bar" style="height:' + (5 + i * 3) + 'px"></span>';
      }
      track.innerHTML = bars;
    }
    if (label) {
      let spans = '';
      for (let j = 0; j < LEVELS.length; j++) {
        spans += '<span data-level="' + LEVELS[j] + '">' + LEVELS[j] + '</span>';
      }
      label.innerHTML = spans;
    }
    root.setAttribute('aria-valuemin', '0');
    root.setAttribute('aria-valuemax', String(Math.max(0, LEVELS.length - 1)));
    root.style.setProperty('--count', String(LEVELS.length));
  }

  function apply(root, index) {
    if (!LEVELS.length) return;
    index = clampIndex(index);
    const level = LEVELS[index];
    root.style.setProperty('--step', String(index));
    root.dataset.level = level;
    root.setAttribute('aria-valuenow', String(index));
    root.setAttribute('aria-valuetext', level);
    root.setAttribute('title', `推理强度：${level}`);
    const bars = root.querySelectorAll('.reasoning-stepper-bar');
    for (let i = 0; i < bars.length; i++) {
      if (i <= index) bars[i].classList.add('is-on');
      else bars[i].classList.remove('is-on');
    }
    const labels = root.querySelectorAll('.reasoning-stepper-label > span');
    for (let j = 0; j < labels.length; j++) {
      if (labels[j].getAttribute('data-level') === level) labels[j].classList.add('is-current');
      else labels[j].classList.remove('is-current');
    }
    persist(level);
  }

  function currentIndex(root) {
    return clampIndex(parseInt(root.getAttribute('aria-valuenow'), 10));
  }

  function cycleNext(root) {
    if (!LEVELS.length) return;
    apply(root, (currentIndex(root) + 1) % LEVELS.length);
  }

  function indexFromClientX(track, clientX) {
    const n = LEVELS.length;
    if (n <= 0) return 0;
    const rect = track.getBoundingClientRect();
    let t = (clientX - rect.left) / Math.max(1, rect.width);
    if (t < 0) t = 0;
    if (t > 0.999) t = 0.999;
    return Math.floor(t * n);
  }

  function getLevel() {
    if (!LEVELS.length) return null;
    if (rootEl) return LEVELS[currentIndex(rootEl)];
    return loadStoredLevel() || LEVELS[defaultIndex()];
  }

  function setLevel(level) {
    const parsed = parseLevel(level);
    if (!parsed || !rootEl) return;
    apply(rootEl, LEVELS.indexOf(parsed));
  }

  function setEmpty(root) {
    root.classList.add('is-empty');
    root.setAttribute('hidden', '');
    root.removeAttribute('data-level');
    root.setAttribute('aria-valuetext', '');
    root.setAttribute('title', '推理强度未配置');
    const track = root.querySelector('.reasoning-stepper-track');
    const label = root.querySelector('.reasoning-stepper-label');
    if (track) track.innerHTML = '';
    if (label) label.innerHTML = '';
  }

  function setLevels(raw) {
    LEVELS = parseLevels(raw);
    if (!rootEl) return;
    if (!LEVELS.length) {
      setEmpty(rootEl);
      return;
    }
    rootEl.classList.remove('is-empty');
    rootEl.removeAttribute('hidden');
    renderLevels(rootEl);
    const stored = loadStoredLevel();
    apply(rootEl, stored ? LEVELS.indexOf(stored) : defaultIndex());
  }

  function init(root) {
    if (!root || inited) return;
    inited = true;
    rootEl = root;

    const track = root.querySelector('.reasoning-stepper-track');
    if (!track) return;

    setLevels(LEVELS);

    let pointerActive = false;
    let dragging = false;
    let startX = 0;
    let startY = 0;

    function setFromEvent(e) {
      if (!LEVELS.length) return;
      apply(root, indexFromClientX(track, e.clientX));
    }

    function focusRoot() {
      try { root.focus({ preventScroll: true }); } catch (_err) { root.focus(); }
    }

    root.addEventListener('pointerdown', (e) => {
      if (!LEVELS.length) return;
      if (e.button != null && e.button !== 0) return;
      pointerActive = true;
      dragging = false;
      startX = e.clientX;
      startY = e.clientY;
      focusRoot();
      if (typeof root.setPointerCapture === 'function' && e.pointerId != null) {
        try { root.setPointerCapture(e.pointerId); } catch (_err) { /* ignore */ }
      }
      e.preventDefault();
    });

    root.addEventListener('pointermove', (e) => {
      if (!pointerActive || !LEVELS.length) return;
      const dx = e.clientX - startX;
      const dy = e.clientY - startY;
      if (!dragging && (dx * dx + dy * dy) >= DRAG_THRESHOLD_PX * DRAG_THRESHOLD_PX) {
        dragging = true;
        root.classList.add('is-dragging');
      }
      if (dragging) setFromEvent(e);
    });

    function endPointer(e, cancelled) {
      if (!pointerActive) return;
      pointerActive = false;
      root.classList.remove('is-dragging');
      if (e && typeof root.releasePointerCapture === 'function' && e.pointerId != null) {
        try { root.releasePointerCapture(e.pointerId); } catch (_err) { /* ignore */ }
      }
      if (!cancelled && !dragging && LEVELS.length) cycleNext(root);
      dragging = false;
    }

    root.addEventListener('pointerup', (e) => { endPointer(e, false); });
    root.addEventListener('pointercancel', (e) => { endPointer(e, true); });
    root.addEventListener('lostpointercapture', () => {
      if (!pointerActive) return;
      pointerActive = false;
      dragging = false;
      root.classList.remove('is-dragging');
    });

    root.addEventListener('keydown', (e) => {
      if (!LEVELS.length) return;
      if (e.key === ' ' || e.key === 'Enter') {
        e.preventDefault();
        cycleNext(root);
        return;
      }
      const cur = currentIndex(root);
      let next = cur;
      if (e.key === 'ArrowRight' || e.key === 'ArrowUp') next = cur + 1;
      else if (e.key === 'ArrowLeft' || e.key === 'ArrowDown') next = cur - 1;
      else if (e.key === 'Home') next = 0;
      else if (e.key === 'End') next = LEVELS.length - 1;
      else return;
      e.preventDefault();
      apply(root, next);
    });
  }

  return { init, getLevel, setLevel, setLevels };
})();

if (typeof window !== 'undefined') {
  window.ChatReasoningStepper = ChatReasoningStepper;
}
