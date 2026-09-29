// Structural guard for the stylesheet.
//
// A single unclosed rule does not break only itself: the browser keeps reading
// until the next `}`, so every following rule is silently re-parented or
// dropped. That is how a whole application can render unstyled while a naive
// count of `{` against `}` still looks fine - a net-zero mismatch hides a
// misplaced brace. This reports the exact line of every unmatched brace and
// flags any non-empty line sitting at depth 0 that is not a selector, at-rule
// or comment (an escaped declaration, which the parser discards silently).
import { readFileSync } from "node:fs";

const file = process.argv[2] || "frontend/css/app.css";
const lines = readFileSync(file, "utf8").split(/\r?\n/);

const opens = [];
const problems = [];
let depth = 0;
let inComment = false;

const isSelectorish = (line) =>
  /^[[\]*.\w#:>+~(-]/.test(line) || line.startsWith("@") || line.startsWith(":root") || line.startsWith("*");

lines.forEach((raw, index) => {
  const line = raw.trim();
  const lineNo = index + 1;
  const before = depth;

  if (inComment) {
    if (raw.includes("*/")) inComment = false;
    return; // braces inside a comment are not syntax
  }
  if (line.startsWith("/*") && !raw.includes("*/")) inComment = true;
  if (line.startsWith("/*") || line.endsWith("*/")) return;

  // Check the line against the depth it starts at, before its own braces land.
  if (before === 0 && line && line !== "}" && line !== ";" && !line.endsWith(",") && !isSelectorish(line)) {
    problems.push(`line ${lineNo}: escaped declaration outside any rule -> "${line.slice(0, 70)}"`);
  }

  for (const ch of line) {
    if (ch === "{") {
      depth += 1;
      opens.push(lineNo);
    } else if (ch === "}") {
      depth -= 1;
      if (depth < 0) {
        problems.push(`line ${lineNo}: unmatched "}" (closes nothing)`);
        depth = 0;
        opens.length = 0;
      } else {
        opens.pop();
      }
    }
  }

  if (line === "}" && before === 0) {
    problems.push(`line ${lineNo}: unmatched "}" (closes nothing)`);
  }
});

for (const lineNo of opens) {
  problems.push(`line ${lineNo}: "{" is never closed`);
}

if (problems.length) {
  console.log("STRUCTURAL PROBLEMS:");
  for (const p of problems) console.log("  " + p);
  process.exitCode = 1;
} else {
  console.log(`CSS_STRUCTURE_OK (${lines.length} lines, nesting balanced)`);
}
