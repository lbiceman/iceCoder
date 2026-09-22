// @ts-nocheck
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
      title: '手机扫码远程控制',
      description: '请确保手机和电脑在同一局域网内；扫码后将打开手机端 H5 界面',
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
        notify('链接已复制', 'success');
      }).catch(() => {
        notify('复制失败', 'error');
      });
    });
  }

  function renderQrBody(data) {
    const displayUrl = buildMobileRemoteUrl(data);
    const media = data.qrDataUrl
      ? `<div class="modal-panel-media"><img src="${escapeHtml(data.qrDataUrl)}" alt="QR Code" width="220" height="220"></div>`
      : '<p class="modal-panel-error">二维码生成失败，请手动访问下方地址</p>';
    const info = data.tunnel
      ? '通过公网隧道访问（任意网络可用）'
      : ('局域网 IP: ' + (data.localIP || '') + ' | 端口: ' + (data.port || ''));
    const urlRow = displayUrl
      ? (
        `<div class="modal-panel-code-row"><div class="modal-panel-code">${escapeHtml(displayUrl)}</div><button type="button" class="btn-icon btn-icon-ghost modal-panel-copy" aria-label="复制链接" title="复制链接" data-copy-text="${escapeHtml(displayUrl)}">${copyIconHtml()}</button></div>`
      )
      : '';
    return (
      `<div class="modal-panel-card">${media}${urlRow}<p class="modal-panel-note">${escapeHtml(info)}</p><p class="modal-panel-note is-success">链接长期有效，直到下次重新生成</p></div>`
    );
  }

  function fillQrPanel(panel, data) {
    if (!panel) return;
    panel.setBody(renderQrBody(data));
    bindCopyButton(panel, buildMobileRemoteUrl(data));
  }

  function showQrCode() {
    const panel = openPanel('<p class="modal-panel-muted">正在生成二维码…</p>');
    if (!panel) return;

    fetch('/api/remote/session', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({}),
    })
      .then((res) =>  res.json())
      .then((data) => {
        if (!data.success) {
          panel.setBody(`<p class="modal-panel-error">生成二维码失败: ${escapeHtml(data.error || '未知错误')}</p>`);
          return;
        }
        fillQrPanel(panel, data);
      })
      .catch(() => {
        panel.setBody('<p class="modal-panel-error">生成二维码失败，请检查网络连接</p>');
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
