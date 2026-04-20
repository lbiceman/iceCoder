/**
 * Chat Page module.
 * Renders chat interface with message input, file upload, SSE streaming,
 * pipeline progress bar, and stage status labels.
 */

/* exported ChatPage */

var ChatPage = (function () {
  'use strict';

  // ---- Constants ----
  var SUPPORTED_EXTENSIONS = ['.html', '.doc', '.docx', '.ppt', '.pptx', '.xmind'];
  var STAGE_NAMES = [
    'Requirement Analysis',
    'Design',
    'Task Generation',
    'Code Writing',
    'Testing',
    'Requirement Verification'
  ];

  // ---- State ----
  var container = null;
  var messages = [];       // { role: 'user'|'agent', content: string }
  var uploadedFile = null; // { fileId, filename, size } or null
  var currentExecutionId = null;
  var eventSource = null;
  var stages = [];         // { name, status }
  var agentResponseBuffer = ''; // accumulates streaming chunks

  // ---- DOM refs (set during render) ----
  var elMessages, elInput, elSendBtn, elFileBtn, elFileInput;
  var elFileStatus, elFileName, elFileRemove;
  var elPipelinePanel, elProgressFill, elStagesContainer;
  var elSseWarning, elReconnectBtn;

  // ---- Helpers ----

  function escapeHtml(str) {
    var div = document.createElement('div');
    div.appendChild(document.createTextNode(str));
    return div.innerHTML;
  }

  function getFileExtension(filename) {
    var dot = filename.lastIndexOf('.');
    return dot >= 0 ? filename.slice(dot).toLowerCase() : '';
  }

  function isSupportedFile(filename) {
    return SUPPORTED_EXTENSIONS.indexOf(getFileExtension(filename)) >= 0;
  }

  function scrollToBottom() {
    if (elMessages) {
      elMessages.scrollTop = elMessages.scrollHeight;
    }
  }

  // ---- Rendering ----

  function renderMessages() {
    elMessages.innerHTML = '';
    for (var i = 0; i < messages.length; i++) {
      var msg = messages[i];
      var el = document.createElement('div');
      el.className = 'message ' + msg.role;

      var label = document.createElement('div');
      label.className = 'msg-label';
      label.textContent = msg.role === 'user' ? 'You' : 'Agent';
      el.appendChild(label);

      var content = document.createElement('div');
      content.textContent = msg.content;
      el.appendChild(content);

      elMessages.appendChild(el);
    }
    scrollToBottom();
  }

  function appendAgentChunk(text) {
    agentResponseBuffer += text;

    // Update the last agent message or create one
    var lastMsg = messages[messages.length - 1];
    if (lastMsg && lastMsg.role === 'agent' && lastMsg._streaming) {
      lastMsg.content = agentResponseBuffer;
    } else {
      messages.push({ role: 'agent', content: agentResponseBuffer, _streaming: true });
    }

    // Efficient incremental render: update last message element
    var msgEls = elMessages.querySelectorAll('.message.agent');
    var lastEl = msgEls[msgEls.length - 1];
    if (lastEl) {
      // Update content of existing element
      var contentEl = lastEl.lastChild;
      if (contentEl) contentEl.textContent = agentResponseBuffer;
    } else {
      renderMessages();
    }
    scrollToBottom();
  }

  function finalizeAgentResponse() {
    var lastMsg = messages[messages.length - 1];
    if (lastMsg && lastMsg._streaming) {
      delete lastMsg._streaming;
    }
    agentResponseBuffer = '';
  }

  // ---- Pipeline Progress ----

  function initStages() {
    stages = STAGE_NAMES.map(function (name) {
      return { name: name, status: 'pending' };
    });
    renderStages();
    updateProgressBar();
    elPipelinePanel.classList.remove('hidden');
  }

  function renderStages() {
    elStagesContainer.innerHTML = '';
    for (var i = 0; i < stages.length; i++) {
      var s = stages[i];
      var el = document.createElement('span');
      el.className = 'stage-label ' + s.status;
      el.textContent = s.name + ' — ' + s.status;
      el.setAttribute('data-stage', s.name);

      if (s.status === 'completed') {
        (function (stageName) {
          el.title = 'Click to view report';
          el.addEventListener('click', function () {
            viewStageReport(stageName);
          });
        })(s.name);
      }

      elStagesContainer.appendChild(el);
    }
  }

  function updateProgressBar() {
    var completed = 0;
    for (var i = 0; i < stages.length; i++) {
      if (stages[i].status === 'completed') completed++;
    }
    var pct = stages.length > 0 ? Math.round((completed / stages.length) * 100) : 0;
    elProgressFill.style.width = pct + '%';
  }

  function updateStageStatus(stageName, status) {
    for (var i = 0; i < stages.length; i++) {
      if (stages[i].name === stageName) {
        stages[i].status = status;
        break;
      }
    }
    renderStages();
    updateProgressBar();
  }

  function viewStageReport(stageName) {
    if (!currentExecutionId) return;
    // Normalize stage name for API (lowercase, hyphenated)
    var stageKey = stageName.toLowerCase().replace(/\s+/g, '-');
    var url = '/api/pipeline/' + encodeURIComponent(currentExecutionId) + '/report/' + encodeURIComponent(stageKey);

    fetch(url)
      .then(function (res) { return res.json(); })
      .then(function (data) {
        if (data.error) {
          messages.push({ role: 'agent', content: '[Report] ' + data.error });
        } else {
          var summary = data.result && data.result.summary ? data.result.summary : JSON.stringify(data.result, null, 2);
          messages.push({ role: 'agent', content: '[' + stageName + ' Report]\n' + summary });
        }
        renderMessages();
      })
      .catch(function () {
        messages.push({ role: 'agent', content: '[Report] Failed to load report for ' + stageName });
        renderMessages();
      });
  }

  // ---- File Upload ----

  function handleFileSelect(file) {
    if (!file) return;

    if (!isSupportedFile(file.name)) {
      messages.push({ role: 'agent', content: 'Unsupported file format. Supported: ' + SUPPORTED_EXTENSIONS.join(', ') });
      renderMessages();
      return;
    }

    // Upload to server
    var formData = new FormData();
    formData.append('file', file);

    elFileStatus.classList.remove('hidden');
    elFileName.textContent = file.name + ' (uploading…)';

    fetch('/api/chat/upload', {
      method: 'POST',
      body: formData
    })
      .then(function (res) { return res.json(); })
      .then(function (data) {
        if (data.error) {
          elFileName.textContent = file.name + ' (failed)';
          messages.push({ role: 'agent', content: 'Upload failed: ' + data.error });
          renderMessages();
          uploadedFile = null;
        } else {
          uploadedFile = { fileId: data.fileId, filename: data.filename, size: data.size };
          elFileName.textContent = data.filename + ' (' + formatSize(data.size) + ')';
        }
      })
      .catch(function () {
        elFileName.textContent = file.name + ' (failed)';
        uploadedFile = null;
      });
  }

  function removeUploadedFile() {
    uploadedFile = null;
    elFileStatus.classList.add('hidden');
    elFileName.textContent = '';
    elFileInput.value = '';
  }

  function formatSize(bytes) {
    if (bytes < 1024) return bytes + ' B';
    if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + ' KB';
    return (bytes / (1024 * 1024)).toFixed(1) + ' MB';
  }

  // ---- SSE ----

  function connectSSE(executionId) {
    if (eventSource) {
      eventSource.close();
    }

    currentExecutionId = executionId;
    elSseWarning.classList.add('hidden');

    eventSource = new EventSource('/api/chat/stream/' + encodeURIComponent(executionId));

    eventSource.addEventListener('message', function (e) {
      try {
        var data = JSON.parse(e.data);
        if (data.content) {
          appendAgentChunk(data.content);
        }
      } catch (_err) { /* ignore parse errors */ }
    });

    eventSource.addEventListener('stage_update', function (e) {
      try {
        var data = JSON.parse(e.data);
        if (data.stageStatus) {
          updateStageStatus(data.stageStatus.name, data.stageStatus.status);
        }
      } catch (_err) { /* ignore */ }
    });

    eventSource.addEventListener('pipeline_complete', function (e) {
      try {
        var data = JSON.parse(e.data);
        finalizeAgentResponse();
        // Mark all stages as completed if pipeline succeeded
        if (data.pipelineState && data.pipelineState.stages) {
          for (var i = 0; i < data.pipelineState.stages.length; i++) {
            var s = data.pipelineState.stages[i];
            updateStageStatus(s.name, s.status);
          }
        }
        messages.push({ role: 'agent', content: 'Pipeline execution completed.' });
        renderMessages();
      } catch (_err) { /* ignore */ }

      if (eventSource) {
        eventSource.close();
        eventSource = null;
      }
    });

    eventSource.addEventListener('error_event', function (e) {
      try {
        var data = JSON.parse(e.data);
        finalizeAgentResponse();
        messages.push({ role: 'agent', content: 'Error: ' + (data.error || 'Unknown error') });
        renderMessages();
      } catch (_err) { /* ignore */ }
    });

    eventSource.onerror = function () {
      // SSE disconnected
      elSseWarning.classList.remove('hidden');
      if (eventSource) {
        eventSource.close();
        eventSource = null;
      }
    };
  }

  function reconnectSSE() {
    if (currentExecutionId) {
      connectSSE(currentExecutionId);
    }
  }

  // ---- Send Message ----

  function handleSend() {
    var text = elInput.value.trim();
    if (!text && !uploadedFile) return;

    // Add user message
    if (text) {
      messages.push({ role: 'user', content: text });
    }
    if (uploadedFile) {
      messages.push({ role: 'user', content: '📎 ' + uploadedFile.filename });
    }
    renderMessages();
    elInput.value = '';
    autoResizeInput();

    // Build request body
    var body = {};
    if (text) body.message = text;
    if (uploadedFile) body.fileId = uploadedFile.fileId;

    // Clear file after sending
    removeUploadedFile();

    // Send to server
    fetch('/api/chat/message', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body)
    })
      .then(function (res) { return res.json(); })
      .then(function (data) {
        if (data.error) {
          messages.push({ role: 'agent', content: 'Error: ' + data.error });
          renderMessages();
          return;
        }

        if (data.executionId) {
          // Pipeline started — init progress and connect SSE
          initStages();
          agentResponseBuffer = '';
          connectSSE(data.executionId);
          messages.push({ role: 'agent', content: 'Pipeline started for ' + (data.filename || 'your request') + '…' });
          renderMessages();
        } else if (data.content) {
          messages.push({ role: 'agent', content: data.content });
          renderMessages();
        } else {
          messages.push({ role: 'agent', content: data.message || 'Message received.' });
          renderMessages();
        }
      })
      .catch(function () {
        messages.push({ role: 'agent', content: 'Failed to send message. Please check your connection.' });
        renderMessages();
      });
  }

  // ---- Input auto-resize ----

  function autoResizeInput() {
    if (!elInput) return;
    elInput.style.height = 'auto';
    elInput.style.height = Math.min(elInput.scrollHeight, 120) + 'px';
  }

  // ---- Public API ----

  function render(parentEl) {
    container = parentEl;

    container.innerHTML =
      '<div class="chat-page">' +
        // SSE warning
        '<div class="sse-warning hidden" id="sse-warning">' +
          '<span>⚠ Connection lost.</span>' +
          '<button id="btn-reconnect">Reconnect</button>' +
        '</div>' +
        // Pipeline panel
        '<div class="pipeline-panel hidden" id="pipeline-panel">' +
          '<div class="pipeline-header">' +
            '<h3>Pipeline Progress</h3>' +
          '</div>' +
          '<div class="pipeline-progress-bar">' +
            '<div class="pipeline-progress-fill" id="progress-fill"></div>' +
          '</div>' +
          '<div class="pipeline-stages" id="stages-container"></div>' +
        '</div>' +
        // Messages
        '<div class="chat-messages" id="chat-messages"></div>' +
        // Input area
        '<div class="chat-input-area">' +
          '<div class="file-upload-status hidden" id="file-status">' +
            '<span class="file-name" id="file-name"></span>' +
            '<button class="file-remove" id="file-remove" title="Remove file">&times;</button>' +
          '</div>' +
          '<div class="chat-input-row">' +
            '<button class="btn-icon" id="btn-file" title="Upload file">&#128206;</button>' +
            '<textarea id="chat-input" rows="1" placeholder="Type a message…"></textarea>' +
            '<button class="btn-icon btn-send" id="btn-send" title="Send">&#10148;</button>' +
          '</div>' +
          '<input type="file" class="hidden-input" id="file-input" accept=".html,.doc,.docx,.ppt,.pptx,.xmind">' +
        '</div>' +
      '</div>';

    // Cache DOM refs
    elMessages = container.querySelector('#chat-messages');
    elInput = container.querySelector('#chat-input');
    elSendBtn = container.querySelector('#btn-send');
    elFileBtn = container.querySelector('#btn-file');
    elFileInput = container.querySelector('#file-input');
    elFileStatus = container.querySelector('#file-status');
    elFileName = container.querySelector('#file-name');
    elFileRemove = container.querySelector('#file-remove');
    elPipelinePanel = container.querySelector('#pipeline-panel');
    elProgressFill = container.querySelector('#progress-fill');
    elStagesContainer = container.querySelector('#stages-container');
    elSseWarning = container.querySelector('#sse-warning');
    elReconnectBtn = container.querySelector('#btn-reconnect');

    // Wire events
    elSendBtn.addEventListener('click', handleSend);

    elInput.addEventListener('keydown', function (e) {
      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        handleSend();
      }
    });

    elInput.addEventListener('input', autoResizeInput);

    elFileBtn.addEventListener('click', function () {
      elFileInput.click();
    });

    elFileInput.addEventListener('change', function () {
      if (elFileInput.files && elFileInput.files[0]) {
        handleFileSelect(elFileInput.files[0]);
      }
    });

    elFileRemove.addEventListener('click', removeUploadedFile);

    elReconnectBtn.addEventListener('click', reconnectSSE);

    // Render existing messages (if navigating back)
    renderMessages();

    // Restore pipeline panel if active
    if (stages.length > 0 && currentExecutionId) {
      elPipelinePanel.classList.remove('hidden');
      renderStages();
      updateProgressBar();
    }
  }

  return { render: render };
})();
