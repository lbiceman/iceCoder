#!/usr/bin/env node
/**
 * rebuild-server-native.cjs
 * 将 server-bundle 中的原生模块（node-pty）重编译为 Electron 内置 Node 的 ABI。
 *
 * 桌面端以 ELECTRON_RUN_AS_NODE 启动 server-bundle，须与 desktop/node_modules/electron 版本一致。
 * 若本机无 C++ 原生编译工具链（Windows 上通常为 VS「使用 C++ 的桌面开发」），则跳过 rebuild，
 * 不阻断桌面打包；/shell PTY 在 Electron 环境下需安装工具链后重新 build:desktop:server。
 * Windows 上默认将 node-pty 的 SpectreMitigation 设为 false，避免 MSB8040（无需安装 Spectre 库）。
 *
 * 开发者文档：docs/使用文档.md §桌面打包（Electron）
 *
 * 用法: node desktop/scripts/rebuild-server-native.cjs
 */
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const desktopRoot = path.resolve(__dirname, '..');
const serverBundle = path.join(desktopRoot, 'server-bundle');
const electronPkgPath = path.join(desktopRoot, 'node_modules', 'electron', 'package.json');
const rebuildCli = path.join(desktopRoot, 'node_modules', '@electron', 'rebuild', 'lib', 'cli.js');

function log(msg) {
  process.stdout.write(`[rebuild-server-native] ${msg}\n`);
}

function warn(msg) {
  process.stderr.write(`[rebuild-server-native] ${msg}\n`);
}

function resolveNodeGypFindVisualStudio() {
  const candidates = [
    path.join(desktopRoot, 'node_modules', 'node-gyp', 'lib', 'find-visualstudio.js'),
    path.join(desktopRoot, 'node_modules', '@electron', 'node-gyp', 'lib', 'find-visualstudio.js'),
  ];
  for (const candidate of candidates) {
    if (fs.existsSync(candidate)) return candidate;
  }
  return null;
}

function commandExists(command, args = ['--version']) {
  const result = spawnSync(command, args, {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    shell: process.platform === 'win32',
  });
  return result.status === 0;
}

function hasWindowsSdkPackage(packages) {
  return packages.some((pkg) => {
    const win10 = 'Microsoft.VisualStudio.Component.Windows10SDK.';
    const win11 = 'Microsoft.VisualStudio.Component.Windows11SDK.';
    if (!pkg.startsWith(win10) && !pkg.startsWith(win11)) return false;
    const parts = pkg.split('.');
    if (parts.length > 5 && parts[5] !== 'Desktop') return false;
    return !Number.isNaN(parseInt(parts[4], 10));
  });
}

