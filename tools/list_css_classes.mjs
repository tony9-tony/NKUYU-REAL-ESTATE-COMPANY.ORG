// Dev utility: lists every CSS class name the frontend can emit, so a
// stylesheet rewrite can be checked against real usage instead of guesswork.
// With --check it also reports classes the stylesheet never defines.
import { readFileSync } from 'node:fs';

const source = readFileSync(new URL('../frontend/js/app.js', import.meta.url), 'utf8');
const names = new Set();
const add = (raw) => {
  for (const token of String(raw).split(/\s+/)) {
    const name = token.replace(/\$\{[^}]*\}/g, '').trim();
    if (/^[a-zA-Z][\w-]*$/.test(name)) names.add(name);
  }
};

for (const re of [
  /class=["'`]([^"'`]+)["'`]/g,
  /classList\.(?:add|remove|toggle)\(\s*["'`]([\w -]+)["'`]/g,
  /\.(?:className)\s*=\s*["'`]([^"'`]+)["'`]/g,
]) {
  let m;
  while ((m = re.exec(source))) add(m[1]);
}

const html = readFileSync(new URL('../frontend/index.html', import.meta.url), 'utf8');
for (const m of html.matchAll(/class=["'`]([^"'`]+)["'`]/g)) add(m[1]);

if (process.argv.includes('--check')) {
  const css = readFileSync(new URL('../frontend/css/app.css', import.meta.url), 'utf8');
  const defined = new Set([...css.matchAll(/\.([a-zA-Z][\w-]*)/g)].map((m) => m[1]));
  // Classes assembled at runtime, e.g. `badge-${status}`, plus a handful of
  // structural names the app styles through a compound selector.
  const runtimeBuilt = new Set(['badge-']);
  // Local variable names picked up by the class= scan above (e.g. `activeView`,
  // which interpolates into a class attribute but is never a class itself).
  const notClasses = new Set(['activeView']);
  const missing = [...names].filter((n) => !defined.has(n) && !runtimeBuilt.has(n) && !notClasses.has(n)).sort();
  console.log(missing.length ? `UNSTYLED (${missing.length}):\n${missing.join('\n')}` : 'ALL CLASSES STYLED');
} else {
  console.log([...names].sort().join('\n'));
}
console.log('TOTAL', names.size);

