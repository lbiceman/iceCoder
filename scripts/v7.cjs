const { execSync } = require('child_process');
const r = execSync('npx vitest run test/core/types.test.ts', { encoding: 'utf8', stdio: ['pipe','pipe','pipe'], timeout: 20000 });
console.log(r);
