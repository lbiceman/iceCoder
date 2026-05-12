/**
 * 文件上传与图片处理模块
 * 负责：文件上传、图片粘贴/拖拽、预览、待发送管理
 */

/* exported ChatFile */

window.ChatFile = (function () {
  'use strict';

  var uploadedFile = null;
  var pendingImages = [];

  var elFileStatus = null;
  var elFileName = null;
  var elFileInput = null;

  function init(els) {
    elFileStatus = els.elFileStatus;
    elFileName = els.elFileName;
    elFileInput = els.elFileInput;
  }

  function handleFileSelect(file, messages, appendFn, saveFn) {
    if (!file) return;

    var formData = new FormData();
    formData.append('file', file);

    if (elFileStatus) elFileStatus.classList.remove('hidden');
    if (elFileName) elFileName.textContent = file.name + ' (uploading…)';

    fetch('/api/chat/upload', {
      method: 'POST',
      body: formData
    })
      .then(function (res) { return res.json(); })
      .then(function (data) {
        if (data.error) {
          if (elFileName) elFileName.textContent = file.name + ' (failed)';
          messages.push({ role: 'agent', content: 'Upload failed: ' + data.error });
          appendFn(messages[messages.length - 1]);
          saveFn();
          uploadedFile = null;
        } else {
          uploadedFile = { fileId: data.fileId, filename: data.filename, size: data.size };
          if (elFileName) elFileName.textContent = data.filename + ' (' + formatSize(data.size) + ') — 发送时将自动解析';
        }
      })
      .catch(function () {
        if (elFileName) elFileName.textContent = file.name + ' (failed)';
        uploadedFile = null;
      });
  }

  function removeUploadedFile() {
    uploadedFile = null;
    if (elFileStatus) elFileStatus.classList.add('hidden');
    if (elFileName) elFileName.textContent = '';
    if (elFileInput) elFileInput.value = '';
  }

  function getUploadedFile() {
    return uploadedFile;
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
    getUploadedFile: getUploadedFile,
    addPendingImage: addPendingImage,
    removePendingImage: removePendingImage,
    clearPendingImages: clearPendingImages,
    getPendingImages: getPendingImages,
    renderPendingImages: renderPendingImages,
  };
})();
