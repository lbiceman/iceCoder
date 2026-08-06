import { execFileSync } from 'node:child_process';
import path from 'node:path';

const cs = path.join('desktop/node_modules/node-gyp/lib/Find-VisualStudio.cs');
const ps = path.join(process.env.SystemRoot, 'System32/WindowsPowerShell/v1.0/powershell.exe');
const cmd = `Add-Type -Path '${cs.replace(/\\/g, '/')}'; [VisualStudioConfiguration.Main]::PrintJson()`;
const out = execFileSync(ps, ['-ExecutionPolicy', 'Unrestricted', '-NoProfile', '-Command', cmd], {
  encoding: 'utf8',
});
const installs = JSON.parse(out);
for (const vs of installs) {
  const sdkPkgs = vs.packages.filter((p) => /Windows10SDK|Windows11SDK|Win10SDK|Win11SDK/i.test(p));
  console.log(`\n${vs.path} (${vs.version})`);
  console.log(sdkPkgs.length ? sdkPkgs.join('\n') : 'NO Windows10/11 SDK component packages');
}
