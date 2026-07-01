/**
 * 二维码远程控制模块
 * 负责：生成远程控制二维码、弹窗展示
 */

/* exported ChatQR */

window.ChatQR = (function () {
  'use strict';

  function escapeHtml(str) {
    var div = document.createElement('div');
    div.appendChild(document.createTextNode(str));
    return div.innerHTML;
  }

  function showQrCode(_messages, _appendFn, _saveFn) {
    var overlay = createQrOverlayShell();
    setQrModalLoading(overlay);
    document.body.appendChild(overlay);

    var chatSessionId = '';
    if (window.ChatSessionStore && typeof window.ChatSessionStore.getActiveSessionId === 'function') {
      chatSessionId = window.ChatSessionStore.getActiveSessionId() || '';
    } else if (window.ChatSession && typeof window.ChatSession.getActiveId === 'function') {
      chatSessionId = window.ChatSession.getActiveId() || '';
    }

    fetch('/api/remote/session', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chatSessionId: chatSessionId || 'default' }),
    })
      .then(function (res) { return res.json(); })
      .then(function (data) {
        if (!data.success) {
          setQrModalError(overlay, '生成二维码失败: ' + (data.error || '未知错误'));
          return;
        }
        populateQrModal(overlay, data);
      })
      .catch(function () {
        setQrModalError(overlay, '生成二维码失败，请检查网络连接');
      });
  }

  function buildMobileRemoteUrl(data) {
    if (data.url && String(data.url).indexOf('/m/chat') >= 0) {
      return data.url;
    }
    if (!data.token) return data.url || '';
    var base = '';
    if (data.url) {
      try {
        var u = new URL(data.url);
        base = u.origin;
      } catch (_e) {
        base = String(data.url).split('?')[0].replace(/\/?$/, '');
      }
    }
    if (!base && data.localIP && data.port) {
      base = 'http://' + data.localIP + ':' + data.port;
    }
    if (!base) return data.url || '';
    var params = 'token=' + encodeURIComponent(data.token);
    if (data.chatSessionId) {
      params += '&sid=' + encodeURIComponent(data.chatSessionId);
    }
    return base + '/m/chat?' + params;
  }

  function createQrOverlayShell() {
    var overlay = document.createElement('div');
    overlay.className = 'qr-overlay';
    overlay.setAttribute('id', 'qr-overlay');

    var modal = document.createElement('div');
    modal.className = 'qr-modal';

    var title = document.createElement('h3');
    title.textContent = '手机扫码远程控制';
    modal.appendChild(title);

    var desc = document.createElement('p');
    desc.className = 'qr-desc';
    desc.textContent = '请确保手机和电脑在同一局域网内；扫码后将打开手机端 H5 界面';
    modal.appendChild(desc);

    var qrContainer = document.createElement('div');
    qrContainer.className = 'qr-canvas-container';
    modal.appendChild(qrContainer);

    var urlText = document.createElement('p');
    urlText.className = 'qr-url';
    urlText.hidden = true;
    modal.appendChild(urlText);

    var info = document.createElement('p');
    info.className = 'qr-info';
    info.hidden = true;
    modal.appendChild(info);

    var hint = document.createElement('p');
    hint.className = 'qr-timer';
    hint.textContent = '链接长期有效，直到下次重新生成';
    hint.hidden = true;
    modal.appendChild(hint);

    var closeBtn = document.createElement('button');
    closeBtn.className = 'qr-close-btn';
    closeBtn.textContent = '关闭';
    closeBtn.addEventListener('click', function () {
      if (overlay.parentNode) overlay.parentNode.removeChild(overlay);
    });
    modal.appendChild(closeBtn);

    overlay.appendChild(modal);
    overlay.addEventListener('click', function (e) {
      if (e.target === overlay && overlay.parentNode) {
        overlay.parentNode.removeChild(overlay);
      }
    });

    return overlay;
  }

  function setQrModalLoading(overlay) {
    var qrContainer = overlay.querySelector('.qr-canvas-container');
    if (!qrContainer) return;
    qrContainer.innerHTML = '<p class="qr-loading">正在生成远程控制二维码…</p>';
  }

  function setQrModalError(overlay, message) {
    var qrContainer = overlay.querySelector('.qr-canvas-container');
    if (qrContainer) {
      qrContainer.innerHTML = '<p class="qr-error">' + escapeHtml(message) + '</p>';
    }
    var hint = overlay.querySelector('.qr-timer');
    if (hint) hint.hidden = true;
  }

  function populateQrModal(overlay, data) {
    var displayUrl = buildMobileRemoteUrl(data);
    var qrContainer = overlay.querySelector('.qr-canvas-container');
    if (qrContainer) {
      qrContainer.innerHTML = '';
      if (data.qrDataUrl) {
        var img = document.createElement('img');
        img.src = data.qrDataUrl;
        img.alt = 'QR Code';
        img.style.width = '220px';
        img.style.height = '220px';
        img.style.borderRadius = '8px';
        qrContainer.appendChild(img);
      } else {
        qrContainer.innerHTML = '<p style="word-break:break-all;font-size:12px;color:#a0a0a0;">二维码生成失败，请手动访问:<br>' + escapeHtml(displayUrl) + '</p>';
      }
    }

    var urlText = overlay.querySelector('.qr-url');
    if (urlText) {
      urlText.textContent = displayUrl;
      urlText.hidden = false;
    }

    var info = overlay.querySelector('.qr-info');
    if (info) {
      info.textContent = data.tunnel
        ? '通过公网隧道访问（任意网络可用）'
        : '局域网 IP: ' + data.localIP + ' | 端口: ' + data.port;
      info.hidden = false;
    }

    var hint = overlay.querySelector('.qr-timer');
    if (hint) hint.hidden = false;
  }

  function showQrModal(url, qrDataUrl, localIP, port, tunnel, token) {
    var overlay = createQrOverlayShell();
    populateQrModal(overlay, { url: url, qrDataUrl: qrDataUrl, localIP: localIP, port: port, tunnel: tunnel, token: token });
    document.body.appendChild(overlay);
  }

  return {
    showQrCode: showQrCode,
    showQrModal: showQrModal,
  };
})();
