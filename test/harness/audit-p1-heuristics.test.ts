/**
 * Harness 审计 P1（#19–#23）回归测试。见 docs/harness/Harness-审计修复清单.md。
 */
import { describe, expect, it } from 'vitest';

import { detectIncompleteForwardSignal } from '../../src/harness/incomplete-task-stop-hook.js';
import { hasUnfulfilledFileDeliverableGoal } from '../../src/harness/document-deliverable.js';
import { looksLikeTaskAmnesia } from '../../src/harness/harness-round-no-tools.js';
import {
  buildVerificationDigest,
  parseBuildErrorSourcePaths,
  parseBuildFailureDigest,
  parseVitestFailureDigest,
} from '../../src/harness/verification-digest.js';
import { classifyRunCommandResult } from '../../src/harness/run-command-result.js';
import { containsExecutableEmbeddedToolCalls } from '../../src/harness/text-format-tool-call-parsers.js';

describe('#19 incomplete-task stop hook only fires on the model\'s own forward commitments', () => {
  it.each([
    '修复完成。还需要注意 Windows 下路径大小写不敏感。',
    'Done. Next step for the user: run npm install.',
    '下一步是你在本地运行 npm install。',
    'This will fix the flaky test.',
    '之前未完成的部分已经全部补齐，npm test 通过。',
    '已更新 README。建议你接下来部署到测试环境。',
  ])('ignores reminders / retrospectives: %s', text => {
    expect(detectIncompleteForwardSignal(text)).toBe(false);
  });

  it.each([
    '我修了一半，接下来我会继续修复剩余的 case。',
    '目前只改了登录页。我还需要修改注册页。',
    'I updated the API. Next, I\'ll update the docs.',
    'Let me fix the remaining type errors.',
    'still need to add deployment section',
    '- 任务尚未完成：缺少迁移脚本',
  ])('detects: %s', text => {
    expect(detectIncompleteForwardSignal(text)).toBe(true);
  });
});

describe('#20 file-deliverable goal needs a file noun or file name', () => {
  it.each([
    '把这个函数放到 utils 目录里',
    '把 parseConfig 放到 config 模块',
    'put the retry logic in the client',
  ])('location verbs alone are not file deliverables: %s', goal => {
    expect(hasUnfulfilledFileDeliverableGoal(goal, [], 'edit')).toBe(false);
  });

  it.each([
    '整理成 md 文档放到桌面',
    '把结果放到 report.json',
    'save the summary to notes.md',
    '导出一个 csv 文件',
  ])('still detects real file deliverables: %s', goal => {
    expect(hasUnfulfilledFileDeliverableGoal(goal, [], 'docs')).toBe(true);
  });

  it('an edit goal that only says 放到 is not a pending file', () => {
    expect(hasUnfulfilledFileDeliverableGoal('实现这次调整：把 parseConfig 放到 config 模块', [], 'edit')).toBe(false);
  });

  it('a file that was already written is not still pending', () => {
    expect(hasUnfulfilledFileDeliverableGoal('整理成 md 文档放到桌面', ['notes.md'], 'docs')).toBe(false);
  });
});

describe('#21 post-compaction amnesia detection', () => {
  it.each([
    '已完成提交。不要忘记推送到远端。',
    'Done. Don\'t forget to restart the server.',
    '修复了忘记关闭文件句柄的问题。',
    'I fixed the bug where the cache forgot expired keys.',
    'All tests pass. What would you like me to do next?',
    '请描述一下复现步骤会更好，不过我已经按日志修复了。',
  ])('ignores: %s', text => {
    expect(looksLikeTaskAmnesia(text)).toBe(false);
  });

  it.each([
    '抱歉，我无法确定当前的任务是什么。',
    '我忘记了之前的任务，能再说一下吗？',
    '请重复一下你的需求？',
    'I\'m not sure what task you want me to continue.',
    'What was the task?',
    'What would you like me to do?',
  ])('detects: %s', text => {
    expect(looksLikeTaskAmnesia(text)).toBe(true);
  });
});

describe('#22 verification output with ANSI colors and Windows paths', () => {
  const red = (s: string) => `\u001b[31m${s}\u001b[39m`;

  it('vitest failure digest sees FAIL lines that start with color codes', () => {
    const output = [
      `${red(' FAIL ')} src/a.test.ts > adds`,
      `${red('AssertionError')}: expected 1 to be 2`,
    ].join('\n');
    const digest = parseVitestFailureDigest(output);
    expect(digest).toContain('Failed suites / cases:');
    expect(digest).toContain('FAIL  src/a.test.ts > adds');
    expect(digest).not.toContain('\u001b');
  });

  it('build digest and verification digest drop color codes', () => {
    const output = `\u001b[96msrc/a.ts\u001b[0m:\u001b[93m3\u001b[0m:\u001b[93m5\u001b[0m - \u001b[91merror\u001b[0m TS2322: Type 'string' is not assignable to type 'number'.`;
    expect(parseBuildFailureDigest(output)).toContain('error TS2322');
    expect(buildVerificationDigest('npx tsc', output)).not.toContain('\u001b');
  });

  it('extracts Windows absolute paths from build errors', () => {
    const output = [
      'C:\\work\\app\\src\\a.ts(3,5): error TS2322: Type mismatch.',
      ' ❯ D:\\proj\\test\\b.test.ts:12:3',
    ].join('\n');
    const paths = parseBuildErrorSourcePaths(output);
    expect(paths).toContain('C:\\work\\app\\src\\a.ts');
    expect(paths).toContain('D:\\proj\\test\\b.test.ts');
  });

  it('still extracts relative paths and a path wrapped in parentheses', () => {
    const paths = parseBuildErrorSourcePaths([
      "error TS2304: Cannot find name 'x' (src/util/parse.ts)",
      'at ./src/index.ts:10:1',
    ].join('\n'));
    expect(paths).toContain('src/util/parse.ts');
    expect(paths).toContain('./src/index.ts');
  });

  it('reads the exit code through color codes', () => {
    const classified = classifyRunCommandResult(
      { command: 'npm test' },
      `Tool execution error: Command failed (exit code: ${red('2')})`,
      false,
    );
    expect(classified).toMatchObject({ kind: 'foreground', foregroundSuccess: false, exitCode: 2 });
  });
});

describe('#23 no-tool recovery only for real embedded calls', () => {
  it('a prose explanation that mentions tool markup is not an embedded call', () => {
    const text = [
      '早期一些模型会把工具调用包在 <tool_call> 标签里写进正文，客户端再自己从文本里解析出工具名和参数；',
      '现在主流服务都改成了原生 function calling，调用会作为结构化字段返回，所以你这边不需要做任何额外配置。',
    ].join('\n');
    expect(containsExecutableEmbeddedToolCalls(text)).toBe(false);
  });

  it('markup-only replies still count even when the call cannot be parsed', () => {
    expect(containsExecutableEmbeddedToolCalls('<tool_call>\n{"name": broken json\n</tool_call>')).toBe(true);
    expect(containsExecutableEmbeddedToolCalls('not parseable [<action>only')).toBe(true);
  });

  it('parseable embedded calls count regardless of surrounding hints', () => {
    expect(containsExecutableEmbeddedToolCalls('<tool_call>{"name":"read_file","arguments":{"path":"a.ts"}}</tool_call>')).toBe(true);
  });
});
