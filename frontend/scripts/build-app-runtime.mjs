// Builds the code-form runtime into public/app-runtime/: runtime.js (React, the
// SDK, the app's UI components, charts, icons) and runtime.css (base styles and
// tokens). Every code form's sandboxed frame loads these two files.
//   npm run build:runtime   (also runs before dev and build)
import { build } from "esbuild";
import { execFileSync } from "node:child_process";
import { mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const out = resolve(root, "public/app-runtime");
mkdirSync(out, { recursive: true });

const t = Date.now();
await build({
  entryPoints: [resolve(root, "app-runtime/index.tsx")],
  bundle: true,
  outfile: resolve(out, "runtime.js"),
  format: "iife",
  platform: "browser",
  target: "es2020",
  jsx: "automatic",
  minify: true,
  legalComments: "none",
  alias: { "@": resolve(root, "src") },
  define: { "process.env.NODE_ENV": '"production"', "process.env.NEXT_PUBLIC_API_BASE_URL": '""' },
  logLevel: "warning",
});

execFileSync(process.execPath, [resolve(root, "node_modules/tailwindcss/lib/cli.js"), "-c", resolve(root, "tailwind.runtime.config.ts"), "-i", resolve(root, "src/index.css"), "-o", resolve(out, "runtime.css"), "--minify"], { cwd: root, stdio: ["ignore", "ignore", "inherit"] });
console.log(`App runtime built in ${Date.now() - t} ms → public/app-runtime/`);
