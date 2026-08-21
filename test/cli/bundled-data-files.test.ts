import { createRequire } from 'node:module';
import { describe, expect, it } from 'vitest';

import pkg from '../../package.json' with { type: 'json' };

const require = createRequire(import.meta.url);
const { BUNDLED_DATA_FILES, BUNDLED_SKILL_FILES } = require('../../scripts/bundled-data-files.cjs') as {
  BUNDLED_DATA_FILES: string[];
  BUNDLED_SKILL_FILES: string[];
};

describe('bundled-data-files', () => {
  it('package.json files 中的 data 项与打包清单一致', () => {
    const fromPkg = (pkg.files as string[]).filter((f) => f.startsWith('data/')).sort();
    expect(fromPkg).toEqual([...BUNDLED_DATA_FILES].sort());
  });

  it('skills 打包清单仅包含创建技能模板', () => {
    const skillFiles = BUNDLED_DATA_FILES.filter((f) => f.startsWith('data/skills/'));
    expect(skillFiles.sort()).toEqual(
      BUNDLED_SKILL_FILES.map((file) => `data/skills/${file}`).sort(),
    );
    expect(skillFiles).toEqual(['data/skills/创建技能.md']);
  });
});
