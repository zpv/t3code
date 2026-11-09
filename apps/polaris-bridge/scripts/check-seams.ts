// @effect-diagnostics nodeBuiltinImport:off globalConsole:off - Standalone Node CLI checks files and prints results.
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";

const root = NodePath.resolve(import.meta.dirname, "../../..");
const manifest = await NodeFSP.readFile(NodePath.resolve(root, "docs/polaris/SEAMS.md"), "utf8");
const rows = [...manifest.matchAll(/^\|\s*`([^`]+)`\s*\|\s*`([^`]+)`\s*\|\s*.+?\s*\|\s*$/gm)];
if (rows.length === 0) throw new Error("No seams found in docs/polaris/SEAMS.md");
let missing = false;
for (const row of rows) {
  const file = row[1]!;
  const marker = row[2]!;
  try {
    if ((await NodeFSP.readFile(NodePath.resolve(root, file), "utf8")).includes(marker)) continue;
  } catch {
    // Missing files are reported alongside missing markers.
  }
  console.error(`Missing seam: ${file} (${marker})`);
  missing = true;
}
if (missing) process.exitCode = 1;
else console.log(`All ${rows.length} Polaris seams present.`);
