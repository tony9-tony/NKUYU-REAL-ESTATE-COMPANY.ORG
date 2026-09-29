// Prints the tail of a test log plus every FAIL line, so a long run can be
// checked without paging through hundreds of "ok" lines. The shell integration
// truncates long output, so the summary is written to a file and read back.
import { readFileSync } from "node:fs";

const file = process.argv[2];
const tail = Number(process.argv[3] || 25);
const lines = readFileSync(file, "utf8").split(/\r?\n/);

const failures = lines.filter((line) => line.startsWith("FAIL"));
const verdicts = lines.filter((line) => /PASSED|FAILED|VERIFIED|OK$/.test(line.trim()));

console.log(`FILE ${file} (${lines.length} lines)`);
console.log(`FAIL COUNT ${failures.length}`);
for (const line of failures) console.log("  " + line);
console.log("VERDICTS:");
for (const line of verdicts) console.log("  " + line);
console.log(`LAST ${tail} LINES:`);
for (const line of lines.slice(-tail)) console.log("  " + line);
