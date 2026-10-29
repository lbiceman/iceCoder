/**
 * Host Guard — 防止工作区 shell / 脚本误杀 iceCoder 宿主进程。
 *
 * L1: run_command 字面量扫描
 * L2: 执行脚本前读文件扫描（node / powershell -File / sh / bat）
 * L3: write/edit/patch 写入内容扫描（由 harness-tool-preflight 调用）
 *
 * 打包后的桌面端用 ELECTRON_RUN_AS_NODE 拿自身 exe 跑 server，宿主镜像名是 iceCoder.exe，
 * 不是 node.exe。执行路径（L1/L2）按真实宿主镜像名拦截；写入路径（L3）只拦 node/tsx 广杀，
 * 避免改 iceCoder 自身源码、测试、文档时被误拦。
 */

import { existsSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { augmentPathForShellSpawn } from './shell-spawn-env.js';

/** 运行时镜像名：广杀会终止 CLI / 开发态宿主。 */
const RUNTIME_IMAGE_NAMES = ['node', 'nodejs', 'tsx'];

/** 产品镜像名：即使 execPath 探测不到也保护。 */
const PRODUCT_IMAGE_NAMES = ['icecoder'];

const KILL_VERB_RE = /\btaskkill(?:\.exe)?\b|\bStop-Process\b|\bspps\b|\bkillall\b|\bpkill\b|\bkill\b|\.kill\s*\(|\bTerminate\b/i;

const MAX_SCANNED_SCRIPT_BYTES = 512 * 1024;

const NODE_SCRIPT_CMD_RE = /\bnode(?:\.exe)?\s+(?:"([^"]+\.(?:cjs|mjs|js|ts))"|'([^']+\.(?:cjs|mjs|js|ts))'|(\S+\.(?:cjs|mjs|js|ts)))/i;

const SCRIPT_LAUNCHER_RES: RegExp[] = [
  NODE_SCRIPT_CMD_RE,
  /\b(?:tsx|bun|deno(?:\s+run)?)(?:\.exe)?\s+(?:"([^"]+\.(?:cjs|mjs|js|ts))"|'([^']+\.(?:cjs|mjs|js|ts))'|(\S+\.(?:cjs|mjs|js|ts)))/i,
  /\b(?:powershell|pwsh)(?:\.exe)?\b[^\n\r]*?\s-f(?:ile)?\s+(?:"([^"]+)"|'([^']+)'|(\S+))/i,
  /(?:^|[\s&|;(]|\.[\\/])(?:"([^"]+\.ps1)"|'([^']+\.ps1)'|((?:\.{0,2}[\\/]|[a-z]:[\\/])?[^\s"'&|;()]+\.ps1))(?=\s|$)/i,
  /\b(?:ba|z|k)?sh(?:\.exe)?\s+(?:"([^"]+\.sh)"|'([^']+\.sh)'|(\S+\.sh))/i,
  /\b(?:cmd(?:\.exe)?\s+\/c|call)\s+(?:"([^"]+\.(?:bat|cmd))"|'([^']+\.(?:bat|cmd))'|(\S+\.(?:bat|cmd)))/i,
  /\bpython[0-9.]*(?:\.exe)?\s+(?:"([^"]+\.py)"|'([^']+\.py)'|(\S+\.py))/i,
];

const HOST_GUARD_WRITE_TOOLS = new Set([
  'write_file',
  'append_file',
  'edit_file',
  'patch_file',
  'batch_edit_file',
]);

const hostListenPorts = new Set<number>();

export interface ShellHostGuardResult {
  blocked: boolean;
  message?: string;
  matchLabel?: string;
}

