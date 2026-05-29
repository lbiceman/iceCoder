/**
 * Split style.css → tokens / shell / config / chat / memory + style.css @import hub.
 * Applies phase A (remove dead CSS) and B (tokenize hardcoded colors).
 */
import fs from 'node:fs';
import path from 'node:path';

const cssDir = path.resolve('src/public/css');
const src = fs.readFileSync(path.join(cssDir, 'style.css'), 'utf8');
const lines = src.split('\n');

function slice(start, end) {
  return lines.slice(start - 1, end).join('\n');
}

function stripBlocks(text) {
  return text
    .replace(/\/\* ===== Remote Confirm Dialog ===== \*\/[\s\S]*?(?=\/\* ===== Scrollbar)/, '')
    .replace(/\.thinking-dots[\s\S]*?@keyframes thinkBounce \{[\s\S]*?\}\n\n/g, '')
    .replace(/\/\* SSE disconnect warning \*\/[\s\S]*?(?=\n\.hidden-input)/, '\n')
    .replace(/\.nav-logo \{[\s\S]*?\}\n\n/g, '')
    .replace(/  \.nav-logo \{ width: 24px; height: 24px; \}\n/g, '')
    .replace(/\.memory-sub \{[\s\S]*?\}\n\n/g, '')
    .replace(/\.memory-code-inline \{[\s\S]*?\}\n\n/g, '')
    .replace(/\.memory-chip-type \{[\s\S]*?\}\n\n/g, '')
    .replace(/\/\* Theme toggle — defined above, no duplicate needed \*\/\n\n/g, '');
}

function applyPhaseB(text) {
  return text
    .replace(
      /\.message-bg_status \{[\s\S]*?font-family:[^;]+;\n\}/,
      `.message-bg_status {
  opacity: 0.75;
  font-size: 0.85em;
  border-left: 2px solid var(--text-muted);
  padding: 6px 10px;
  background: var(--bg-hover);
  border-radius: 4px;
  font-family: ui-monospace, "SF Mono", Menlo, Consolas, monospace;
}`,
    )
    .replace(
      /\.message-bg_status\.is-terminal-success \{[^}]+\}/,
      '.message-bg_status.is-terminal-success { border-left-color: var(--success); color: var(--success); }',
    )
    .replace(
      /\.message-bg_status\.is-terminal-error\s*\{[^}]+\}/,
      '.message-bg_status.is-terminal-error { border-left-color: var(--danger); color: var(--danger); }',
    )
    .replace(
      /\.message-bg_status\.is-hang\s*\{[^}]+\}/,
      '.message-bg_status.is-hang { border-left-color: var(--warning); color: var(--warning); }',
    )
    .replace(/\.tool-action \.tool-icon\.success \{\s*color: #4dd860;\s*\}/, '.tool-action .tool-icon.success { color: var(--success); }')
    .replace(/\.tool-action \.tool-icon\.warn \{\s*color: #e6a817;\s*\}/, '.tool-action .tool-icon.warn { color: var(--warning); }');
}

const tokens = slice(1, 123);

const shell = stripBlocks(
  [
    slice(125, 343),
    '',
    '/* ===== Scrollbar ===== */',
    slice(1332, 1339),
    '',
    '/* ===== Responsive (shell) ===== */',
    slice(1341, 1353),
  ].join('\n'),
);

const config = slice(345, 557);

const chat = applyPhaseB(
  stripBlocks(
    [
      slice(559, 1161),
      slice(1208, 1208),
      '',
      slice(1210, 1278),
      '',
      slice(1355, 1423),
      '',
      '/* ===== Chat Session Sidebar ===== */',
      slice(1937, 2177),
    ].join('\n'),
  ),
);

const memory = stripBlocks(slice(1425, 1933));

const hub = `/* iceCoder UI — split modules (load order matters) */
@import url('./tokens.css');
@import url('./shell.css');
@import url('./config.css');
@import url('./chat.css');
@import url('./memory.css');
`;

fs.writeFileSync(path.join(cssDir, 'tokens.css'), tokens.trim() + '\n');
fs.writeFileSync(path.join(cssDir, 'shell.css'), shell.trim() + '\n');
fs.writeFileSync(path.join(cssDir, 'config.css'), config.trim() + '\n');
fs.writeFileSync(path.join(cssDir, 'chat.css'), chat.trim() + '\n');
fs.writeFileSync(path.join(cssDir, 'memory.css'), memory.trim() + '\n');
fs.writeFileSync(path.join(cssDir, 'style.css'), hub);

const total =
  tokens.split('\n').length +
  shell.split('\n').length +
  config.split('\n').length +
  chat.split('\n').length +
  memory.split('\n').length +
  hub.split('\n').length;
console.log('Wrote tokens.css, shell.css, config.css, chat.css, memory.css, style.css hub');
console.log('Approx lines:', total, '(was', lines.length + ')');
