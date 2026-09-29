// Keeps the files the browser and the server must share identical.
//   backend/src/forms/engine.ts      → frontend/src/lib/formEngine.ts   (form rules)
//   frontend/tailwind.theme.ts       → backend/src/apps/tailwindTheme.ts (design tokens for code forms' CSS)
//   backend/src/apps/sdk.d.ts        → frontend/public/app-runtime/lcs-sdk.d.ts (code-form SDK types)
//                                    → backend/src/apps/sdkText.ts (the same, as a string the server serves)
// `--check` exits 1 when a copy is out of date (for CI).
//   npm run sync:engine      write the copies
//   npm run check:engine     verify they match
import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const NL = String.fromCharCode(10);
const CRLF = String.fromCharCode(13) + NL;
const unix = (s) => s.split(CRLF).join(NL);
const banner = (from) => "// GENERATED from " + from + " by `npm run sync:engine` (backend). Do not edit here." + NL;

const COPIES = [
  ["backend/src/forms/engine.ts", "frontend/src/lib/formEngine.ts", (from, text) => banner(from) + text],
  ["frontend/tailwind.theme.ts", "backend/src/apps/tailwindTheme.ts", (from, text) => banner(from) + text],
  ["backend/src/apps/sdk.d.ts", "frontend/public/app-runtime/lcs-sdk.d.ts", (from, text) => banner(from) + text],
  ["backend/src/apps/sdk.d.ts", "backend/src/apps/sdkText.ts", (from, text) => banner(from) + "export const SDK_TYPES = " + JSON.stringify(text) + ";" + NL],
];

const check = process.argv.includes("--check");
let stale = 0;
for (const [from, to, make] of COPIES) {
  const src = resolve(root, from);
  if (!existsSync(src)) continue;
  const want = make(from, unix(readFileSync(src, "utf8")));
  const dest = resolve(root, to);
  if (check) {
    const have = existsSync(dest) ? unix(readFileSync(dest, "utf8")) : "";
    if (have !== want) {
      console.error(to + " is out of date. Run: npm run sync:engine (in backend/)");
      stale++;
    }
  } else {
    mkdirSync(dirname(dest), { recursive: true });
    writeFileSync(dest, want);
    console.log("Wrote " + to);
  }
}
if (check && stale) process.exit(1);
if (check) console.log("Shared copies match.");
