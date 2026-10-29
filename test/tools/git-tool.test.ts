import { execFile } from 'node:child_process';
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';

import {
  createGitTool,
  resolveGitExecutable,
  splitGitArgs,
} from '../../src/tools/builtin/git-tool.js';
import type { RegisteredTool, ToolResult } from '../../src/tools/types.js';

delete process.env.GIT_DIR;
delete process.env.GIT_WORK_TREE;
delete process.env.GIT_INDEX_FILE;

const dirs: string[] = [];

afterAll(async () => {
  await Promise.all(dirs.map((dir) => rm(dir, { recursive: true, force: true })));
});

function gitBin(): string {
  return resolveGitExecutable();
}

function execGit(cwd: string, args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(gitBin(), args, {
      cwd,
      windowsHide: true,
      encoding: 'utf8',
      shell: false,
      timeout: 30_000,
    }, (error, stdout, stderr) => {
      if (error) {
        reject(new Error(`${stderr || error.message}\nargv: git ${args.join(' ')}`));
        return;
      }
      resolve(String(stdout ?? ''));
    });
  });
}

async function makeRepo(name: string): Promise<{ dir: string; tool: RegisteredTool }> {
  const dir = await mkdtemp(path.join(tmpdir(), `ice-git-${name}-`));
  dirs.push(dir);
  await execGit(dir, ['init', '-b', 'main']);
  await execGit(dir, ['config', 'core.autocrlf', 'false']);
  await execGit(dir, ['config', 'user.email', 'ice-git-test@example.com']);
  await execGit(dir, ['config', 'user.name', 'Ice Git Test']);
  await execGit(dir, ['config', 'commit.gpgsign', 'false']);
  await execGit(dir, ['config', 'core.quotepath', 'false']);
  const hooks = await mkdtemp(path.join(tmpdir(), 'ice-git-hooks-'));
  dirs.push(hooks);
  await execGit(dir, ['config', 'core.hooksPath', hooks]);
  await writeFile(path.join(dir, 'readme.txt'), 'hello\n', 'utf8');
  await execGit(dir, ['add', 'readme.txt']);
  await execGit(dir, ['commit', '-m', 'init']);
  return { dir, tool: createGitTool(dir) };
}

async function run(tool: RegisteredTool, subcommand: string, args = ''): Promise<ToolResult> {
  return tool.handler({ subcommand, args });
}

function expectOk(result: ToolResult, label: string): void {
  expect(result.success, `${label}\n${result.error || ''}\n${result.output}`).toBe(true);
}

async function exists(filePath: string): Promise<boolean> {
  try {
    await access(filePath);
    return true;
  } catch {
    return false;
  }
}

describe('splitGitArgs', () => {
  it('splits whitespace and keeps quoted text, including Windows paths', () => {
    expect(splitGitArgs('')).toEqual([]);
    expect(splitGitArgs('--oneline -20')).toEqual(['--oneline', '-20']);
    expect(splitGitArgs('-m "hello world"')).toEqual(['-m', 'hello world']);
    expect(splitGitArgs("-m 'hello world'")).toEqual(['-m', 'hello world']);
    expect(splitGitArgs('-- "a b.txt"')).toEqual(['--', 'a b.txt']);
    expect(splitGitArgs('-m ""')).toEqual(['-m', '']);
    expect(splitGitArgs(String.raw`src\foo.ts`)).toEqual([String.raw`src\foo.ts`]);
    expect(splitGitArgs(String.raw`"C:\Users\a"`)).toEqual([String.raw`C:\Users\a`]);
    expect(splitGitArgs('-m "say \\"hi\\""')).toEqual(['-m', 'say "hi"']);
    expect(splitGitArgs('& echo pwned > pwned.txt')).toEqual(['&', 'echo', 'pwned', '>', 'pwned.txt']);
    expect(splitGitArgs('--short\n--branch')).toEqual(['--short', '--branch']);
  });

  it('rejects an unclosed quote and NUL', () => {
    expect(() => splitGitArgs('-m "unterminated')).toThrow(/引号未闭合/);
    expect(() => splitGitArgs('a\0b')).toThrow(/空字符/);
  });
});