function diagnoseWindowsVsInstall() {
  const findVSPath = resolveNodeGypFindVisualStudio();
  if (!findVSPath) return null;

  const csFile = path.join(path.dirname(findVSPath), 'Find-VisualStudio.cs');
  const ps = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
  const cmd = `Add-Type -Path '${csFile.replace(/'/g, "''")}'; [VisualStudioConfiguration.Main]::PrintJson()`;
  const out = spawnSync(ps, ['-ExecutionPolicy', 'Unrestricted', '-NoProfile', '-Command', cmd], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  if (out.status !== 0 || !out.stdout) return null;

  let installs;
  try {
    installs = JSON.parse(out.stdout);
  } catch {
    return null;
  }
  if (!Array.isArray(installs) || installs.length === 0) return null;

  const preferred =
    installs.find((item) => String(item.version || '').startsWith('17.')) ||
    installs[0];
  const packages = preferred.packages || [];
  const hasToolset = packages.some(
    (pkg) => pkg === 'Microsoft.VisualStudio.Component.VC.Tools.x86.x64',
  );
  const hasSdk = hasWindowsSdkPackage(packages);

  return {
    path: preferred.path,
    version: preferred.version,
    hasToolset,
    hasSdk,
  };
}

function findVisualStudioAsync() {
  const findVSPath = resolveNodeGypFindVisualStudio();
  if (!findVSPath) {
    return Promise.resolve({
      ok: false,
      platform: 'win32',
      summary: 'node-gyp find-visualstudio 不可用',
    });
  }

  const findVisualStudio = require(findVSPath);
  let npmlog;
  let prevLevel;
  try {
    npmlog = require('npmlog');
    prevLevel = npmlog.level;
    npmlog.level = 'silent';
  } catch {
    npmlog = null;
  }

  const configMsvs =
    process.env.GYP_MSVS_VERSION ||
    process.env.npm_config_msvs_version ||
    undefined;

  return new Promise((resolve) => {
    findVisualStudio(process.version, configMsvs, (err, info) => {
      if (npmlog) npmlog.level = prevLevel;
      if (err || !info) {
        const diagnosis = diagnoseWindowsVsInstall();
        let summary = '未找到可用于 node-gyp 的 Visual Studio 安装';
        if (diagnosis?.hasToolset && !diagnosis.hasSdk) {
          summary = `VS2022 已装 MSVC，但缺少 Windows 10/11 SDK（${diagnosis.path}）`;
        } else if (diagnosis && !diagnosis.hasToolset) {
          summary = `Visual Studio 已安装，但缺少 VC++ 工具集（${diagnosis.path}）`;
        }
        resolve({
          ok: false,
          platform: 'win32',
          summary,
          diagnosis,
          detail: err && err.message ? err.message : undefined,
        });
        return;
      }
      resolve({
        ok: true,
        platform: 'win32',
        summary: `Visual Studio ${info.versionYear} (${info.path})`,
        info,
      });
    });
  });
}

async function detectNativeBuildToolchain() {
  if (process.platform === 'win32') {
    return findVisualStudioAsync();
  }

  if (process.platform === 'darwin') {
    const xcodePath = spawnSync('xcode-select', ['-p'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    if (xcodePath.status === 0 && xcodePath.stdout.trim()) {
      return {
        ok: true,
        platform: 'darwin',
        summary: `Xcode CLI (${xcodePath.stdout.trim()})`,
      };
    }
    if (commandExists('clang++')) {
      return { ok: true, platform: 'darwin', summary: 'clang++' };
    }
    return {
      ok: false,
      platform: 'darwin',
      summary: '未找到 Xcode Command Line Tools 或 clang++',
    };
  }

  if (commandExists('g++')) {
    return { ok: true, platform: process.platform, summary: 'g++' };
  }
  if (commandExists('clang++')) {
    return { ok: true, platform: process.platform, summary: 'clang++' };
  }
  return {
    ok: false,
    platform: process.platform,
    summary: '未找到 g++ 或 clang++',
  };
}

function logSkipNoToolchain(toolchain) {
  warn('');
  warn('SKIP: 未检测到可用于编译 node-pty 的原生 C++ 工具链');
  if (toolchain.summary) {
    warn(`  原因: ${toolchain.summary}`);
  }
  if (process.platform === 'win32') {
    if (toolchain.diagnosis?.hasToolset && !toolchain.diagnosis.hasSdk) {
      warn('  补装: Visual Studio Installer → 修改 VS2022 →「单个组件」');
      warn('        搜索并勾选「Windows 11 SDK (10.0.xxxxx)」或「Windows 10 SDK」');
      warn('        （不是「Windows Performance Toolkit」；需带版本号的完整 SDK）');
    } else {
      warn('  Windows: 请安装 Visual Studio 2022，并勾选工作负载「使用 C++ 的桌面开发」');
    }
    if (process.env.VCTargetsPath && process.env.VCTargetsPath.includes('v140')) {
      warn('  提示: 环境变量 VCTargetsPath 指向旧版 v140，可能干扰编译；可在新终端执行:');
      warn('        Remove-Item Env:VCTargetsPath');
    }
    warn('  文档: https://github.com/nodejs/node-gyp#on-windows');
  } else if (process.platform === 'darwin') {
    warn('  macOS: 请运行 xcode-select --install 安装 Xcode Command Line Tools');
  } else {
    warn('  Linux: 请安装 build-essential / g++ 等原生编译依赖');
  }
  warn('  桌面安装包仍会继续打包；/shell 交互协管在 Electron 内置 Node 下可能不可用');
  warn('  安装工具链后重新执行 npm run build:desktop:server 即可编入 node-pty');
  warn('  CLI / 开发服务器仍可用 npm run smoke:node-pty 验证（系统 Node ABI）');
  warn('');
}

function patchNodePtySpectreMitigation(nodePtyDir) {
  const gypFiles = [
    path.join(nodePtyDir, 'binding.gyp'),
    path.join(nodePtyDir, 'deps', 'winpty', 'src', 'winpty.gyp'),
  ];
  let patched = 0;
  for (const file of gypFiles) {
    if (!fs.existsSync(file)) continue;
    const original = fs.readFileSync(file, 'utf8');
    const updated = original.replace(
      /(['"])SpectreMitigation\1:\s*['"]Spectre['"]/g,
      "'SpectreMitigation': 'false'",
    );
    if (updated !== original) {
      fs.writeFileSync(file, updated, 'utf8');
      patched += 1;
    }
  }
  if (patched > 0) {
    log(`patched node-pty SpectreMitigation in ${patched} gyp file(s) (avoid MSB8040).`);
  }
  const buildDir = path.join(nodePtyDir, 'build');
  if (fs.existsSync(buildDir)) {
    fs.rmSync(buildDir, { recursive: true, force: true });
  }
}

async function main() {
  const nodePtyDir = path.join(serverBundle, 'node_modules', 'node-pty');
  if (!fs.existsSync(nodePtyDir)) {
    log('SKIP: node-pty not in server-bundle (run copy-server-artifacts first)');
    return;
  }

  if (!fs.existsSync(electronPkgPath)) {
    throw new Error('desktop/node_modules/electron missing — run npm install in desktop/');
  }
  if (!fs.existsSync(rebuildCli)) {
    throw new Error('desktop/node_modules/@electron/rebuild missing — run npm install in desktop/');
  }

  const toolchain = await detectNativeBuildToolchain();
  if (!toolchain.ok) {
    logSkipNoToolchain(toolchain);
    log('skipped node-pty rebuild (no native toolchain).');
    return;
  }

  const electronVersion = JSON.parse(fs.readFileSync(electronPkgPath, 'utf8')).version;
  log(`native toolchain: ${toolchain.summary}`);
  log(`electron=${electronVersion} module=node-pty target=${serverBundle}`);

  if (process.platform === 'win32') {
    patchNodePtySpectreMitigation(nodePtyDir);
  }

  const rebuildEnv = { ...process.env };
  if (rebuildEnv.VCTargetsPath && rebuildEnv.VCTargetsPath.includes('v140')) {
    delete rebuildEnv.VCTargetsPath;
  }

  const result = spawnSync(
    process.execPath,
    [rebuildCli, `--version=${electronVersion}`, '-f', '-w', 'node-pty', '-m', serverBundle],
    { cwd: desktopRoot, stdio: 'inherit', env: rebuildEnv },
  );

  if (result.status !== 0) {
    throw new Error(
      `@electron/rebuild exited with code ${result.status ?? 'unknown'}. ` +
        '已检测到原生工具链，但 node-pty 重编译失败；请查看上方 node-gyp 日志。' +
        ' 若见 MSB8040/Spectre，可在 VS Installer 单个组件中安装「MSVC v143 Spectre-mitigated libs」。',
    );
  }

  log('done.');
}

if (require.main === module) {
  main().catch((err) => {
    process.stderr.write(`[rebuild-server-native] FAILED: ${err && err.stack || err}\n`);
    process.exit(1);
  });
}

module.exports = {
  main,
  detectNativeBuildToolchain,
  logSkipNoToolchain,
};