export interface HostKillScanOptions {
  /**
   * 执行路径：按真实宿主镜像名（iceCoder / electron）、按名筛选进程后杀、
   * 杀父进程都算误杀。写入路径保持 false。
   */
  execution?: boolean;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function normalizeImageName(raw: string): string {
  return raw.trim().toLowerCase().replace(/\.exe$/, '');
}

/** 宿主自身的应用镜像名（不含 node/tsx 这类通用运行时）。 */
export function resolveHostAppImageNames(): string[] {
  const names = new Set<string>(PRODUCT_IMAGE_NAMES);
  const exe = normalizeImageName(path.basename(process.execPath || ''));
  if (exe && !RUNTIME_IMAGE_NAMES.includes(exe)) names.add(exe);
  if (process.env.ICE_ELECTRON === '1') names.add('electron');
  for (const extra of (process.env.ICE_HOST_IMAGE_NAMES ?? '').split(',')) {
    const name = normalizeImageName(extra);
    if (name) names.add(name);
  }
  return [...names];
}

/**
 * 杀掉就等于杀宿主的 PID：自身，以及桌面端的 Electron 主进程（server 的父进程）。
 * CLI 的父进程是用户终端，不在这里。
 */
export function getProtectedHostPids(): number[] {
  const pids = new Set<number>([process.pid]);
  if (process.env.ICE_ELECTRON === '1' && process.ppid > 0) pids.add(process.ppid);
  for (const extra of (process.env.ICE_HOST_PIDS ?? '').split(',')) {
    const pid = parseInt(extra.trim(), 10);
    if (Number.isSafeInteger(pid) && pid > 0) pids.add(pid);
  }
  return [...pids];
}

export function isProtectedHostPid(pid: number): boolean {
  return getProtectedHostPids().includes(pid);
}

/** 宿主 HTTP 服务监听后登记端口，按端口杀进程时跳过。 */
export function registerHostListenPort(port: number): void {
  if (Number.isSafeInteger(port) && port > 0) hostListenPorts.add(port);
}

export function isHostListenPort(port: number): boolean {
  return hostListenPorts.has(port);
}

export function __resetHostListenPortsForTest(): void {
  hostListenPorts.clear();
}

function buildBroadKillMatchers(names: string[]): Array<{ re: RegExp; label: (name: string) => string }> {
  const n = `(${names.map(escapeRegExp).join('|')})(?:\\.exe)?`;
  return [
    {
      re: new RegExp(`\\btaskkill\\b[^;\\n\\r]*\\/IM\\s+[\\s"']*${n}(?![\\w-])`, 'i'),
      label: (name) => `taskkill /IM ${name}`,
    },
    {
      re: new RegExp(`\\btaskkill\\b[^;\\n\\r]*\\bIMAGENAME\\s+eq\\s+[\\s"']*${n}(?![\\w-])`, 'i'),
      label: (name) => `taskkill /FI IMAGENAME ${name}`,
    },
    {
      re: new RegExp(`\\bkillall\\s+(?:-\\S+\\s+)*[\\s"']*${n}\\b`, 'i'),
      label: (name) => `killall ${name}`,
    },
    {
      re: new RegExp(`\\bpkill\\s+(?:-\\S+\\s+)*[\\s"']*${n}\\b`, 'i'),
      label: (name) => `pkill ${name}`,
    },
    {
      re: new RegExp(`(?:Stop-Process|\\bspps|\\bkill)\\s+[^\\n\\r]*-(?:Process)?N(?:a(?:me?)?)?\\s+[\\s"'@(]*${n}`, 'i'),
      label: (name) => `Stop-Process -Name ${name}`,
    },
    {
      re: new RegExp(`(?:Get-Process|\\bgps|\\bps|\\bpgrep|\\bpidof)\\s+[^\\n\\r]*${n}[^\\n\\r]*\\|\\s*(?:xargs\\s+(?:-\\S+\\s+)*)?(?:Stop-Process|spps|kill)\\b`, 'i'),
      label: (name) => `Get-Process ${name} | Stop-Process`,
    },
    {
      re: new RegExp(`\\bwmic\\b[^;\\n\\r]*(?:name\\s*=\\s*['"]${n}['"]|\\b${n}\\.exe)`, 'i'),
      label: (name) => `wmic ${name}`,
    },
  ];
}

/**
 * 按应用镜像名筛选进程再杀（-like 过滤后从变量里拿 Id 等）。
 * 只看进程筛选语境，不看裸词和 exe 路径：仓库目录本身就叫 iceCoder，
 * 启动测试副本再按它自己的 PID 结束是允许的。
 */
function findAppProcessSelection(text: string, appNames: string[]): string | null {
  if (!KILL_VERB_RE.test(text)) return null;
  for (const name of appNames) {
    const n = escapeRegExp(name);
    const selectors = [
      new RegExp(`\\bProcessName\\b[^\\n\\r]{0,60}?\\b${n}`, 'i'),
      new RegExp(`-(?:like|match|eq)\\s+[\\s"'@(]*\\*?${n}`, 'i'),
      new RegExp(`-(?:Process)?Name\\s+[\\s"'@(]*\\*?${n}`, 'i'),
      new RegExp(`GetProcessesByName\\s*\\(\\s*["']${n}`, 'i'),
      new RegExp(`(?:-Filter|\\bwhere)\\b[^\\n\\r]{0,40}?\\bName\\s*(?:=|like)\\s*['"]?%?${n}`, 'i'),
    ];
    if (selectors.some((re) => re.test(text))) return `kill selecting ${name} processes`;
  }
  return null;
}

export function findHostKillInText(text: string, options?: HostKillScanOptions): string | null {
  const execution = options?.execution === true;
  const names = execution
    ? [...new Set([...RUNTIME_IMAGE_NAMES, ...resolveHostAppImageNames()])]
    : RUNTIME_IMAGE_NAMES;

  for (const { re, label } of buildBroadKillMatchers(names)) {
    const match = re.exec(text);
    if (match) return label(normalizeImageName(match[1] ?? ''));
  }

  const pidKill = findSelfPidKillInText(
    text,
    process.pid,
    execution ? getProtectedHostPids() : [],
  );
  if (pidKill) return pidKill;

  return execution ? findAppProcessSelection(text, resolveHostAppImageNames()) : null;
}

/** 拦截针对 iceCoder 宿主 PID 的精确杀进程（允许 taskkill 其他 PID）。 */
export function findSelfPidKillInText(
  text: string,
  rootPid = process.pid,
  extraPids: number[] = [],
): string | null {
  const pids = new Set([String(rootPid), ...extraPids.map(String)]);

  if (/ICE_AGENT_ROOT_PID/i.test(text)) {
    if (/\btaskkill\b/i.test(text)) return 'taskkill /PID agent root';
    if (/\bkill\b/i.test(text)) return 'kill agent root pid';
    if (/Stop-Process/i.test(text)) return 'Stop-Process agent root pid';
  }

  let match: RegExpExecArray | null;
  const taskkillPidRe = /\btaskkill\b[^;\n\r]*?\/PID\s+(\d+)/gi;
  while ((match = taskkillPidRe.exec(text)) !== null) {
    if (pids.has(match[1])) return 'taskkill /PID agent root';
  }

  const taskkillFilterRe = /\btaskkill\b[^;\n\r]*?\bPID\s+eq\s+(\d+)/gi;
  while ((match = taskkillFilterRe.exec(text)) !== null) {
    if (pids.has(match[1])) return 'taskkill /PID agent root';
  }

  const killNumRe = /\bkill\s+(?:-\S+\s+)*(\d+)/gi;
  while ((match = killNumRe.exec(text)) !== null) {
    if (pids.has(match[1])) return 'kill agent root pid';
  }

  const stopIdRe = /(?:Stop-Process|\bspps|\bkill)\s+[^\n\r]*?-Id\s+(\d+)/gi;
  while ((match = stopIdRe.exec(text)) !== null) {
    if (pids.has(match[1])) return 'Stop-Process -Id agent root';
  }

  const nodeKillRe = /process\.kill\s*\(\s*(\d+)/gi;
  while ((match = nodeKillRe.exec(text)) !== null) {
    if (pids.has(match[1])) return 'process.kill agent root';
  }

  return null;
}

export const HOST_GUARD_HINT = [
  'Broad process kills by image name (taskkill /IM node|iceCoder.exe, Stop-Process -Name, killall, pkill) terminate the running iceCoder agent.',
  'The desktop app runs the agent inside iceCoder.exe; a test copy you launch has the same image name, so never select processes by that name.',
  'Never kill the agent root PID (ICE_AGENT_ROOT_PID) or its parent.',
  'To stop something you started, keep the PID from Start-Process -PassThru / spawn() and run taskkill /PID <pid> /T /F on that PID only.',
  'To stop a dev or preview server, find the PID listening on that server\'s own port and stop only that PID.',
  'Do not retry the same command or embed it in scripts.',
].join('\n');

export function buildHostGuardBlockMessage(context: string): string {
  return `[HostGuard / Blocked] ${context}\n${HOST_GUARD_HINT}`;
}

function firstCapture(match: RegExpMatchArray): string | null {
  for (let i = 1; i < match.length; i++) {
    if (match[i]) return match[i];
  }
  return null;
}

export function extractNodeScriptPath(command: string): string | null {
  const match = command.match(NODE_SCRIPT_CMD_RE);
  return match ? firstCapture(match) : null;
}

/** run_command 会执行的脚本文件（相对路径按 workDir 解析）。 */
export function extractExecutedScriptPaths(command: string): string[] {
  const found = new Set<string>();
  for (const re of SCRIPT_LAUNCHER_RES) {
    const match = command.match(re);
    const scriptPath = match ? firstCapture(match) : null;
    if (scriptPath) found.add(scriptPath);
  }
  return [...found];
}

function resolveScriptPath(scriptPath: string, workDir: string): string {
  return path.isAbsolute(scriptPath) ? scriptPath : path.resolve(workDir, scriptPath);
}

function readScriptForScan(scriptPath: string): string | null {
  try {
    if (!existsSync(scriptPath)) return null;
    const stat = statSync(scriptPath);
    if (!stat.isFile() || stat.size > MAX_SCANNED_SCRIPT_BYTES) return null;
    return readFileSync(scriptPath, 'utf-8');
  } catch {
    return null;
  }
}

/**
 * L1 + L2：分析 run_command 是否会误杀宿主。
 */
export function analyzeShellHostSafety(
  command: string,
  options?: { workDir?: string },
): ShellHostGuardResult {
  const trimmed = command.trim();
  if (!trimmed) return { blocked: false };

  const direct = findHostKillInText(trimmed, { execution: true });
  if (direct) {
    return {
      blocked: true,
      matchLabel: direct,
      message: buildHostGuardBlockMessage(`Detected in command: ${direct}`),
    };
  }

  const workDir = options?.workDir;
  if (!workDir) return { blocked: false };

  for (const scriptRel of extractExecutedScriptPaths(trimmed)) {
    const content = readScriptForScan(resolveScriptPath(scriptRel, workDir));
    if (content === null) continue;
    const inScript = findHostKillInText(content, { execution: true });
    if (inScript) {
      return {
        blocked: true,
        matchLabel: inScript,
        message: buildHostGuardBlockMessage(
          `Script ${scriptRel} contains host-kill pattern: ${inScript}`,
        ),
      };
    }
  }

  return { blocked: false };
}

export function extractWritableText(toolName: string, args: Record<string, unknown>): string {
  if (toolName === 'write_file' || toolName === 'append_file') {
    return typeof args.content === 'string' ? args.content : String(args.content ?? '');
  }
  if (toolName === 'edit_file') {
    return [args.replace, args.search]
      .filter((x): x is string => typeof x === 'string')
      .join('\n');
  }
  if (toolName === 'patch_file') {
    return typeof args.patch === 'string' ? args.patch : '';
  }
  if (toolName === 'batch_edit_file') {
    const edits = args.edits;
    if (!Array.isArray(edits)) return '';
    return edits
      .map((entry) => {
        if (!entry || typeof entry !== 'object') return '';
        const edit = entry as Record<string, unknown>;
        return [edit.replace, edit.search]
          .filter((x): x is string => typeof x === 'string')
          .join('\n');
      })
      .join('\n');
  }
  return '';
}

/** L3：写入类工具内容扫描。 */
export function checkHostGuardWritePreflight(
  toolName: string,
  args: Record<string, unknown>,
): ShellHostGuardResult {
  if (!HOST_GUARD_WRITE_TOOLS.has(toolName)) {
    return { blocked: false };
  }

  const text = extractWritableText(toolName, args);
  if (!text.trim()) return { blocked: false };

  const match = findHostKillInText(text);
  if (!match) return { blocked: false };

  return {
    blocked: true,
    matchLabel: match,
    message: buildHostGuardBlockMessage(`${toolName} would write host-kill pattern: ${match}`),
  };
}

/** P2：注入子进程环境，便于脚本避开宿主 PID。 */
export function buildShellChildEnv(sessionId?: string): NodeJS.ProcessEnv {
  return {
    ...process.env,
    PATH: augmentPathForShellSpawn(process.env.PATH),
    NODE_ENV: 'production',
    ICE_AGENT_ROOT_PID: String(process.pid),
    ...(sessionId ? { ICE_AGENT_SESSION: sessionId } : {}),
  };
}
