'use strict';

/**
 * 打进 npm tgz / Electron server-bundle 的 data 下静态文件清单。
 * skills 只打包默认模板；agents 只打包默认 plan。其余为用户本地数据，不打包。
 *
 * 须与根 package.json 的 "files" 中 data/* 项保持一致（见 test/cli/bundled-data-files.test.ts）。
 */
const BUNDLED_DATA_FILES = [
  'data/agents/plan.json',
  'data/config.example.json',
  'data/skills/创建Agent.md',
  'data/skills/创建技能.md',
  'data/system-prompt.md',
];

/** skills 目录内允许打包的文件（相对 data/skills/） */
const BUNDLED_SKILL_FILES = [
  '创建Agent.md',
  '创建技能.md',
];

/** agents 目录内允许打包的文件（相对 data/agents/） */
const BUNDLED_AGENT_FILES = [
  'plan.json',
];

module.exports = {
  BUNDLED_DATA_FILES,
  BUNDLED_SKILL_FILES,
  BUNDLED_AGENT_FILES,
};
