/**
 * Vite 入口文件。
 * 导入所有页面模块。
 * CSS 通过 index.html 的 <link> 标签加载，兼容非 Vite 环境。
 */
import './notification.js';
import './modal.js';
import './diff-viewer.js';
import './config-model-panel.js';
import './config-mcp-panel.js';
import './config-page.js';
import './session-pet.js';
import './desktop-pet-bridge.js';
import './chat-websocket.js';
import './chat-session.js';
import './chat-session-store.js';
import './chat-session-sidebar.js';
import './chat-ui.js';
import './chat-welcome.js';
import './chat-dropdown.js';
import './chat-commands.js';
import './chat-model-picker.js';
import './chat-file.js';
import './chat-qr.js';
import './chat-pet-bridge.js';
import './chat-execution-plan.js';
import './chat-execution-plan-bridge.js';
import './tool-trace-format.js';
import './tool-display-history.js';
import './chat-virtual-history.js';
import './chat-staircase-nav.js';
import './chat-bg-task-chip.js';
import './chat-skills.js';
import './chat-file-ref.js';
import './shell/mobile-session-drawer.js';
import './shell/mobile-composer-host.js';
import './shell/mobile-shell.js';
import './pages/mobile/mobile-work-page.js';
import './pages/mobile/mobile-chat-page.js';
import './pages/mobile/mobile-memory-page.js';
import './pages/mobile/mobile-skills-page.js';
import './pages/mobile/mobile-config-page.js';
import './chat-page.js';
import './memory-page.js';
import './skills-page.js';
import './app.js';
