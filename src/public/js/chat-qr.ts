// @ts-nocheck
import { t } from './i18n.ts';
/**
 * 二维码远程控制：复用 Modal.panel。
 */

/* exported ChatQR */

export const ChatQR = (() => {

  function escapeHtml(str) {
    const div = document.createElement('div');
    div.appendChild(document.createTextNode(str));
    return div.innerHTML;
  }

  function openPanel(bodyHtml) {
    if (!window.Modal || typeof window.Modal.panel !== 'function') return null;
    return window.Modal.panel({
      title: t('qr.title'),
      description: t('qr.desc'),
      bodyHtml,
    });
  }

  function buildMobileRemoteUrl(data) {
    if (data.url && String(data.url).includes('/m/chat')) {
      return data.url;
    }
    if (!data.token) return data.url || '';
    let base = '';
    if (data.url) {
      try {
        const u = new URL(data.url);
        base = u.origin;
      } catch (_e) {
        base = String(data.url).split('?')[0].replace(/\/?$/, '');
      }
    }
    if (!base && data.localIP && data.port) {
      base = `http://${data.localIP}:${data.port}`;
    }
    if (!base) return data.url || '';
    const params = `token=${encodeURIComponent(data.token)}`;
    return `${base}/m/chat?${params}`;
  }

  function copyIconHtml() {
    if (window.AppIcon && typeof window.AppIcon.html === 'function') {
      return window.AppIcon.html('copy', { width: 14 });
    }
    return '';
  }

  function notify(message, type) {
    if (window.Notification && typeof window.Notification.show === 'function') {
      window.Notification.show(message, type || 'info');
    }
  }

  function copyTextFallback(text) {
    return new Promise((resolve, reject) => {
      const ta = document.createElement('textarea');
      ta.value = text;
      ta.setAttribute('readonly', '');
      ta.style.position = 'fixed';
      ta.style.left = '-9999px';
      document.body.appendChild(ta);
      ta.select();
      try {
        if (!document.execCommand('copy')) {
          reject(new Error('copy failed'));
          return;
        }
        resolve();
      } catch (err) {
        reject(err);
      } finally {
        if (ta.parentNode) ta.parentNode.removeChild(ta);
      }
    });
  }

  function copyText(text) {
    if (!text) return Promise.reject(new Error('empty'));
    return copyTextFallback(text).catch(() => {
      if (navigator.clipboard && typeof navigator.clipboard.writeText === 'function') {
        return navigator.clipboard.writeText(text);
      }
      return Promise.reject(new Error('copy failed'));
    });
  }

  function bindCopyButton(panel, url) {
    if (!panel || !panel.body) return;
    if (window.AppIcon && typeof window.AppIcon.hydrate === 'function') {
      window.AppIcon.hydrate(panel.body);
    }
    const btn = panel.body.querySelector('.modal-panel-copy');
    if (btn && url) btn.setAttribute('data-copy-text', url);
    if (panel.body.getAttribute('data-copy-bound') === '1') return;
    panel.body.setAttribute('data-copy-bound', '1');
    panel.body.addEventListener('click', (e) => {
      const copyBtn = e.target.closest ? e.target.closest('.modal-panel-copy') : null;
      if (!copyBtn) return;
      const text = copyBtn.getAttribute('data-copy-text') || url || '';
      copyText(text).then(() => {
        notify(t('qr.copied'), 'success');
      }).catch(() => {
        notify(t('qr.copyFailed'), 'error');
      });
    });
  }

  function renderQrBody(data) {
    const displayUrl = buildMobileRemoteUrl(data);
    const media = data.qrDataUrl
      ? `<div class="modal-panel-media"><img src="${escapeHtml(data.qrDataUrl)}" alt="QR Code" width="220" height="220"></div>`
      : `<p class="modal-panel-error">${escapeHtml(t('qr.imageFailed'))}</p>`;
    const info = data.tunnel
      ? t('qr.tunnel')
      : t('qr.lan', { ip: data.localIP || '', port: data.port || '' });
    const urlRow = displayUrl
      ? (
        `<div class="modal-panel-code-row"><div class="modal-panel-code">${escapeHtml(displayUrl)}</div><button type="button" class="btn-icon btn-icon-ghost modal-panel-copy" aria-label="${escapeHtml(t('qr.copy'))}" title="${escapeHtml(t('qr.copy'))}" data-copy-text="${escapeHtml(displayUrl)}">${copyIconHtml()}</button></div>`
      )
      : '';
    return (
      `<div class="modal-panel-card">${media}${urlRow}<p class="modal-panel-note">${escapeHtml(info)}</p><p class="modal-panel-note is-success">${escapeHtml(t('qr.longLived'))}</p></div>`
    );
  }

  function fillQrPanel(panel, data) {
    if (!panel) return;
    panel.setBody(renderQrBody(data));
    bindCopyButton(panel, buildMobileRemoteUrl(data));
  }

  function showQrCode() {
    const panel = openPanel(`<p class="modal-panel-muted">${escapeHtml(t('qr.generating'))}</p>`);
    if (!panel) return;

    fetch('/api/remote/session', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({}),
    })
      .then((res) =>  res.json())
      .then((data) => {
        if (!data.success) {
          panel.setBody(`<p class="modal-panel-error">${escapeHtml(t('qr.generateFailed', { message: data.error || t('common.unknownError') }))}</p>`);
          return;
        }
        fillQrPanel(panel, data);
      })
      .catch(() => {
        panel.setBody(`<p class="modal-panel-error">${escapeHtml(t('qr.network'))}</p>`);
      });
  }

  function showQrModal(url, qrDataUrl, localIP, port, tunnel, token) {
    const panel = openPanel('');
    fillQrPanel(panel, {
      url,
      qrDataUrl,
      localIP,
      port,
      tunnel,
      token,
    });
  }

  function closeQrCode() {
    if (window.Modal && typeof window.Modal.closePanel === 'function') {
      window.Modal.closePanel();
    }
  }

  return {
    showQrCode,
    showQrModal,
    closeQrCode,
  };
})();

if (typeof window !== 'undefined') {
  window.ChatQR = ChatQR;
}
