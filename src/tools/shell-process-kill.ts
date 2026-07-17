/**
 * 跨平台 shell 子进程树终止（前台 / 后台共用）。
 */

import { spawn } from 'node:child_process';
import type { ChildProcess } from 'node:child_process';
import { resolveWindowsSystemExecutable } from './shell-spawn-env.js';

/** Windows：异步启动 CIM 进程树扫描兜底，不占用调用线程。 */
function startWindowsCimFallback(rootPid: number, powershell: string): void {
  try {
    const fallback = spawn(
      powershell,
      [
        '-NoProfile',
        '-NonInteractive',
        '-Command',
        `$root=${rootPid};$seen=@{};$q=[Collections.Queue]::new();$q.Enqueue($root);`
          + 'while($q.Count -gt 0){$p=$q.Dequeue();if($seen[$p]){continue};$seen[$p]=$true;'
          + 'Get-CimInstance Win32_Process -Filter "ParentProcessId=$p" | ForEach-Object {$q.Enqueue([int]$_.ProcessId)}};'
          + 'foreach($p in $seen.Keys){try{Stop-Process -Id $p -Force -ErrorAction SilentlyContinue}catch{}}',
      ],
      { windowsHide: true, detached: true, stdio: 'ignore' },
    );
    fallback.once('error', (err) => {
      console.warn(`[shell-kill] PowerShell 进程树 kill 启动失败 rootPid=${rootPid}: ${err.message}`);
    });
    fallback.once('close', (code) => {
      if (code !== 0) {
        console.warn(`[shell-kill] PowerShell 进程树 kill 退出异常 rootPid=${rootPid} code=${code}`);
      }
    });
    fallback.unref();
    console.log(`[shell-kill] 已发起 PowerShell 进程树 kill rootPid=${rootPid}`);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.warn(`[shell-kill] PowerShell 进程树 kill 启动失败 rootPid=${rootPid}: ${msg}`);
  }
}

/**
 * Windows：异步发起递归终止进程树。
 * taskkill 成功即结束；启动失败或非零退出时异步启动 CIM 扫描兜底。
 */
export function killWindowsProcessTree(rootPid: number): void {
  const taskkill = resolveWindowsSystemExecutable('taskkill');
  const powershell = resolveWindowsSystemExecutable('powershell');
  try {
    const killer = spawn(taskkill, ['/PID', String(rootPid), '/T', '/F'], {
      windowsHide: true,
      detached: true,
      stdio: 'ignore',
    });
    let settled = false;
    killer.once('error', (err) => {
      if (settled) return;
      settled = true;
      console.warn(`[shell-kill] taskkill 启动失败 pid=${rootPid}: ${err.message}`);
      startWindowsCimFallback(rootPid, powershell);
    });
    killer.once('close', (code) => {
      if (settled) return;
      settled = true;
      if (code === 0) {
        console.log(`[shell-kill] taskkill /T /F 成功 pid=${rootPid}`);
        return;
      }
      console.warn(`[shell-kill] taskkill 失败 pid=${rootPid}: exit code ${code}`);
      startWindowsCimFallback(rootPid, powershell);
    });
    killer.unref();
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.warn(`[shell-kill] taskkill 启动失败 pid=${rootPid}: ${msg}`);
    startWindowsCimFallback(rootPid, powershell);
  }
}

/** Windows：异步发起按监听端口终止 dev server。 */
export function killProcessesOnPortWindows(port: number): void {
  const powershell = resolveWindowsSystemExecutable('powershell');
  try {
    const killer = spawn(
      powershell,
      [
        '-NoProfile',
        '-NonInteractive',
        '-Command',
        `$p=${port};Get-NetTCPConnection -LocalPort $p -State Listen -ErrorAction SilentlyContinue `
          + '| Select-Object -ExpandProperty OwningProcess -Unique '
          + '| ForEach-Object { Stop-Process -Id $_ -Force -ErrorAction SilentlyContinue }',
      ],
      { windowsHide: true, detached: true, stdio: 'ignore' },
    );
    let settled = false;
    killer.once('error', (err) => {
      if (settled) return;
      settled = true;
      console.warn(`[shell-kill] 按端口 ${port} 终止启动失败: ${err.message}`);
    });
    killer.once('close', (code) => {
      if (settled) return;
      settled = true;
      if (code === 0) {
        console.log(`[shell-kill] 已按端口 ${port} 终止监听进程`);
      } else {
        console.warn(`[shell-kill] 按端口 ${port} 终止失败: exit code ${code}`);
      }
    });
    killer.unref();
    console.log(`[shell-kill] 已发起按端口 ${port} 终止监听进程`);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.warn(`[shell-kill] 按端口 ${port} 终止启动失败: ${msg}`);
  }
}

/** POSIX：向进程组发 SIGTERM → SIGKILL */
export function killPosixProcessTree(child: ChildProcess): void {
  if (!child.pid) return;
  const pid = child.pid;
  try { process.kill(-pid, 'SIGTERM'); } catch {
    try { child.kill('SIGTERM'); } catch { /* ignore */ }
  }
  setTimeout(() => {
    if (!child.pid) return;
    try { process.kill(-pid, 'SIGKILL'); } catch {
      try { child.kill('SIGKILL'); } catch { /* ignore */ }
    }
  }, 2000).unref?.();
  console.log(`[shell-kill] 已发送 SIGTERM 至进程组 pid=${pid}`);
}

/** 发起终止 shell 子进程及其 OS 进程树；Windows 分支不会等待终止完成。 */
export function killShellProcessTree(
  rootPid: number | null,
  child?: ChildProcess | null,
  detectedPort?: number | null,
): void {
  const pid = rootPid ?? child?.pid ?? null;
  if (process.platform === 'win32') {
    if (pid) {
      killWindowsProcessTree(pid);
    } else {
      console.warn('[shell-kill] 无 rootPid，无法杀 OS 进程');
    }
    if (detectedPort) {
      killProcessesOnPortWindows(detectedPort);
    }
    return;
  }
  if (child) {
    killPosixProcessTree(child);
  } else if (pid) {
    try { process.kill(-pid, 'SIGTERM'); } catch {
      try { process.kill(pid, 'SIGTERM'); } catch { /* ignore */ }
    }
  }
}
