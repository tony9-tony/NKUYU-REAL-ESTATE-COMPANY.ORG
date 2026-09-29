// Dev utility (read-only): reports what the ngrok tunnel is actually forwarding
// to, and which local ports are listening. Used to explain a tunnel that serves
// different content than http://localhost:3003.
import net from 'node:net';

const AGENT = 'http://127.0.0.1:4040';
const TUNNEL = 'https://error-unnamable-borrower.ngrok-free.dev/';

async function agentTunnels() {
  try {
    const response = await fetch(`${AGENT}/api/tunnels`);
    if (!response.ok) return `agent responded ${response.status}`;
    const payload = await response.json();
    return payload.tunnels.map((t) => `${t.name} -> ${t.config.addr} (public ${t.public_url})`).join('\n');
  } catch (error) {
    return `no local ngrok agent on :4040 (${error.message})`;
  }
}

function listening(port) {
  return new Promise((resolve) => {
    const socket = net.connect({ host: '127.0.0.1', port }, () => { socket.destroy(); resolve(true); });
    socket.on('error', () => resolve(false));
    socket.setTimeout(3000, () => { socket.destroy(); resolve(false); });
  });
}

console.log('=== ngrok agent ===');
console.log(await agentTunnels());

console.log('\n=== listening ports ===');
for (const port of [3003, 3177, 4040]) {
  console.log(`${port}: ${await listening(port) ? 'open' : 'closed'}`);
}

console.log('\n=== what each origin serves ===');
for (const [label, url] of [['local  :3003', 'http://localhost:3003/'], ['tunnel        ', TUNNEL]]) {
  try {
    const response = await fetch(url, { headers: { 'ngrok-skip-browser-warning': '1' } });
    const body = await response.text();
    const marker = body.includes('portal-tabs') ? 'NEW design' : 'OLD design';
    const title = (body.match(/<title>([^<]*)<\/title>/) || [])[1] || '(no title)';
    console.log(`${label} -> ${response.status} ${marker} · ${title}`);
  } catch (error) {
    console.log(`${label} -> error: ${error.message}`);
  }
}
