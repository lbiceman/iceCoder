import { spawn } from 'node:child_process';

const node = 'D:\\tools\\node16\\node.exe';
const entry = 'C:\\Users\\tpln\\AppData\\Roaming\\npm\\node_modules\\@modelcontextprotocol\\server-puppeteer\\dist\\index.js';
const env = {
  ...process.env,
  PUPPETEER_EXECUTABLE_PATH: 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  ALLOW_DANGEROUS: 'true',
  PUPPETEER_LAUNCH_OPTIONS: '{"headless":false,"args":["--ignore-certificate-errors","--ignore-urlfetcher-cert-requests","--allow-running-insecure-content","--disable-web-security","--no-sandbox"],"ignoreHTTPSErrors":true}',
};

const proc = spawn(node, [entry], { stdio: ['pipe', 'pipe', 'pipe'], env, windowsHide: true });
let buf = '';
let id = 1;

proc.stdout.on('data', (chunk) => {
  buf += chunk.toString();
  console.log('[stdout]', chunk.toString().slice(0, 500));
});

proc.stderr.on('data', (chunk) => {
  console.log('[stderr]', chunk.toString().slice(0, 500));
});

proc.on('exit', (code, signal) => {
  console.log('[exit]', code, signal);
  process.exit(code ?? 1);
});

function send(method, params) {
  const req = { jsonrpc: '2.0', id: id++, method, params };
  proc.stdin.write(JSON.stringify(req) + '\n');
}

setTimeout(() => {
  console.log('Sending initialize...');
  send('initialize', {
    protocolVersion: '2024-11-05',
    capabilities: {},
    clientInfo: { name: 'test', version: '1.0.0' },
  });
}, 500);

setTimeout(() => {
  console.log('Sending tools/list...');
  send('tools/list', {});
}, 3000);

setTimeout(() => {
  console.log('Done, killing...');
  proc.kill();
  process.exit(0);
}, 15000);