describe('git tool policy', () => {
  it('rejects a subcommand that tries to chain a shell command', async () => {
    const { dir, tool } = await makeRepo('policy-sub');
    const marker = path.join(dir, 'pwned.txt');
    const result = await run(tool, 'status & echo pwned > pwned.txt');
    expect(result.success).toBe(false);
    expect(result.error).toContain('不支持的 git 子命令');
    expect(await exists(marker)).toBe(false);
  });

  it('rejects non-string args and an unclosed quote before launching git', async () => {
    const { tool } = await makeRepo('policy-args');
    const badType = await tool.handler({ subcommand: 'status', args: ['--short'] });
    expect(badType.success).toBe(false);
    expect(badType.error).toContain('args 必须是字符串');

    const unclosed = await run(tool, 'commit', '-m "unterminated');
    expect(unclosed.success).toBe(false);
    expect(unclosed.error).toContain('引号未闭合');
  });

  it('rejects interactive rebase and add -i', async () => {
    const { tool } = await makeRepo('policy-i');
    const rebase = await run(tool, 'rebase', '-i HEAD~1');
    expect(rebase.success).toBe(false);
    expect(rebase.error).toContain('不支持交互式操作');

    const add = await run(tool, 'add', '-i');
    expect(add.success).toBe(false);
    expect(add.error).toContain('不支持交互式操作');
  });

  it('rejects force push and still allows --force-with-lease to reach git', async () => {
    const { tool } = await makeRepo('policy-push');
    const forced = await run(tool, 'push', '--force origin main');
    expect(forced.success).toBe(false);
    expect(forced.error).toContain('禁止 force push');

    const short = await run(tool, 'push', '-f');
    expect(short.success).toBe(false);
    expect(short.error).toContain('禁止 force push');

    const lease = await run(tool, 'push', '--force-with-lease');
    expect(lease.error || '').not.toContain('禁止 force push');
  });
});

describe('git tool shell injection', () => {
  const payloads: Array<[string, string]> = [
    ['ampersand', '& echo pwned > pwned.txt'],
    ['and', '&& echo pwned > pwned.txt'],
    ['or', '|| echo pwned > pwned.txt'],
    ['pipe', '| echo pwned > pwned.txt'],
    ['redirect out', '> pwned.txt'],
    ['redirect in', '< pwned.txt'],
    ['newline', '\n& echo pwned > pwned.txt'],
    ['backtick', '`echo pwned > pwned.txt`'],
    ['substitution', '$(echo pwned > pwned.txt)'],
    ['calc', '& calc.exe'],
  ];

  // git status 对不存在的 pathspec 仍会成功，所以不能用退出码判断。
  // 注入若经过 shell，会留下 pwned.txt。
  it.each(payloads)('does not execute shell syntax in args: %s', async (_label, payload) => {
    const { dir, tool } = await makeRepo('inject');
    const marker = path.join(dir, 'pwned.txt');
    const result = await run(tool, 'status', payload);
    expect(await exists(marker), result.output).toBe(false);
    expect(result.output).not.toContain('pwned');
    expect(await readFile(path.join(dir, 'readme.txt'), 'utf8')).toBe('hello\n');
  });

  it('keeps shell metacharacters inside a commit message', async () => {
    const { dir, tool } = await makeRepo('message');
    const message = 'fix & improve | pipes > not redirected';
    await writeFile(path.join(dir, 'note.txt'), 'x\n', 'utf8');
    expectOk(await run(tool, 'add', 'note.txt'), 'add');
    expectOk(await run(tool, 'commit', `-m "${message}"`), 'commit');
    const shown = await run(tool, 'log', '-1 --format=%s');
    expectOk(shown, 'log');
    expect(shown.output).toContain(message);
    expect(await exists(path.join(dir, 'pwned.txt'))).toBe(false);
  });
});

