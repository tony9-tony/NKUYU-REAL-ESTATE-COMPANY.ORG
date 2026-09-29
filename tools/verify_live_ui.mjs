// Dev utility: confirms the live server (and optionally the ngrok tunnel) is
// serving the current frontend, and that the expected design markers are in the
// delivered HTML. Read-only: it issues GETs and changes nothing.
import { readFileSync } from 'node:fs';

const LOCAL = process.env.LOCAL_URL || 'http://localhost:3003/';
const TUNNEL = process.env.TUNNEL_URL || 'https://error-unnamable-borrower.ngrok-free.dev/';

let failures = 0;
const check = (ok, label) => { console.log(`${ok ? 'ok  ' : 'FAIL'}  ${label}`); if (!ok) failures += 1; };

async function get(url) {
  try {
    const response = await fetch(url, { headers: { 'ngrok-skip-browser-warning': '1' } });
    return { status: response.status, body: response.ok ? await response.text() : '' };
  } catch (error) {
    return { status: 0, body: '', error: error.message };
  }
}

console.log('=== live frontend delivery ===\n');

const local = await get(LOCAL);
check(local.status === 200, `local server responds 200 (got ${local.status})`);

// The design markers the new markup introduces. Their absence means the browser
// is still being served a stale index.html.
for (const marker of ['portal-tabs', 'topbar-search', 'side-link', 'brand-sub', 'auth-art-badge']) {
  check(local.body.includes(marker), `served HTML contains "${marker}"`);
}
check(!local.body.includes('ambient-orb'), 'the old ambient background is gone from the served HTML');

const css = await get(`${LOCAL}css/app.css`);
check(css.status === 200, `stylesheet responds 200 (got ${css.status})`);
for (const marker of ['--brand-900', '.portal-tabs', '.nav-item.active', '.side-link', '.topbar-search']) {
  check(css.body.includes(marker), `stylesheet defines "${marker}"`);
}
check(!css.body.includes('Playfair'), 'the serif display font is gone from the stylesheet');
check(css.body.includes('[hidden]') && css.body.includes('display: none !important'), 'the [hidden] override that keeps admin controls hidden still exists');

const js = await get(`${LOCAL}js/app.js`);
check(js.status === 200, `app.js responds 200 (got ${js.status})`);
for (const marker of ['setAuthPortal', 'applySearch', 'alertSummary', 'showProfile']) {
  check(js.body.includes(marker), `app.js defines ${marker}()`);
}

const tunnel = await get(TUNNEL);
check(tunnel.status === 200, `ngrok tunnel responds 200 (got ${tunnel.status})`);
if (!tunnel.body.includes('portal-tabs')) {
  // ngrok serves an interstitial warning page to unknown clients; that is a
  // tunnel-level notice, not the application, so report what actually arrived.
  console.log(`\n     tunnel body (first 200 chars): ${JSON.stringify(tunnel.body.slice(0, 200))}`);
}
check(tunnel.body.includes('portal-tabs'), 'the tunnel serves the same new markup');

console.log(failures ? `\n${failures} LIVE DELIVERY CHECK(S) FAILED` : '\nLIVE_DELIVERY_VERIFIED');
if (failures) process.exitCode = 1;
