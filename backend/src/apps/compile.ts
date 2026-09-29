import crypto from "node:crypto";
import * as esbuild from "esbuild";
import postcss from "postcss";
import tailwindcss from "tailwindcss";
import { frameTheme, framePlugin } from "./tailwindTheme.js";
import { readManifest, serverEntry, type FileProblem, type Files } from "./project.js";

/**
 * Compile a code form: each page to a self-contained script for the sandboxed
 * frame, the server code to a script for the server sandbox, and the styles
 * (Tailwind with the app's own tokens, plus any .css) to one stylesheet.
 *
 * Imports are resolved from the project's own files. The only packages are the
 * ones the runtime provides (see sdk.d.ts); they're wired to globals rather
 * than bundled, so a page is a few KB and the frame shares one cached runtime.
 */

export interface Build {
  hash: string;
  pages: Record<string, string>;
  server: string | null;
  css: string;
  warnings: FileProblem[];
}

export type BuildResult = { ok: true; build: Build } | { ok: false; problems: FileProblem[]; warnings: FileProblem[] };

/** Packages a page can import, and the runtime global each maps to (window.LCS.modules[name]). */
const PAGE_MODULES = new Set(["react", "react/jsx-runtime", "react-dom", "react-dom/client", "@lcs/sdk", "@lcs/ui", "@lcs/charts", "lucide-react"]);
const SERVER_MODULES = new Set(["@lcs/server"]);

const cache = new Map<string, Build>();

export function projectHash(files: Files) {
  const h = crypto.createHash("sha256");
  for (const k of Object.keys(files).sort()) h.update(k).update("\0").update(files[k]).update("\0");
  return h.digest("hex").slice(0, 16);
}

function normalize(path: string) {
  const out: string[] = [];
  for (const part of path.split("/")) {
    if (part === "" || part === ".") continue;
    if (part === "..") out.pop();
    else out.push(part);
  }
  return out.join("/");
}

function dirOf(path: string) {
  const i = path.lastIndexOf("/");
  return i < 0 ? "" : path.slice(0, i);
}

const EXTS = ["", ".tsx", ".ts", ".jsx", ".js", ".json", "/index.tsx", "/index.ts", "/index.js"];

function projectPlugin(files: Files, allowed: Set<string>, globalExpr: string): esbuild.Plugin {
  return {
    name: "lcs-project",
    setup(b) {
      b.onResolve({ filter: /.*/ }, (args) => {
        if (args.kind === "entry-point") return { path: args.path, namespace: "proj" };
        if (args.path.startsWith(".") || args.path.startsWith("/")) {
          const base = args.path.startsWith("/") ? args.path.slice(1) : normalize(`${dirOf(args.importer)}/${args.path}`);
          for (const ext of EXTS) {
            const p = normalize(base + ext);
            if (files[p] !== undefined) return { path: p, namespace: "proj" };
          }
          return { errors: [{ text: `Can't find ${args.path} (from ${args.importer}).` }] };
        }
        if (allowed.has(args.path)) return { path: args.path, namespace: "lcs-global" };
        return {
          errors: [{ text: `"${args.path}" isn't available. Code forms can import ${[...allowed].join(", ")} and their own files.` }],
        };
      });
      b.onLoad({ filter: /.*/, namespace: "lcs-global" }, (args) => ({
        contents: `module.exports = ${globalExpr}[${JSON.stringify(args.path)}];`,
        loader: "js",
      }));
      b.onLoad({ filter: /.*/, namespace: "proj" }, (args) => {
        if (args.path.startsWith("__entry__/")) return { contents: files[args.path], loader: "tsx", resolveDir: "" };
        const src = files[args.path];
        if (src === undefined) return { errors: [{ text: `Missing file ${args.path}` }] };
        const ext = args.path.split(".").pop()!;
        const loader: esbuild.Loader = ext === "css" ? "empty" : ext === "json" ? "json" : ext === "ts" ? "ts" : ext === "jsx" ? "jsx" : ext === "js" ? "js" : "tsx";
        return { contents: src, loader };
      });
    },
  };
}

