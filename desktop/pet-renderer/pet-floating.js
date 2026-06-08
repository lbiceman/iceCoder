/**
 * pet-floating.js — 桌面悬浮冰豆渲染层
 *
 * 状态来源：主窗冰豆通过 IPC 推 snapshot（pet:state-snapshot）。
 * 自身职责：渲染最近一次快照；双击请求恢复主窗。
 * 注意：复用 session-pet.js 会涉及复杂依赖，故这里实现一个**极简**的圆点
 * 替身（黑底白点），保持外观一致；完整 canvas 渲染在 V2 接入 session-pet ESM。
 */

const canvas = document.getElementById('pet-canvas');
const ctx = canvas.getContext('2d');
const fallback = document.getElementById('pet-fallback');

let lastState = null;
let visible = true;
let pulse = 0;

function draw() {
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  if (!visible) return;
  // 黑底圆（与主窗内嵌冰豆视觉一致）
  ctx.beginPath();
  ctx.arc(48, 48, 38, 0, Math.PI * 2);
  ctx.fillStyle = '#000';
  ctx.fill();
  // 白色双眼
  ctx.fillStyle = '#fff';
  ctx.beginPath();
  ctx.ellipse(38, 48, 3, 6, 0, 0, Math.PI * 2);
  ctx.fill();
  ctx.beginPath();
  ctx.ellipse(58, 48, 3, 6, 0, 0, Math.PI * 2);
  ctx.fill();
  // 状态指示点（根据 state.state 染色）
  const stateName = lastState?.state || 'idle';
  const colors = {
    idle: '#1ECFB4',
    thinking: '#DBF02C',
    read: '#7DA0FF',
    happy: '#FF8FA3',
    alert: '#FC5A76',
    dizzy: '#9D7BFF',
    determined: '#FFA94D',
    focused: '#1ECFB4',
  };
  ctx.beginPath();
  ctx.arc(48, 70 + Math.sin(pulse) * 1.5, 3, 0, Math.PI * 2);
  ctx.fillStyle = colors[stateName] || colors.idle;
  ctx.fill();
}

function tick() {
  pulse += 0.08;
  draw();
  requestAnimationFrame(tick);
}
tick();

// IPC：主进程 → renderer
const api = window.iceDesktop;
if (api) {
  api.onPetMode((mode) => {
    // 主进程告知当前模式：floating/embedded/hidden
    if (mode === 'floating') {
      visible = true;
      fallback.hidden = true;
    } else if (mode === 'hidden') {
      visible = false;
    }
  });
  // 监听 snapshot（通过 custom event，因为 preload 未直接暴露）
  // main 端会广播 pet:state-snapshot
  window.electron?.ipcRenderer?.on?.('pet:state-snapshot', (_e, snap) => {
    lastState = snap || null;
  });
  // 兜底：通过自定义事件
  window.addEventListener('pet:state-snapshot', (ev) => {
    lastState = ev.detail || null;
  });
}

// 双击 → 请求显示主窗
canvas.addEventListener('dblclick', () => {
  if (api && typeof api.petRequestShowMain === 'function') {
    api.petRequestShowMain();
  }
});

// 拖动用 -webkit-app-region: drag；这里不需额外代码
canvas.addEventListener('contextmenu', (e) => e.preventDefault());
