/**
 * 文件上传与图片处理模块
 * 负责：文件上传、图片粘贴/拖拽、预览、待发送管理
 */

/* exported ChatFile */

window.ChatFile = (function () {
  'use strict';

  var uploadedFiles = [];
  var pendingImages = [];

  var elFileStatus = null;
  var elFileInput = null;

  function init(els) {
    elFileStatus = els.elFileStatus;
    elFileInput = els.elFileInput;
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
    var reader = new FileReader();
    reader.onload = function (e) {
      pendingImages.push({ dataUrl: e.target.result, file: file });
      renderPendingImages();
    };
    reader.readAsDataURL(file);
  }

  function removePendingImage(index) {
    pendingImages.splice(index, 1);
    renderPendingImages();
  }

  function clearPendingImages() {
    pendingImages = [];
    renderPendingImages();
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

  function formatSize(bytes) {
    if (bytes < 1024) return bytes + ' B';
    if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + ' KB';
    return (bytes / (1024 * 1024)).toFixed(1) + ' MB';
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
    renderPendingImages: renderPendingImages,
  };
})();
