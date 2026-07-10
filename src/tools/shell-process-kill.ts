/**
 * 跨平台 shell 子进程树终止（前台 / 后台共用）。
 */

import { execFileSync } from 'node:child_process';
import type { ChildProcess } from 'node:child_process';

function isPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err: unknown) {
    const code = err && typeof err === 'object' && 'code' in err ? (err as NodeJS.ErrnoException).code : '';
    return code !== 'ESRCH';
  }
}

/** Windows：递归终止进程树（taskkill + PowerShell 子进程扫描） */
export function killWindowsProcessTree(rootPid: number): void {
  try {
    execFileSync('taskkill', ['/PID', String(rootPid), '/T', '/F'], {
      windowsHide: true,
      stdio: 'pipe',
    });
    console.log(`[shell-kill] taskkill /T /F 成功 pid=${rootPid}`);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.warn(`[shell-kill] taskkill 失败 pid=${rootPid}: ${msg}`);
  }
  try {
    execFileSync(
      'powershell',
      [
        '-NoProfile',
        '-NonInteractive',
        '-Command',
        `$root=${rootPid};$seen=@{};$q=[Collections.Queue]::new();$q.Enqueue($root);`
          + 'while($q.Count -gt 0){$p=$q.Dequeue();if($seen[$p]){continue};$seen[$p]=$true;'
          + 'Get-CimInstance Win32_Process -Filter "ParentProcessId=$p" | ForEach-Object {$q.Enqueue([int]$_.ProcessId)}};'
          + 'foreach($p in $seen.Keys){try{Stop-Process -Id $p -Force -ErrorAction SilentlyContinue}catch{}}',
      ],
      { windowsHide: true, stdio: 'pipe' },
    );
    console.log(`[shell-kill] PowerShell 进程树 kill 完成 rootPid=${rootPid}`);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.warn(`[shell-kill] PowerShell 进程树 kill 失败 rootPid=${rootPid}: ${msg}`);
  }
}

/** Windows：按监听端口终止 dev server（pnpm/vite 脱离 cmd 进程树时的兜底） */
export function killProcessesOnPortWindows(port: number): void {
  try {
    execFileSync(
      'powershell',
      [
        '-NoProfile',
        '-NonInteractive',
        '-Command',
        `$p=${port};Get-NetTCPConnection -LocalPort $p -State Listen -ErrorAction SilentlyContinue `
          + '| Select-Object -ExpandProperty OwningProcess -Unique '
          + '| ForEach-Object { Stop-Process -Id $_ -Force -ErrorAction SilentlyContinue }',
      ],
      { windowsHide: true, stdio: 'pipe' },
    );
    console.log(`[shell-kill] 已按端口 ${port} 终止监听进程`);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.warn(`[shell-kill] 按端口 ${port} 终止失败: ${msg}`);
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

/** 终止 shell 子进程及其 OS 进程树（含 Windows 端口兜底）。 */
export function killShellProcessTree(
  rootPid: number | null,
  child?: ChildProcess | null,
  detectedPort?: number | null,
): void {
  const pid = rootPid ?? child?.pid ?? null;
  if (process.platform === 'win32') {
    if (pid) {
      killWindowsProcessTree(pid);
      if (isPidAlive(pid)) {
        console.warn(`[shell-kill] rootPid=${pid} 仍存活，尝试按端口兜底`);
      }
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
