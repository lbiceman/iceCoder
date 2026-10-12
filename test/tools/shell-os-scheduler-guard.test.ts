import { afterEach, describe, expect, it } from 'vitest';
import os from 'node:os';
import { createShellTool } from '../../src/tools/builtin/shell-tool.js';
import {
  OS_SCHEDULER_GUARD_MESSAGE,
  checkOsSchedulerCommand,
  enableOsSchedulerGuard,
  isOsSchedulerCreateCommand,
} from '../../src/tools/shell-os-scheduler-guard.js';

describe('isOsSchedulerCreateCommand', () => {
  it.each([
    'schtasks /create /sc hourly /tn Backup /tr "python backup.py"',
    'SCHTASKS.EXE /Create /SC DAILY /TN x /TR y',
    'schtasks -create -sc minute -tn x -tr y',
    'Register-ScheduledTask -TaskName x -Action $a -Trigger $t',
    'powershell -Command "Register-ScheduledJob -Name x -ScriptBlock { 1 }"',
    '(crontab -l; echo "0 * * * * /usr/bin/backup") | crontab -',
    'crontab mycron.txt',
    'crontab -e',
    'crontab -u bob newcron',
    'echo "*/5 * * * * root run.sh" > /etc/cron.d/run',
    'sudo sh -c \'echo "0 9 * * * x" >> /etc/crontab\'',
    'launchctl load ~/Library/LaunchAgents/com.x.plist',
    'launchctl bootstrap gui/501 com.x.plist',
    'systemctl --user enable --now backup.timer',
  ])('detects %s', (cmd) => {
    expect(isOsSchedulerCreateCommand(cmd)).toBe(true);
  });

  it.each([
    'schtasks /query /fo LIST',
    'schtasks /delete /tn Backup /f',
    'Get-ScheduledTask',
    'crontab -l',
    'crontab -r',
    'crontab -u bob -l',
    'cat /etc/crontab',
    'launchctl list',
    'systemctl list-timers',
    'npm run build',
    'grep -r "schtasks" src',
  ])('ignores %s', (cmd) => {
    expect(isOsSchedulerCreateCommand(cmd)).toBe(false);
  });
});

describe('checkOsSchedulerCommand', () => {
  let disposers: Array<() => void> = [];

  afterEach(() => {
    for (const dispose of disposers) dispose();
    disposers = [];
  });

  const cmd = 'schtasks /create /sc hourly /tn Backup /tr "python backup.py"';

  it('does nothing while the guard is disabled (CLI)', () => {
    expect(checkOsSchedulerCommand(cmd, 's1')).toBeNull();
  });

  it('blocks the first attempt and lets the identical retry through', () => {
    disposers.push(enableOsSchedulerGuard());
    expect(checkOsSchedulerCommand(cmd, 's1')).toBe(OS_SCHEDULER_GUARD_MESSAGE);
    expect(checkOsSchedulerCommand(`  ${cmd} `, 's1')).toBeNull();
  });

  it('tracks retries per session and per command', () => {
    disposers.push(enableOsSchedulerGuard());
    expect(checkOsSchedulerCommand(cmd, 's1')).not.toBeNull();
    expect(checkOsSchedulerCommand(cmd, 's2')).not.toBeNull();
    expect(checkOsSchedulerCommand(`${cmd} /f`, 's1')).not.toBeNull();
  });

  it('never blocks unrelated commands', () => {
    disposers.push(enableOsSchedulerGuard());
    expect(checkOsSchedulerCommand('npm test', 's1')).toBeNull();
  });

  it('stays enabled until every enable call is disposed', () => {
    const a = enableOsSchedulerGuard();
    const b = enableOsSchedulerGuard();
    a();
    a();
    expect(checkOsSchedulerCommand(cmd, 's3')).not.toBeNull();
    b();
    expect(checkOsSchedulerCommand(`${cmd} /ru SYSTEM`, 's3')).toBeNull();
  });

  it('is enforced by run_command in foreground and background before anything runs', async () => {
    disposers.push(enableOsSchedulerGuard());
    const tool = createShellTool(os.tmpdir(), 'guard-shell-session');
    // 带一个不存在的可执行名，万一放行也不会真的建计划任务
    const fg = 'schtasks-not-real /create /tn ice-guard-test /tr x || schtasks /create /tn ice-guard-test';
    const fgRes = await tool.handler({ command: fg, background: false });
    expect(fgRes).toMatchObject({ success: false, error: OS_SCHEDULER_GUARD_MESSAGE });
    const bg = 'Register-ScheduledTask -TaskName ice-guard-test-bg';
    const bgRes = await tool.handler({ command: bg, background: true });
    expect(bgRes).toMatchObject({ success: false, error: OS_SCHEDULER_GUARD_MESSAGE });
  });

  it('notifies the host on block so the session gets scheduled_task next turn', () => {
    const blocked: string[] = [];
    disposers.push(enableOsSchedulerGuard({ onBlocked: (sid) => blocked.push(sid) }));
    checkOsSchedulerCommand(cmd, 's-notify');
    checkOsSchedulerCommand(cmd, 's-notify');
    checkOsSchedulerCommand('npm test', 's-notify');
    expect(blocked).toEqual(['s-notify']);
  });

  it('points the model at the scheduled_task tool', () => {
    expect(OS_SCHEDULER_GUARD_MESSAGE).toContain('scheduled_task');
    expect(OS_SCHEDULER_GUARD_MESSAGE).toContain('re-run exactly the same command');
    expect(OS_SCHEDULER_GUARD_MESSAGE).toContain('available on their next message');
  });
});
