#!/usr/bin/env node
/**
 * Mock SSH + 考试 shell，供 Shell 协作 E2E / 集成测试使用。
 *
 * 流程：
 * 1. 打印 password prompt，从 stdin 读密码（任意非空即可）
 * 2. 进入 exam shell，打印题面「题目：日志与磁盘处理」
 * 3. 接受简单命令（df / du / echo / exit）
 */

import readline from 'node:readline';

const rl = readline.createInterface({ input: process.stdin, output: process.stdout });

process.stdout.write('exam@mock-host\'s password: ');

rl.once('line', (password) => {
  rl.close();
  if (!password || !password.trim()) {
    process.stderr.write('Permission denied.\n');
    process.exit(1);
  }
  process.stdout.write('\nWelcome to Exam Shell (mock)\n');
  process.stdout.write('题目：日志与磁盘处理\n');
  process.stdout.write('Type commands; "exit" to quit.\n');

  const cmdRl = readline.createInterface({ input: process.stdin, output: process.stdout });
  const prompt = () => {
    cmdRl.question('exam$ ', (line) => {
      const cmd = (line || '').trim();
      if (!cmd) {
        prompt();
        return;
      }
      if (cmd === 'exit' || cmd === 'quit') {
        cmdRl.close();
        process.exit(0);
      }
      if (cmd.startsWith('df')) {
        process.stdout.write('Filesystem      Size  Used Avail Use% Mounted on\n');
        process.stdout.write('/dev/mock0       20G   15G  4.0G  79% /\n');
        process.stdout.write('tmpfs           1.0G     0  1.0G   0% /tmp\n');
      } else if (cmd.startsWith('du')) {
        process.stdout.write('120M\t/var/log/syslog\n');
        process.stdout.write('80M\t/var/log/app.log\n');
      } else {
        process.stdout.write(`mock: ${cmd}\n`);
      }
      prompt();
    });
  };
  prompt();
});
