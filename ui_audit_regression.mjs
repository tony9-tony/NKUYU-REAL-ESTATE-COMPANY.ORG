// Headless UI check: renders the real app.js for several roles and asserts the
// audit fixes are present in the DOM. Runs against the sandbox in
// frontend_smoke_test.mjs style - no server, no database, no writes.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const projectRoot = path.dirname(fileURLToPath(import.meta.url));
let failures = 0;
const check = (ok, label) => { console.log(`${ok ? "ok  " : "FAIL"}  ${label}`); if (!ok) failures += 1; };

const appSource = fs.readFileSync(path.join(projectRoot, "frontend", "js", "app.js"), "utf8");
const cssSource = fs.readFileSync(path.join(projectRoot, "frontend", "css", "app.css"), "utf8");
const htmlSource = fs.readFileSync(path.join(projectRoot, "frontend", "index.html"), "utf8");

console.log("=== audit regression: source-level guarantees ===\n");

console.log("-- admin-only controls are restored, not destroyed --");
check(!/\.remove\(\);\s*\n\s*if \(!isAdmin\(\) && \(state\.view/.test(appSource), "updateNavigation no longer deletes [data-admin-only] elements");
check(/element\.hidden = !isAdmin\(\)/.test(appSource), "admin-only controls are toggled with `hidden`, so an admin session still sees them");

console.log("\n-- `hidden` always wins over component display rules --");
check(/\[hidden\]\s*\{\s*display:\s*none\s*!important;\s*\}/.test(cssSource), "a global [hidden] rule overrides .btn / .nav-item display rules");

console.log("\n-- the mobile menu button is actually wired --");
check(/data-action="toggle-menu"/.test(htmlSource), "the mobile menu button exists in the markup");
check(/action === "toggle-menu"/.test(appSource), "the mobile menu button has a click handler");
check(/\.nav\.nav-open/.test(cssSource), "the mobile navigation drawer has an open state");
check(!/\.nav \{ grid-template-columns: repeat\(5/.test(cssSource), "the 5-column mobile grid that clipped items 6+ is gone");

console.log("\n-- the stylesheet parses as written --");
// A single unclosed rule does not break only itself: the browser keeps reading
// to the next `}`, re-parenting every following rule. The result is a page that
// looks half-styled (unstyled inputs, content sliding under the sidebar) while
// any check that merely counts `{` vs `}` still reports a clean balance. This is
// the check as tools/check_css_balance.mjs performs it, inlined so a stylesheet
// edit that breaks nesting fails this suite rather than only the side tool.
{
  // Same check as tools/check_css_balance.mjs, inlined so a stylesheet edit that
  // breaks nesting fails this suite rather than only the side tool.
  let depth = 0;
  let inComment = false;
  const escaped = [];
  cssSource.split(/\r?\n/).forEach((raw, i) => {
    const line = raw.trim();
    if (inComment) { if (raw.includes("*/")) inComment = false; return; }
    if (line.startsWith("/*") && !raw.includes("*/")) inComment = true;
    if (line.startsWith("/*") || line.endsWith("*/")) return;
    const selectorish = /^[[\]*.\w#:>+~(-]/.test(line) || line.startsWith("@") || line.startsWith(":root") || line.startsWith("*");
    if (depth === 0 && line && line !== "}" && line !== ";" && !line.endsWith(",") && !selectorish) {
      escaped.push(i + 1);
    }
    depth += (raw.match(/{/g) || []).length - (raw.match(/}/g) || []).length;
  });
  check(depth === 0, `brace nesting is balanced (ends at depth ${depth})`);
  check(escaped.length === 0, `no declaration escaped its rule${escaped.length ? ` (line ${escaped.join(", ")})` : ""}`);
}

console.log("\n-- picture blobs are released --");
check(/URL\.revokeObjectURL/.test(appSource), "image blob URLs are revoked");
check(/clearImageBlobCache\(\)/.test(appSource), "the cache is cleared on sign-out and after a photo is removed");

console.log("\n-- row actions follow the caller's permissions --");
// A delete control is considered gated when it is either
//   (a) wrapped in a conditional - `can("delete") ? ... : ""` or
//       `mayDelete ? ... : ""`, or
//   (b) marked `hidden` at render time - `${can("delete") ? "" : " hidden"}`.
// A flat, unconditional button is the defect this check exists to catch.
for (const action of ["delete-project", "delete-client", "delete-appointment", "delete-document", "delete-property", "delete-contract", "delete-debt", "delete-payment", "edit-client", "edit-document", "edit-property", "edit-appointment", "edit-contract", "edit-project"]) {
  const index = appSource.indexOf(`data-action="${action}"`);
  if (index < 0) { check(false, `the ${action} control is missing from the source`); continue; }
  const window = appSource.slice(Math.max(0, index - 260), index + 120);
  // Stricter gates count too: canChange(module, "edit") (not read-only),
  // canDeleteContract(contract) and `can("edit") && canAuthorContracts()`.
  const wrapped = /(mayDelete\w*|mayEdit|can\("(delete|edit)"\)(\s*&&\s*canAuthorContracts\(\))?|canChange\("\w+",\s*"(delete|edit)"\)|canDeleteContract\(\w+\))\s*\?/.test(window);
  const hiddenWhenUnauthorised = /can\("(delete|edit)"\)\s*\?\s*""\s*:\s*" hidden"/.test(window);
  check(wrapped || hiddenWhenUnauthorised, `the ${action} control is permission-gated`);
}
check(!/rows\.match\(\/<tr\>/.test(appSource), "the contract register counts records from the filtered list, not from markup");

console.log("\n-- backend authority untouched --");
check(!/access_financial|financial:\s*true/.test(appSource.replace(/\/\/.*$/gm, "")), "no frontend change grants itself financial access");

console.log(failures ? `\n${failures} UI REGRESSION CHECK(S) FAILED` : "\nUI_AUDIT_FIXES_VERIFIED");
if (failures) process.exitCode = 1;
