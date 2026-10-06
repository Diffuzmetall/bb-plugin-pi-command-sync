import { readFileSync, writeFileSync } from "node:fs";
const source = readFileSync(new URL("../runtime/commands.ts", import.meta.url), "utf8");
writeFileSync(new URL("../extension-source.ts", import.meta.url),
  "// Generated from runtime/commands.ts; keep both files in the package.\nexport const extensionSource = " + JSON.stringify(source) + ";\n");
