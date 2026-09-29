// Dev utility (read-only): identifies which process and working directory is
// serving a given local port. Explains a tunnel that points at a different
// application than the one you edited. Changes nothing.
import { execFileSync } from 'node:child_process';

const port = process.argv[2] || '3001';

const ps = (args) => {
  try {
    return execFileSync('powershell.exe', ['-NoProfile', '-Command', args], { encoding: 'utf8' });
  } catch (error) {
    return `(command failed: ${error.message})`;
  }
};

console.log(`=== listeners on port ${port} ===`);
console.log(ps(
  `Get-NetTCPConnection -State Listen -LocalPort ${port} | ` +
  'Select-Object -First 5 LocalAddress,LocalPort,OwningProcess | Format-Table -AutoSize | Out-String -Width 120',
));

console.log('=== owning process ===');
console.log(ps(
  `$c = Get-NetTCPConnection -State Listen -LocalPort ${port} | Select-Object -First 1; ` +
  'if ($c) { Get-CimInstance Win32_Process -Filter ("ProcessId=" + $c.OwningProcess) | ' +
  'Select-Object ProcessId,Name,CommandLine | Format-List | Out-String -Width 400 } else { "no listener" }',
));

console.log('=== what it serves ===');
try {
  const response = await fetch(`http://localhost:${port}/`, { headers: { 'ngrok-skip-browser-warning': '1' } });
  const body = await response.text();
  const title = (body.match(/<title>([^<]*)<\/title>/) || [])[1] || '(no title)';
  console.log(`status ${response.status} · ${body.includes('portal-tabs') ? 'NEW design' : 'OLD design'} · ${title}`);
} catch (error) {
  console.log(`error: ${error.message}`);
}
