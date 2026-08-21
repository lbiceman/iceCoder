/**
 * 同步写文本：内容未变则跳过（避免 Windows 下 Cursor/杀毒锁文件导致 UNKNOWN）。
 * 锁冲突时短暂重试。
 */
'use strict';

const fs = require('node:fs');

const RETRY_CODES = new Set(['UNKNOWN', 'EBUSY', 'EPERM', 'EACCES', 'EAGAIN']);
const MAX_ATTEMPTS = 8;

function sleepSync(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

function writeTextFileIfChanged(target, body) {
  try {
    if (fs.existsSync(target) && fs.readFileSync(target, 'utf8') === body) {
      return false;
    }
  } catch {
    // 读失败则继续写
  }

  let lastErr;
  for (let i = 0; i < MAX_ATTEMPTS; i++) {
    try {
      fs.writeFileSync(target, body, 'utf8');
      return true;
    } catch (err) {
      lastErr = err;
      if (!err || !RETRY_CODES.has(err.code)) throw err;
      sleepSync(50 * (i + 1));
    }
  }
  throw lastErr;
}

module.exports = { writeTextFileIfChanged };
