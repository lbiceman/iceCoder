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

  function pushAgentMessage(messages, appendFn, content) {
    var msg = { role: 'agent', content: content };
    if (window.ChatSession && typeof window.ChatSession.stampMessageTimestamps === 'function') {
      window.ChatSession.stampMessageTimestamps(msg);
    }
    messages.push(msg);
    appendFn(msg);
    return msg;
  }

  function showQrCode(messages, appendFn, saveFn) {
    pushAgentMessage(messages, appendFn, '正在生成远程控制二维码…');
    saveFn();

    fetch('/api/remote/session', { method: 'POST' })
      .then(function (res) { return res.json(); })
      .then(function (data) {
        if (!data.success) {
          pushAgentMessage(messages, appendFn, '生成二维码失败: ' + (data.error || '未知错误'));
          saveFn();
          return;
        }

        messages.pop();
        appendFn(messages[messages.length - 1]);
        saveFn();

        showQrModal(data.url, data.qrDataUrl, data.localIP, data.port, data.tunnel, data.token);
      })
      .catch(function () {
        pushAgentMessage(messages, appendFn, '生成二维码失败，请检查网络连接');
        saveFn();
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
    return base + '/m/chat?token=' + encodeURIComponent(data.token);
  }

  function showQrModal(url, qrDataUrl, localIP, port, tunnel, token) {
    var displayUrl = buildMobileRemoteUrl({ url: url, token: token, localIP: localIP, port: port });
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
    if (qrDataUrl) {
      var img = document.createElement('img');
      img.src = qrDataUrl;
      img.alt = 'QR Code';
      img.style.width = '220px';
      img.style.height = '220px';
      img.style.borderRadius = '8px';
      qrContainer.appendChild(img);
    } else {
      qrContainer.innerHTML = '<p style="word-break:break-all;font-size:12px;color:#a0a0a0;">二维码生成失败，请手动访问:<br>' + escapeHtml(displayUrl) + '</p>';
    }
    modal.appendChild(qrContainer);

    var urlText = document.createElement('p');
    urlText.className = 'qr-url';
    urlText.textContent = displayUrl;
    modal.appendChild(urlText);

    var info = document.createElement('p');
    info.className = 'qr-info';
    info.textContent = tunnel ? '通过公网隧道访问（任意网络可用）' : '局域网 IP: ' + localIP + ' | 端口: ' + port;
    modal.appendChild(info);

    var hint = document.createElement('p');
    hint.className = 'qr-timer';
    hint.textContent = '链接长期有效，直到下次重新生成';
    modal.appendChild(hint);

    var closeBtn = document.createElement('button');
    closeBtn.className = 'qr-close-btn';
    closeBtn.textContent = '关闭';
    closeBtn.addEventListener('click', function () {
      document.body.removeChild(overlay);
    });
    modal.appendChild(closeBtn);

    overlay.appendChild(modal);
    overlay.addEventListener('click', function (e) {
      if (e.target === overlay) {
        document.body.removeChild(overlay);
      }
    });

    document.body.appendChild(overlay);
  }

  return {
    showQrCode: showQrCode,
    showQrModal: showQrModal,
  };
})();
