/**
 * Host Guard — 防止工作区 shell / 脚本误杀 iceCoder 宿主进程。
 *
 * L1: run_command 字面量扫描
 * L2: node script.cjs 执行前读文件扫描
 * L3: write/edit/patch 写入内容扫描（由 harness-tool-preflight 调用）
 */

import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';

/** 按进程镜像名广杀 node/tsx — 会终止 iceCoder 宿主 */
const HOST_KILL_PATTERN_DEFS: Array<{ re: RegExp; label: string }> = [
  { re: /\btaskkill\b[^;\n\r]*\/IM\s+[\s"']*(?:node(?:js)?|tsx)(?:\.exe)?/i, label: 'taskkill /IM node' },
  { re: /\bkillall\s+[\s"']*node\b/i, label: 'killall node' },
  { re: /\bpkill\s+(?:-f\s+)?[\s"']*node\b/i, label: 'pkill node' },
  { re: /Stop-Process\s+[^\n\r]*-Name\s+[\s"']*node/i, label: 'Stop-Process -Name node' },
  { re: /Get-Process\s+[^\n\r]*node[^\n\r]*\|\s*Stop-Process/i, label: 'Get-Process node | Stop-Process' },
  { re: /\bwmic\b[^;\n\r]*(?:name\s*=\s*['"]node(?:\.exe)?['"]|node\.exe)/i, label: 'wmic delete node' },
];

const NODE_SCRIPT_CMD_RE = /\bnode(?:\.exe)?\s+(?:"([^"]+\.(?:cjs|mjs|js|ts))"|'([^']+\.(?:cjs|mjs|js|ts))'|(\S+\.(?:cjs|mjs|js|ts)))/i;

const HOST_GUARD_WRITE_TOOLS = new Set([
  'write_file',
  'append_file',
  'edit_file',
  'patch_file',
  'batch_edit_file',
]);

export interface ShellHostGuardResult {
  blocked: boolean;
  message?: string;
  matchLabel?: string;
}

export function findHostKillInText(text: string): string | null {
  for (const { re, label } of HOST_KILL_PATTERN_DEFS) {
    if (re.test(text)) return label;
  }
  return findSelfPidKillInText(text);
}

/** 拦截针对 iceCoder 宿主 PID 的精确杀进程（允许 taskkill 其他 PID）。 */
export function findSelfPidKillInText(text: string, rootPid = process.pid): string | null {
  const pidStr = String(rootPid);

  if (/ICE_AGENT_ROOT_PID/i.test(text)) {
    if (/\btaskkill\b/i.test(text)) return 'taskkill /PID agent root';
    if (/\bkill\b/i.test(text)) return 'kill agent root pid';
    if (/Stop-Process/i.test(text)) return 'Stop-Process agent root pid';
  }

  let match: RegExpExecArray | null;
  const taskkillPidRe = /\btaskkill\b[^;\n\r]*?\/PID\s+(\d+)/gi;
  while ((match = taskkillPidRe.exec(text)) !== null) {
    if (match[1] === pidStr) return 'taskkill /PID agent root';
  }

  const killNumRe = /\bkill\s+(?:-\S+\s+)*(\d+)/gi;
  while ((match = killNumRe.exec(text)) !== null) {
    if (match[1] === pidStr) return 'kill agent root pid';
  }

  const stopIdRe = /Stop-Process\s+[^\n\r]*?-Id\s+(\d+)/gi;
  while ((match = stopIdRe.exec(text)) !== null) {
    if (match[1] === pidStr) return 'Stop-Process -Id agent root';
  }

  return null;
}

export const HOST_GUARD_HINT = [
  'Broad process kills (taskkill /IM node, killall node, pkill node) terminate the running iceCoder agent.',
  'Never kill the agent root PID (ICE_AGENT_ROOT_PID / current node process).',
  'To stop a dev/preview server, kill by port/PID instead:',
  '  netstat -ano | findstr :4173',
  '  taskkill /F /PID <other-pid>',
  'Do not retry the same command or embed it in scripts.',
].join('\n');

export function buildHostGuardBlockMessage(context: string): string {
  return `[HostGuard / Blocked] ${context}\n${HOST_GUARD_HINT}`;
}

export function extractNodeScriptPath(command: string): string | null {
  const match = command.match(NODE_SCRIPT_CMD_RE);
  if (!match) return null;
  return match[1] || match[2] || match[3] || null;
}

function resolveScriptPath(scriptPath: string, workDir: string): string {
  return path.isAbsolute(scriptPath) ? scriptPath : path.resolve(workDir, scriptPath);
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

  const direct = findHostKillInText(trimmed);
  if (direct) {
    return {
      blocked: true,
      matchLabel: direct,
      message: buildHostGuardBlockMessage(`Detected in command: ${direct}`),
    };
  }

  const scriptRel = extractNodeScriptPath(trimmed);
  const workDir = options?.workDir;
  if (!scriptRel || !workDir) return { blocked: false };

  const scriptPath = resolveScriptPath(scriptRel, workDir);
  if (!existsSync(scriptPath)) return { blocked: false };

  try {
    const content = readFileSync(scriptPath, 'utf-8');
    const inScript = findHostKillInText(content);
    if (inScript) {
      return {
        blocked: true,
        matchLabel: inScript,
        message: buildHostGuardBlockMessage(
          `Script ${scriptRel} contains host-kill pattern: ${inScript}`,
        ),
      };
    }
  } catch {
    // unreadable script — skip L2
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
    NODE_ENV: 'production',
    ICE_AGENT_ROOT_PID: String(process.pid),
    ...(sessionId ? { ICE_AGENT_SESSION: sessionId } : {}),
  };
}
