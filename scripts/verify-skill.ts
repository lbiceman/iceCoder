import { scanSkillFiles } from '../src/skills/skill-loader.js';

const skills = await scanSkillFiles('data/skills');
const target = skills.find(s => s.filename.includes('claudeCode'));
if (!target) {
  console.error('NOT FOUND');
  process.exit(1);
}
console.log(JSON.stringify(target, null, 2));
