'use strict';

/**
 * 打进 npm tgz / Electron server-bundle 的 data 下静态文件清单。
 * skills 目录仅包含「创建技能.md」模板；其余技能为用户本地数据，不打包。
 *
 * 须与根 package.json 的 "files" 中 data/* 项保持一致（见 test/cli/bundled-data-files.test.ts）。
 */
const BUNDLED_DATA_FILES = [
  'data/config.example.json',
  'data/supervisor-config.example.json',
  'data/skills/创建技能.md',
  'data/system-prompt.md',
];

/** skills 目录内唯一允许打包的文件（相对 data/skills/） */
const BUNDLED_SKILL_FILE = '创建技能.md';

module.exports = {
  BUNDLED_DATA_FILES,
  BUNDLED_SKILL_FILE,
};