function toProblems(msgs: esbuild.Message[]): FileProblem[] {
  return msgs.map((m) => ({ file: (m.location?.file ?? "").replace(/^proj:/, ""), line: m.location?.line, column: m.location?.column, message: m.text }));
}

async function bundle(files: Files, entry: string, allowed: Set<string>, globalExpr: string, target: string) {
  try {
    const res = await esbuild.build({
      entryPoints: [entry],
      bundle: true,
      write: false,
      format: "iife",
      platform: "neutral",
      target,
      jsx: "automatic",
      jsxImportSource: "react",
      minify: false,
      sourcemap: "inline",
      sourcesContent: false,
      logLevel: "silent",
      mainFields: ["module", "main"],
      plugins: [projectPlugin(files, allowed, globalExpr)],
    });
    return { code: res.outputFiles[0].text, warnings: toProblems(res.warnings), errors: [] as FileProblem[] };
  } catch (e) {
    const failure = e as esbuild.BuildFailure;
    if (failure.errors) return { code: "", warnings: toProblems(failure.warnings ?? []), errors: toProblems(failure.errors) };
    throw e;
  }
}

/** Tailwind utilities for every class the project's sources use, with the app's theme. Base styles come from the runtime. */
async function buildCss(files: Files): Promise<{ css: string; problems: FileProblem[] }> {
  const sources = Object.entries(files).filter(([p]) => /\.(tsx?|jsx?)$/.test(p));
  const own = Object.entries(files).filter(([p]) => p.endsWith(".css"));
  try {
    const result = await postcss([
      tailwindcss({
        darkMode: "class",
        content: sources.map(([p, raw]) => ({ raw, extension: p.split(".").pop()! })),
        theme: frameTheme,
        plugins: [framePlugin],
        corePlugins: { preflight: false },
      }),
    ]).process(`@tailwind components;\n@tailwind utilities;\n${own.map(([p, c]) => `/* ${p} */\n${c}`).join("\n")}`, { from: undefined });
    return { css: result.css, problems: [] };
  } catch (e) {
    return { css: "", problems: [{ file: own[0]?.[0] ?? "styles.css", message: e instanceof Error ? e.message : String(e) }] };
  }
}

export async function buildProject(files: Files): Promise<BuildResult> {
  const hash = projectHash(files);
  const hit = cache.get(hash);
  if (hit) return { ok: true, build: hit };

  const { manifest, problems } = readManifest(files);
  if (!manifest) return { ok: false, problems, warnings: [] };

  const all: FileProblem[] = [];
  const warnings: FileProblem[] = [];
  const pages: Record<string, string> = {};
  const withEntries: Files = { ...files };
  // Each page, plus its per-device views ("record@tablet").
  const targets = manifest.pages.flatMap((p) => [
    { key: p.id, file: p.file },
    ...Object.entries(p.views ?? {}).filter(([, f]) => f).map(([kind, f]) => ({ key: `${p.id}@${kind}`, file: f as string })),
  ]);
  for (const t of targets) {
    const entry = `__entry__/${t.key.replace("@", "--")}.tsx`;
    withEntries[entry] = `import Page from ${JSON.stringify(`/${t.file}`)};\nwindow.LCS.mount(Page);\n`;
    const r = await bundle(withEntries, entry, PAGE_MODULES, "window.LCS.modules", "es2020");
    all.push(...r.errors);
    warnings.push(...r.warnings);
    pages[t.key] = r.code;
  }

  let server: string | null = null;
  const serverFile = serverEntry(files, manifest);
  if (serverFile) {
    const entry = "__entry__/server.ts";
    withEntries[entry] = `import def from ${JSON.stringify(`/${serverFile}`)};\nglobalThis.__serverDef = def;\n`;
    const r = await bundle(withEntries, entry, SERVER_MODULES, "globalThis.__lcsModules", "es2020");
    all.push(...r.errors);
    warnings.push(...r.warnings);
    server = r.code;
  }

  const css = await buildCss(files);
  all.push(...css.problems);
  if (all.length) return { ok: false, problems: all, warnings };

  const build: Build = { hash, pages, server, css: css.css, warnings };
  cache.set(hash, build);
  if (cache.size > 50) cache.delete(cache.keys().next().value!);
  return { ok: true, build };
}
