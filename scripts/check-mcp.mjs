import fs from 'node:fs';

const cfg = JSON.parse(fs.readFileSync('.iceCoder/mcp.json', 'utf8'));
const p = cfg.mcpServers.puppeteer;
const env = p.env || {};
const launch = JSON.parse(env.PUPPETEER_LAUNCH_OPTIONS || '{}');

console.log('executable :', env.PUPPETEER_EXECUTABLE_PATH);
console.log('allowDangerous env:', env.ALLOW_DANGEROUS);
console.log('headless           :', launch.headless);
console.log('args               :', launch.args);
console.log('ignoreHTTPSErrors  :', launch.ignoreHTTPSErrors);

const must = [
  '--ignore-certificate-errors',
  '--ignore-urlfetcher-cert-requests',
  '--allow-running-insecure-content',
  '--disable-web-security',
  '--no-sandbox',
];
const missing = must.filter((a) => !(launch.args || []).includes(a));
if (missing.length) {
  console.error('MISSING args:', missing);
  process.exit(1);
}
if (env.ALLOW_DANGEROUS !== 'true') {
  console.error('ALLOW_DANGEROUS must be "true"');
  process.exit(1);
}
if (launch.ignoreHTTPSErrors !== true) {
  console.error('ignoreHTTPSErrors must be true');
  process.exit(1);
}
console.log('OK: puppeteer MCP will always skip cert checks');
