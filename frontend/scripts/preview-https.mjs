#!/usr/bin/env node
/**
 * The production build over https, for testing offline mode on a real iPad.
 *
 * The dev server on 5443 opens offline too (next.config.mjs), but the
 * production build is what the iPads will run, so it's the faithful test. This:
 *
 *   1. builds the app (`next build`);
 *   2. starts it on http://localhost:5300 (`next start`);
 *   3. puts https in front of it on port 5444 (scripts/dev-https.mjs), with the
 *      same certificate an iPad already trusts for the dev server on 5443.
 *
 * 5444 is a different site to iOS from the dev server's 5443: its own
 * home-screen icon, service worker and stored copies, so the two never mix.
 * Code changes need a rebuild: stop this (Ctrl+C) and run it again.
 *
 *   npm run preview:https               (the backend must be running: npm run dev in backend/)
 *   npm run preview:https -- --no-build (start the last build again)
 */
import { spawn, spawnSync } from "node:child_process";
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const args = process.argv.slice(2);
const APP_PORT = 5300;
const HTTPS_PORT = 5444;
const npx = process.platform === "win32" ? "npx.cmd" : "npx";

if (!args.includes("--no-build")) {
  // `next build` rewrites next-env.d.ts to point at the production types; put it back so git stays clean.
  const envFile = join(root, "next-env.d.ts");
  const envBefore = existsSync(envFile) ? readFileSync(envFile, "utf8") : null;
  console.log("Building the production app…\n");
  const build = spawnSync("npm", ["run", "build"], { cwd: root, stdio: "inherit", shell: true });
  if (envBefore !== null) writeFileSync(envFile, envBefore);
  if (build.status !== 0) process.exit(build.status ?? 1);
}

const children = [
  spawn(npx, ["next", "start", "-p", String(APP_PORT)], { cwd: root, stdio: "inherit", shell: true }),
  spawn(process.execPath, [join(root, "scripts", "dev-https.mjs"), "--target", String(APP_PORT), "--port", String(HTTPS_PORT), "--setup-port", "5481"], { cwd: root, stdio: "inherit" }),
];

const stop = () => {
  for (const c of children) c.kill();
  process.exit(0);
};
process.on("SIGINT", stop);
process.on("SIGTERM", stop);
for (const c of children) c.on("exit", (code) => code && code !== 0 && stop());
