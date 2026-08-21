/**
 * 文件上传与图片处理模块
 * 负责：文件上传、图片粘贴/拖拽、预览、待发送管理
 */

/* exported ChatFile */

window.ChatFile = (function () {
  'use strict';

  var uploadedFiles = [];
  var pendingImages = [];
  var pendingImageLoads = 0;

  var elFileStatus = null;
  var elFileInput = null;
  var onComposerChange = null;

  function init(els) {
    els = els || {};
    elFileStatus = els.elFileStatus;
    elFileInput = els.elFileInput;
    onComposerChange = typeof els.onComposerChange === 'function' ? els.onComposerChange : null;
  }

  function notifyComposerChange() {
    if (typeof onComposerChange === 'function') onComposerChange();
  }

  function handleFileSelect(file, messages, appendFn, saveFn) {
    if (!file) return;

    var entry = {
      localId: String(Date.now()) + '-' + Math.random().toString(36).slice(2),
      filename: file.name,
      status: 'uploading',
    };
    uploadedFiles.push(entry);
    renderUploadedFiles();

    var formData = new FormData();
    formData.append('file', file);

    fetch('/api/chat/upload', {
      method: 'POST',
      body: formData
    })
      .then(function (res) { return res.json(); })
      .then(function (data) {
        if (data.error) {
          entry.status = 'failed';
          var uploadErrMsg = { role: 'agent', content: 'Upload failed: ' + data.error };
          if (window.ChatSession && typeof window.ChatSession.stampMessageTimestamps === 'function') {
            window.ChatSession.stampMessageTimestamps(uploadErrMsg);
          }
          messages.push(uploadErrMsg);
          appendFn(uploadErrMsg);
          saveFn();
        } else {
          entry.fileId = data.fileId;
          entry.filename = data.filename;
          entry.size = data.size;
          entry.status = 'ready';
        }
        renderUploadedFiles();
      })
      .catch(function () {
        entry.status = 'failed';
        renderUploadedFiles();
      });
  }

  function removeUploadedFile(index) {
    if (index < 0 || index >= uploadedFiles.length) return;
    uploadedFiles.splice(index, 1);
    renderUploadedFiles();
  }

  function clearUploadedFiles() {
    uploadedFiles = [];
    renderUploadedFiles();
    if (elFileInput) elFileInput.value = '';
  }

  function getUploadedFiles() {
    var ready = [];
    for (var i = 0; i < uploadedFiles.length; i++) {
      if (uploadedFiles[i].status === 'ready' && uploadedFiles[i].fileId) {
        ready.push(uploadedFiles[i]);
      }
    }
    return ready;
  }

  function hasPendingUploads() {
    for (var i = 0; i < uploadedFiles.length; i++) {
      if (uploadedFiles[i].status === 'uploading') return true;
    }
    return false;
  }

  function renderUploadedFiles() {
    if (!elFileStatus) return;

    if (uploadedFiles.length === 0) {
      elFileStatus.classList.add('hidden');
      elFileStatus.innerHTML = '';
      return;
    }

    elFileStatus.classList.remove('hidden');
    elFileStatus.innerHTML = '';

    for (var i = 0; i < uploadedFiles.length; i++) {
      (function (idx) {
        var file = uploadedFiles[idx];
        var item = document.createElement('div');
        item.className = 'pending-file-item';

        var nameEl = document.createElement('span');
        nameEl.className = 'pending-file-name';
        if (file.status === 'uploading') {
          nameEl.textContent = file.filename + ' (uploading…)';
        } else if (file.status === 'failed') {
          nameEl.textContent = file.filename + ' (failed)';
          nameEl.classList.add('pending-file-failed');
        } else {
          nameEl.textContent = file.filename + ' (' + formatSize(file.size) + ')';
        }
        item.appendChild(nameEl);

        var removeBtn = document.createElement('button');
        removeBtn.className = 'pending-file-remove';
        removeBtn.textContent = '×';
        removeBtn.title = '移除文件';
        removeBtn.type = 'button';
        removeBtn.addEventListener('click', function (e) {
          e.preventDefault();
          e.stopPropagation();
          removeUploadedFile(idx);
        });
        item.appendChild(removeBtn);

        elFileStatus.appendChild(item);
      })(i);
    }
  }

  function addPendingImage(file) {
    pendingImageLoads++;
    notifyComposerChange();
    var reader = new FileReader();
    reader.onload = function (e) {
      pendingImageLoads = Math.max(0, pendingImageLoads - 1);
        pendingImages.push({ dataUrl: e.target.result, file: file });
      renderPendingImages();
      notifyComposerChange();
    };
    reader.onerror = function () {
      pendingImageLoads = Math.max(0, pendingImageLoads - 1);
      notifyComposerChange();
    };
    reader.readAsDataURL(file);
  }

  function removePendingImage(index) {
    pendingImages.splice(index, 1);
    renderPendingImages();
    notifyComposerChange();
  }

  function clearPendingImages() {
    pendingImages = [];
    renderPendingImages();
    notifyComposerChange();
  }

  function getPendingImages() {
    return pendingImages;
  }

  function renderPendingImages() {
    var previewArea = document.getElementById('pending-images-preview');
    if (!previewArea) return;

    if (pendingImages.length === 0) {
      previewArea.classList.add('hidden');
      previewArea.innerHTML = '';
      return;
    }

    previewArea.classList.remove('hidden');
    previewArea.innerHTML = '';

    for (var i = 0; i < pendingImages.length; i++) {
      (function (idx) {
        var wrapper = document.createElement('div');
        wrapper.className = 'pending-image-item';

        var img = document.createElement('img');
        img.src = pendingImages[idx].dataUrl;
        img.className = 'pending-image-thumb';
        img.alt = '待发送图片';
        wrapper.appendChild(img);

        var removeBtn = document.createElement('button');
        removeBtn.className = 'pending-image-remove';
        removeBtn.textContent = '×';
        removeBtn.title = '移除图片';
        removeBtn.addEventListener('click', function (e) {
          e.preventDefault();
          e.stopPropagation();
          removePendingImage(idx);
        });
        wrapper.appendChild(removeBtn);

        previewArea.appendChild(wrapper);
      })(i);
    }
  }

  function hasPendingImageLoads() {
    return pendingImageLoads > 0;
  }

  function waitForPendingImageLoads(done, timeoutMs) {
    if (typeof done !== 'function') return;
    if (pendingImageLoads <= 0) {
      done();
      return;
    }
    var limit = typeof timeoutMs === 'number' ? timeoutMs : 3000;
    var started = Date.now();
    var timer = setInterval(function () {
      if (pendingImageLoads <= 0 || Date.now() - started >= limit) {
        clearInterval(timer);
        done();
      }
    }, 32);
  }

  function formatSize(bytes) {
    if (bytes < 1024) return bytes + ' B';
    if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + ' KB';
    return (bytes / (1024 * 1024)).toFixed(1) + ' MB';
  }

  function isImageFile(file) {
    if (!file) return false;
    if (file.type && file.type.indexOf('image/') === 0) return true;
    return /\.(png|jpe?g|gif|webp|bmp|svg)$/i.test(file.name || '');
  }

  function addUniqueImageFile(out, seen, file) {
    if (!file || !isImageFile(file)) return;
    var size = file.size || 0;
    var type = file.type || '';
    var key = type + ':' + size;
    if (size > 0 && seen[key]) return;
    if (size > 0) seen[key] = true;
    else {
      var nameKey = String(file.name || '') + ':' + String(file.lastModified || 0) + ':' + type;
      if (seen[nameKey]) return;
      seen[nameKey] = true;
    }
    out.push(file);
  }

  /** 从 paste/drop 的 clipboardData / dataTransfer 收集图片文件。 */
  function collectClipboardImageFiles(clipboardData) {
    var out = [];
    var seen = Object.create(null);
    if (!clipboardData) return out;

    var files = clipboardData.files;
    if (files && files.length) {
      for (var i = 0; i < files.length; i++) addUniqueImageFile(out, seen, files[i]);
    }

    // Electron 常同时提供 files 与 items，指向同一张图但 lastModified 不同。
    // 已经从 files 拿到图就不要再扫 items，否则会预览成两张。
    var items = clipboardData.items;
    if (out.length === 0 && items && items.length) {
      for (var j = 0; j < items.length; j++) {
        var item = items[j];
        if (!item) continue;
        var isImageItem = (item.kind === 'file' || !item.kind)
          && item.type
          && item.type.indexOf('image/') === 0;
        if (!isImageItem || typeof item.getAsFile !== 'function') continue;
        addUniqueImageFile(out, seen, item.getAsFile());
      }
    }

    if (out.length === 0 && typeof clipboardData.getData === 'function') {
      var html = '';
      try { html = clipboardData.getData('text/html') || ''; } catch (_e) { html = ''; }
      var dataUrlMatch = html && html.match(/src=["'](data:image\/[a-zA-Z0-9.+-]+;base64,[^"']+)["']/i);
      if (dataUrlMatch) {
        try {
          var dataUrl = dataUrlMatch[1];
          var mimeMatch = /^data:(image\/[a-zA-Z0-9.+-]+);base64,/i.exec(dataUrl);
          var mime = mimeMatch ? mimeMatch[1] : 'image/png';
          var b64 = dataUrl.slice(dataUrl.indexOf(',') + 1);
          var binary = atob(b64);
          var bytes = new Uint8Array(binary.length);
          for (var b = 0; b < binary.length; b++) bytes[b] = binary.charCodeAt(b);
          var blob = new Blob([bytes], { type: mime });
          var ext = (mime.split('/')[1] || 'png').replace('+xml', '');
          addUniqueImageFile(out, seen, new File([blob], 'clipboard.' + ext, { type: mime }));
        } catch (_err) { /* ignore malformed html clipboard */ }
      }
    }

    return out;
  }

  /**
   * 处理 textarea paste。若已从事件里拿到图片则 preventDefault 并加入待发送。
   * @returns {boolean} 是否已消费该 paste
   */
  function handlePasteEvent(e) {
    var files = collectClipboardImageFiles(e && e.clipboardData);
    if (!files.length) return false;
    e.preventDefault();
    for (var i = 0; i < files.length; i++) addPendingImage(files[i]);
    return true;
  }

  function fileFromDesktopClipboardPayload(payload) {
    if (!payload || !payload.base64) return null;
    try {
      var binary = atob(payload.base64);
      var bytes = new Uint8Array(binary.length);
      for (var i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
      var mime = payload.mime || 'image/png';
      var ext = (mime.split('/')[1] || 'png').replace('+xml', '');
      return new File([new Blob([bytes], { type: mime })], 'clipboard.' + ext, { type: mime });
    } catch (_e) {
      return null;
    }
  }

  function looksLikeImagePath(text) {
    return /\.(png|jpe?g|gif|webp|bmp|svg)$/i.test(String(text || '').trim().replace(/^['"]|['"]$/g, ''));
  }

  /**
   * Electron 打包端：clipboardData 经常没有 image item，回退读系统剪贴板位图。
   * 有普通文本时不抢粘贴；文本像图片路径（微信截图）时仍取位图。
   */
  function tryPasteFromDesktopClipboard(clipboardData) {
    var api = window.iceDesktop;
    if (!api || typeof api.readClipboardImage !== 'function') return false;
    var text = '';
    try {
      text = clipboardData && typeof clipboardData.getData === 'function'
        ? (clipboardData.getData('text/plain') || '')
        : '';
    } catch (_e) {
      text = '';
    }
    if (text && text.trim() && !looksLikeImagePath(text)) return false;
    var payload = api.readClipboardImage();
    var file = fileFromDesktopClipboardPayload(payload);
    if (!file) return false;
    addPendingImage(file);
    return true;
  }

  return {
    init: init,
    handleFileSelect: handleFileSelect,
    removeUploadedFile: removeUploadedFile,
    clearUploadedFiles: clearUploadedFiles,
    getUploadedFiles: getUploadedFiles,
    hasPendingUploads: hasPendingUploads,
    addPendingImage: addPendingImage,
    removePendingImage: removePendingImage,
    clearPendingImages: clearPendingImages,
    getPendingImages: getPendingImages,
    hasPendingImageLoads: hasPendingImageLoads,
    waitForPendingImageLoads: waitForPendingImageLoads,
    renderPendingImages: renderPendingImages,
    isImageFile: isImageFile,
    collectClipboardImageFiles: collectClipboardImageFiles,
    handlePasteEvent: handlePasteEvent,
    tryPasteFromDesktopClipboard: tryPasteFromDesktopClipboard,
    getComposerSnapshot: function () {
      return {
        uploadedFiles: uploadedFiles.slice(),
        pendingImages: pendingImages.slice(),
      };
    },
    setComposerSnapshot: function (snap) {
      uploadedFiles = snap && Array.isArray(snap.uploadedFiles) ? snap.uploadedFiles.slice() : [];
      pendingImages = snap && Array.isArray(snap.pendingImages) ? snap.pendingImages.slice() : [];
      renderUploadedFiles();
      renderPendingImages();
    },
  };
})();
