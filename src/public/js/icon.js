/**
 * 图标工具：从 /icons/*.svg 异步加载并内联到 DOM，保留 currentColor 主题色。
 */

const ICON_BASE = '/icons/';
const loadCache = new Map();

export async function loadIcon(name) {
  if (loadCache.has(name)) {
    const cached = loadCache.get(name);
    return cached instanceof Promise ? cached : Promise.resolve(cached);
  }
  const pending = fetch(`${ICON_BASE}${name}.svg`)
    .then(async (res) => {
      if (!res.ok) throw new Error(`icon ${name}: HTTP ${res.status}`);
      const text = (await res.text()).trim();
      loadCache.set(name, text);
      return text;
    })
    .catch((err) => {
      loadCache.delete(name);
      throw err;
    });
  loadCache.set(name, pending);
  return pending;
}

export function iconHtml(name, opts) {
  const options = opts || {};
  const w = options.width != null ? options.width : 16;
  const h = options.height != null ? options.height : w;
  const parts = ['app-icon'];
  if (options.className) parts.push(options.className);
  const cls = parts.join(' ');
  return (
    '<span class="' + cls + '" data-app-icon="' + escapeAttr(name) + '" data-icon-w="' + w + '" data-icon-h="' + h + '" style="width:' + w + 'px;height:' + h + 'px" aria-hidden="true"></span>'
  );
}

function escapeAttr(value) {
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/"/g, '&quot;');
}

export async function hydrateIcons(root) {
  const scope = root || document;
  const hosts = scope.querySelectorAll('[data-app-icon]:not([data-icon-hydrated])');
  if (!hosts.length) return;

  await Promise.all(Array.from(hosts).map(async (host) => {
    const name = host.getAttribute('data-app-icon');
    if (!name) return;
    const w = host.getAttribute('data-icon-w') || '16';
    const h = host.getAttribute('data-icon-h') || w;
    try {
      const svgText = await loadIcon(name);
      const wrap = document.createElement('div');
      wrap.innerHTML = svgText;
      const svg = wrap.querySelector('svg');
      if (!svg) return;
      svg.setAttribute('width', w);
      svg.setAttribute('height', h);
      if (host.className) svg.setAttribute('class', host.className);
      svg.setAttribute('aria-hidden', 'true');
      host.setAttribute('data-icon-hydrated', '1');
      host.replaceWith(svg);
    } catch (_err) {
      /* 保留占位，避免阻断页面 */
    }
  }));
}

export function preloadIcons(names) {
  return Promise.all((names || []).map((name) => loadIcon(name)));
}

if (typeof window !== 'undefined') {
  window.AppIcon = {
    html: iconHtml,
    hydrate: hydrateIcons,
    preload: preloadIcons,
    load: loadIcon,
  };
}
