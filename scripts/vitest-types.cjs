const { execSync } = require('child_process');
try {
  const out = execSync('npx vitest run test/core/types.test.ts', { 
    encoding: 'utf8', 
    stdio: ['pipe', 'pipe', 'pipe'],
    timeout: 20000 
  });
  console.log(out);
  process.exit(0);
} catch (e) {
  if (e.stdout) console.log(e.stdout);
  if (e.stderr) process.stderr.write(e.stderr);
  process.exit(e.status || 1);
}