describe('git tool commands', () => {
  it('status, diff, log, show, rev-parse, blame, and branch read the repo', async () => {
    const { dir, tool } = await makeRepo('read');
    await writeFile(path.join(dir, 'readme.txt'), 'hello\nchanged\n', 'utf8');

    const status = await run(tool, 'status');
    expectOk(status, 'status');
    expect(status.output).toContain('[git status]');
    expect(status.output).toContain('## main');
    expect(status.output).toContain('readme.txt');

    const diff = await run(tool, 'diff');
    expectOk(diff, 'diff');
    expect(diff.output).toContain('+changed');
    expect(diff.output).not.toContain('\u001b');

    const stat = await run(tool, 'diff', '--stat');
    expectOk(stat, 'diff --stat');
    expect(stat.output).toContain('readme.txt');
    expect(stat.output).toContain('|');

    const log = await run(tool, 'log');
    expectOk(log, 'log');
    expect(log.output).toContain('init');
    expect(log.output).not.toContain('Author:');

    const shown = await run(tool, 'show', '-s --format=%s HEAD');
    expectOk(shown, 'show');
    expect(shown.output).toContain('init');

    const rev = await run(tool, 'rev-parse', 'HEAD');
    expectOk(rev, 'rev-parse');
    expect(rev.output).toMatch(/[0-9a-f]{40}/);

    const blamed = await run(tool, 'blame', '-L 1,1 readme.txt');
    expectOk(blamed, 'blame');
    expect(blamed.output).toContain('hello');

    const branches = await run(tool, 'branch');
    expectOk(branches, 'branch');
    expect(branches.output).toContain('main');
  });

  it('add, commit, and a path with spaces or backslashes', async () => {
    const { dir, tool } = await makeRepo('add');
    await writeFile(path.join(dir, 'file with space.txt'), 'spaced\n', 'utf8');
    const sub = path.join(dir, 'sub');
    await mkdir(sub, { recursive: true });
    await writeFile(path.join(sub, 'file.txt'), 'nested\n', 'utf8');

    expectOk(await run(tool, 'add', '"file with space.txt"'), 'add quoted');
    expectOk(await run(tool, 'add', String.raw`sub\file.txt`), 'add backslash');
    const staged = await run(tool, 'status');
    expectOk(staged, 'status staged');
    expect(staged.output).toContain('file with space.txt');
    expect(staged.output).toContain('sub/file.txt');

    expectOk(await run(tool, 'commit', '-m "添加带空格的文件"'), 'commit');
    const subject = await run(tool, 'log', '-1 --format=%s');
    expectOk(subject, 'log subject');
    expect(subject.output).toContain('添加带空格的文件');
  });

  it('branch, checkout, and switch', async () => {
    const { tool } = await makeRepo('branch');
    expectOk(await run(tool, 'branch', 'demo'), 'branch demo');
    expectOk(await run(tool, 'checkout', 'demo'), 'checkout');
    const onDemo = await run(tool, 'status');
    expectOk(onDemo, 'status demo');
    expect(onDemo.output).toContain('## demo');

    expectOk(await run(tool, 'switch', '-c topic'), 'switch -c');
    const onTopic = await run(tool, 'status');
    expectOk(onTopic, 'status topic');
    expect(onTopic.output).toContain('## topic');
    expectOk(await run(tool, 'switch', 'main'), 'switch main');
  });

  it('stash and reset', async () => {
    const { dir, tool } = await makeRepo('stash');
    await writeFile(path.join(dir, 'readme.txt'), 'hello\nstashed\n', 'utf8');
    expectOk(await run(tool, 'stash', 'push -m "wip"'), 'stash push');
    const clean = await run(tool, 'status');
    expectOk(clean, 'status clean');
    expect(clean.output).not.toContain('readme.txt');
    expectOk(await run(tool, 'stash', 'pop'), 'stash pop');
    expect(await readFile(path.join(dir, 'readme.txt'), 'utf8')).toContain('stashed');

    await writeFile(path.join(dir, 'extra.txt'), 'extra\n', 'utf8');
    expectOk(await run(tool, 'add', 'extra.txt'), 'add extra');
    expectOk(await run(tool, 'commit', '-m "extra"'), 'commit extra');
    expectOk(await run(tool, 'reset', '--soft HEAD~1'), 'reset');
    const log = await run(tool, 'log', '-1 --format=%s');
    expectOk(log, 'log after reset');
    expect(log.output).toContain('init');
    expect(log.output).not.toContain('extra');
    const status = await run(tool, 'status');
    expectOk(status, 'status after reset');
    expect(status.output).toContain('extra.txt');
  });

  it('tag, remote, and config stay inside the repo', async () => {
    const { dir, tool } = await makeRepo('meta');
    expectOk(await run(tool, 'tag', 'v1.2.3'), 'tag');
    const tags = await run(tool, 'tag', '--list');
    expectOk(tags, 'tag --list');
    expect(tags.output).toContain('v1.2.3');

    const remotePath = path.join(dir, 'not-a-remote');
    expectOk(await run(tool, 'remote', `add origin "${remotePath}"`), 'remote add');
    const remotes = await run(tool, 'remote', '-v');
    expectOk(remotes, 'remote -v');
    expect(remotes.output).toContain('origin');
    expect(remotes.output).toContain('not-a-remote');

    expectOk(await run(tool, 'config', '--local ice.test marker'), 'config write');
    const read = await run(tool, 'config', '--local --get ice.test');
    expectOk(read, 'config read');
    expect(read.output).toContain('marker');
  });

  it('merge, cherry-pick, and rebase', async () => {
    const { dir, tool } = await makeRepo('history');

    expectOk(await run(tool, 'switch', '-c feature'), 'switch feature');
    await writeFile(path.join(dir, 'feature.txt'), 'from-feature\n', 'utf8');
    expectOk(await run(tool, 'add', 'feature.txt'), 'add feature');
    expectOk(await run(tool, 'commit', '-m "feature work"'), 'commit feature');
    const featureHash = (await execGit(dir, ['rev-parse', 'HEAD'])).trim();
    expectOk(await run(tool, 'switch', 'main'), 'switch main');

    await writeFile(path.join(dir, 'main.txt'), 'from-main\n', 'utf8');
    expectOk(await run(tool, 'add', 'main.txt'), 'add main');
    expectOk(await run(tool, 'commit', '-m "main work"'), 'commit main');

    expectOk(await run(tool, 'merge', 'feature --no-edit'), 'merge');
    expect(await readFile(path.join(dir, 'feature.txt'), 'utf8')).toBe('from-feature\n');
    expect(await readFile(path.join(dir, 'main.txt'), 'utf8')).toBe('from-main\n');

    const pick = await makeRepo('pick');
    expectOk(await run(pick.tool, 'switch', '-c side'), 'switch side');
    await writeFile(path.join(pick.dir, 'picked.txt'), 'picked\n', 'utf8');
    expectOk(await run(pick.tool, 'add', 'picked.txt'), 'add picked');
    expectOk(await run(pick.tool, 'commit', '-m "to pick"'), 'commit pick');
    const hash = (await execGit(pick.dir, ['rev-parse', 'HEAD'])).trim();
    expectOk(await run(pick.tool, 'switch', 'main'), 'switch main for pick');
    expectOk(await run(pick.tool, 'cherry-pick', hash), 'cherry-pick');
    expect(await readFile(path.join(pick.dir, 'picked.txt'), 'utf8')).toBe('picked\n');

    const rebaseRepo = await makeRepo('rebase');
    await writeFile(path.join(rebaseRepo.dir, 'base.txt'), 'base\n', 'utf8');
    expectOk(await run(rebaseRepo.tool, 'add', 'base.txt'), 'add base');
    expectOk(await run(rebaseRepo.tool, 'commit', '-m "base"'), 'commit base');
    expectOk(await run(rebaseRepo.tool, 'switch', '-c topic'), 'switch topic');
    await execGit(rebaseRepo.dir, ['reset', '--hard', 'HEAD~1']);
    await writeFile(path.join(rebaseRepo.dir, 'topic.txt'), 'topic\n', 'utf8');
    expectOk(await run(rebaseRepo.tool, 'add', 'topic.txt'), 'add topic');
    expectOk(await run(rebaseRepo.tool, 'commit', '-m "topic"'), 'commit topic');
    expectOk(await run(rebaseRepo.tool, 'rebase', 'main'), 'rebase');
    expect(await readFile(path.join(rebaseRepo.dir, 'base.txt'), 'utf8')).toBe('base\n');
    expect(await readFile(path.join(rebaseRepo.dir, 'topic.txt'), 'utf8')).toBe('topic\n');

    expect(featureHash).toMatch(/[0-9a-f]{40}/);
  });

  it('push, fetch, and pull against a local bare remote', async () => {
    const bare = await mkdtemp(path.join(tmpdir(), 'ice-git-bare-'));
    dirs.push(bare);
    await execGit(bare, ['init', '--bare', '-b', 'main']);

    const local = await makeRepo('push-local');
    expectOk(await run(local.tool, 'remote', `add origin "${bare}"`), 'remote add');
    expectOk(await run(local.tool, 'push', '-u origin main'), 'push');

    const otherDir = await mkdtemp(path.join(tmpdir(), 'ice-git-clone-'));
    dirs.push(otherDir);
    await execGit(otherDir, ['clone', '-c', 'core.autocrlf=false', bare, '.']);
    await execGit(otherDir, ['config', 'core.autocrlf', 'false']);
    await execGit(otherDir, ['config', 'user.email', 'ice-git-test@example.com']);
    await execGit(otherDir, ['config', 'user.name', 'Ice Git Test']);
    await execGit(otherDir, ['config', 'commit.gpgsign', 'false']);
    const other = createGitTool(otherDir);

    await writeFile(path.join(local.dir, 'remote-file.txt'), 'synced\n', 'utf8');
    expectOk(await run(local.tool, 'add', 'remote-file.txt'), 'add remote-file');
    expectOk(await run(local.tool, 'commit', '-m "sync"'), 'commit sync');
    expectOk(await run(local.tool, 'push', 'origin main'), 'push again');

    expectOk(await run(other, 'fetch', 'origin'), 'fetch');
    expectOk(await run(other, 'pull', 'origin main'), 'pull');
    expect(await readFile(path.join(otherDir, 'remote-file.txt'), 'utf8')).toBe('synced\n');
  });

  it('returns a git error outside a repository and does not prefix it', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'ice-git-norepo-'));
    dirs.push(dir);
    const result = await run(createGitTool(dir), 'status');
    expect(result.success).toBe(false);
    expect(result.output.startsWith('[git status]')).toBe(false);
    expect(result.error || '').toMatch(/not a git repository|fatal:/i);
  });
});
