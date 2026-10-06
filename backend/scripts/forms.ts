/**
 * Build forms from files — the "form as code" workflow.
 *
 * Keep a form as a JSON file in the repo (forms/<slug>.json), edit it in any
 * editor (point "$schema" at /api/builder/json-schema for autocomplete), and
 * push it. Runs against whatever DATABASE_URL points at, like the other scripts.
 *
 *   npm run forms -- list
 *   npm run forms -- validate ../forms/intake.json
 *   npm run forms -- push ../forms/intake.json [--publish] [--slug intake] [--note "what changed"]
 *   npm run forms -- pull intake [../forms/intake.json] [--live]
 *   npm run forms -- import gravityforms-export.json [--publish]
 *   npm run forms -- export intake other-form [--entries] > bundle.json
 *
 * Code forms (a folder per form, e.g. ../forms/hot-foods-code/):
 *   npm run forms -- app:pull hot-foods-code [../forms/hot-foods-code]   files + lcs-sdk.d.ts + tsconfig for type-checking
 *   npm run forms -- app:push ../forms/hot-foods-code [--slug x] [--publish] [--note "…"]
 *   npm run forms -- app:build ../forms/hot-foods-code                   compile locally, print errors
 *
 * Backup (services/formBackup.ts) — every built form, both kinds, plus the catalog:
 *   npm run forms -- backup                       push to FORM_BACKUP_REPO through the GitHub API (FORM_BACKUP_TOKEN)
 *   npm run forms -- backup --dir <clone> [--commit] [--push]   write into a local clone of the repo; commit / push with your git login
 *   npm run forms -- backup:restore <clone> [slug ...] [--publish]   load forms back (creates missing ones, replaces drafts)
 */
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { basename, dirname, join, relative, resolve } from "node:path";
import os from "node:os";
import { prisma } from "../src/prisma.js";
import { parseFormDoc } from "../src/forms/schema.js";
import { DocError, createForm, exportForms, importPayload, listForms, publishForm, readDoc, saveDraft, toSlug } from "../src/forms/service.js";
import { ProjectError, createProject, draftFiles, publishProject, saveProject } from "../src/apps/service.js";
import { buildProject } from "../src/apps/compile.js";
import { SDK_TYPES } from "../src/apps/sdkText.js";
import { execFileSync } from "node:child_process";
import { backupConfigured, backupSnapshot, commitMessage, pushToGitHub } from "../src/services/formBackup.js";
import { collectionPut } from "../src/apps/runtime.js";

/** Files in a code form folder that are tooling, not the form. */
const LOCAL_ONLY = new Set(["lcs-sdk.d.ts", "tsconfig.json"]);

function readProjectDir(dir: string): Record<string, string> {
  const files: Record<string, string> = {};
  const walk = (d: string) => {
    for (const name of readdirSync(d)) {
      if (name === "node_modules" || name.startsWith(".")) continue;
      const full = join(d, name);
      if (statSync(full).isDirectory()) walk(full);
      else {
        const rel = relative(dir, full).split("\\").join("/");
        if (!LOCAL_ONLY.has(rel) && /\.(tsx?|jsx?|css|json|md|txt)$/.test(rel)) files[rel] = readFileSync(full, "utf8");
      }
    }
  };
  walk(dir);
  return files;
}

const args = process.argv.slice(2);
const flag = (name: string) => args.includes(`--${name}`);
const option = (name: string) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : undefined;
};
/** Everything that isn't a flag or the value of --slug / --note. */
const positional = args.filter((a, i) => !a.startsWith("--") && !["--slug", "--note", "--dir"].includes(args[i - 1]));
const actor = { id: null, name: `CLI (${os.userInfo().username})` };

function readJson(file: string) {
  return JSON.parse(readFileSync(file, "utf8"));
}

async function main() {
  const [cmd, ...rest] = positional;
  switch (cmd) {
    case "list": {
      const forms = await listForms({ includeArchived: true });
      for (const f of forms) console.log(`${f.slug.padEnd(32)} ${f.status.padEnd(10)} v${f.liveVersion}  ${f.entryCount} entries  ${f.title}`);
      if (!forms.length) console.log("No built forms yet.");
      return;
    }
    case "validate": {
      const res = parseFormDoc(readJson(rest[0]));
      if (res.doc) console.log(`OK — ${res.doc.fields.length} fields.`);
      else {
        for (const p of res.problems) console.error(`  ${p.path || "(document)"}: ${p.message}`);
        process.exitCode = 1;
      }
      return;
    }
    case "push": {
      const file = rest[0];
      if (!file) throw new Error("push needs a file.");
      const doc = readJson(file);
      const slug = option("slug") ?? toSlug(basename(file).replace(/\.(lcsform\.)?json$/i, ""));
      const existing = await prisma.builtForm.findUnique({ where: { slug } });
      let row = existing ? await saveDraft(existing.id, { doc }, actor) : await createForm({ doc, slug }, actor);
      console.log(`${existing ? "Updated" : "Created"} /f/${row.slug} (draft revision ${row.revision}).`);
      if (flag("publish")) {
        row = await publishForm(row.id, actor, option("note"));
        console.log(`Published version ${row.liveVersion}.`);
      }
      return;
    }
    case "pull": {
      const [slug, out] = rest;
      const row = await prisma.builtForm.findUnique({ where: { slug } });
      if (!row) throw new Error(`No form /f/${slug}.`);
      const json = flag("live") ? row.liveSchema : row.draftSchema;
      if (!json) throw new Error("That form has never been published.");
      const text = JSON.stringify({ $schema: "http://localhost:4200/api/builder/json-schema", ...readDoc(json) }, null, 2) + "\n";
      const dest = out ?? `../forms/${slug}.json`;
      writeFileSync(dest, text);
      console.log(`Wrote ${dest}`);
      return;
    }
    case "import": {
      const res = await importPayload(readJson(rest[0]), actor, { publish: flag("publish"), withEntries: flag("entries") });
      for (const c of res.created) console.log(`Created /f/${c.slug}  ${c.title}${c.entries ? ` (${c.entries} entries)` : ""}`);
      for (const f of res.failed) {
        console.error(`Failed: ${f.title}`);
        for (const p of f.problems) console.error(`  ${p.path}: ${p.message}`);
      }
      for (const w of res.warnings) console.warn(`! ${w}`);
      return;
    }
    case "export": {
      const rows = await prisma.builtForm.findMany({ where: { slug: { in: rest } }, select: { id: true } });
      if (!rows.length) throw new Error("No matching forms.");
      process.stdout.write(JSON.stringify(await exportForms(rows.map((r) => r.id), { entries: flag("entries") }), null, 2) + "\n");
      return;
    }
    case "app:pull": {
      const [slug, out] = rest;
      const row = await prisma.builtForm.findFirst({ where: { slug, kind: "code" } });
      if (!row) throw new Error(`No code form ${slug}.`);
      const dir = resolve(out ?? `../forms/${slug}`);
      for (const [path, src] of Object.entries(draftFiles(row))) {
        mkdirSync(dirname(join(dir, path)), { recursive: true });
        writeFileSync(join(dir, path), src);
      }
      writeFileSync(join(dir, "lcs-sdk.d.ts"), SDK_TYPES);
      // Point React / icon types at the frontend's installed packages so the editor type-checks.
      const fe = relative(dir, resolve("../frontend/node_modules")).split("\\").join("/");
      writeFileSync(join(dir, "tsconfig.json"), JSON.stringify({
        compilerOptions: {
          target: "ES2020", module: "ESNext", moduleResolution: "Bundler", jsx: "react-jsx", strict: true, noEmit: true, skipLibCheck: true,
          baseUrl: ".", typeRoots: [`${fe}/@types`], paths: { react: [`${fe}/@types/react`], "react/*": [`${fe}/@types/react/*`], "lucide-react": [`${fe}/lucide-react`] },
        },
        include: ["**/*.ts", "**/*.tsx"],
      }, null, 2) + "\n");
      console.log(`Wrote ${Object.keys(draftFiles(row)).length} files to ${dir} (revision ${row.revision}). Type-check with: npx tsc -p ${relative(process.cwd(), dir)}`);
      return;
    }
    case "app:build": {
      const res = await buildProject(readProjectDir(resolve(rest[0])));
      if (res.ok) console.log(`Builds: pages ${Object.keys(res.build.pages).join(", ")}${res.build.server ? " + server" : ""}.`);
      else {
        for (const p of res.problems) console.error(`  ${p.file}${p.line ? `:${p.line}:${(p.column ?? 0) + 1}` : ""}  ${p.message}`);
        process.exitCode = 1;
      }
      return;
    }
    case "app:push": {
      const dir = resolve(rest[0]);
      if (!existsSync(join(dir, "form.json"))) throw new Error(`${dir} has no form.json.`);
      const files = readProjectDir(dir);
      const slug = option("slug") ?? toSlug(basename(dir));
      const existing = await prisma.builtForm.findFirst({ where: { slug } });
      if (existing && existing.kind !== "code") throw new Error(`/${slug} is a basic form, not a code form.`);
      const res = await buildProject(files);
      if (!res.ok) for (const p of res.problems) console.warn(`  ! ${p.file}${p.line ? `:${p.line}` : ""}  ${p.message}`);
      let row = existing ? await saveProject(existing.id, { files }, actor) : await createProject({ files, slug }, actor);
      console.log(`${existing ? "Updated" : "Created"} /apps/${row.slug} (draft revision ${row.revision}, ${Object.keys(files).length} files)${res.ok ? "" : " — it doesn't build yet"}.`);
      if (flag("publish")) {
        row = await publishProject(row.id, actor, option("note"));
        console.log(`Published version ${row.liveVersion}.`);
      }
      return;
    }
    case "backup": {
      const snap = await backupSnapshot();
      const dirOpt = option("dir");
      if (!dirOpt) {
        if (!backupConfigured()) throw new Error("Set FORM_BACKUP_REPO and FORM_BACKUP_TOKEN (in .env.local), or pass --dir <a clone of the backup repo>.");
        const r = await pushToGitHub(snap, commitMessage(null, snap));
        console.log(r.changed ? `Backed up ${Object.keys(snap).length} files: ${r.url}` : "Nothing changed since the last backup.");
        return;
      }
      const dir = resolve(dirOpt);
      if (!existsSync(join(dir, ".git"))) throw new Error(`${dir} isn't a git clone. git clone the backup repository there first.`);
      // The folder ends up holding exactly the snapshot (apart from .git).
      const old: string[] = [];
      const walk = (d: string) => {
        for (const name of readdirSync(d)) {
          if (d === dir && name === ".git") continue;
          const full = join(d, name);
          if (statSync(full).isDirectory()) walk(full);
          else old.push(relative(dir, full).split("\\").join("/"));
        }
      };
      walk(dir);
      for (const rel of old) if (!(rel in snap)) rmSync(join(dir, rel));
      for (const [rel, text] of Object.entries(snap)) {
        mkdirSync(dirname(join(dir, rel)), { recursive: true });
        const full = join(dir, rel);
        if (!existsSync(full) || readFileSync(full, "utf8") !== text) writeFileSync(full, text);
      }
      console.log(`Wrote ${Object.keys(snap).length} files to ${dir}.`);
      if (flag("commit") || flag("push")) {
        const git = (...a: string[]) => execFileSync("git", ["-C", dir, ...a], { encoding: "utf8" });
        git("add", "-A");
        if (!git("status", "--porcelain").trim()) console.log("Nothing changed since the last backup.");
        else {
          git("commit", "-q", "-m", commitMessage(null, snap));
          console.log("Committed.");
        }
        if (flag("push")) {
          execFileSync("git", ["-C", dir, "push", "-q", "origin", "HEAD"], { stdio: "inherit" });
          console.log("Pushed.");
        }
      }
      return;
    }
    case "backup:restore": {
      const [dirArg, ...only] = rest;
      if (!dirArg) throw new Error("backup:restore needs the backup folder.");
      const dir = resolve(dirArg);
      const want = (slug: string) => !only.length || only.includes(slug);
      let n = 0;
      for (const kind of ["basic", "code"] as const) {
        const root = join(dir, kind);
        if (!existsSync(root)) continue;
        for (const slug of readdirSync(root)) {
          if (!want(slug)) continue;
          const base = join(root, slug);
          const existing = await prisma.builtForm.findUnique({ where: { slug } });
          if (existing && existing.kind !== kind) {
            console.warn(`! ${slug}: on the site it's a ${existing.kind} form — skipped.`);
            continue;
          }
          if (kind === "basic") {
            const doc = readJson(join(base, "form.json"));
            let row = existing ? await saveDraft(existing.id, { doc }, actor) : await createForm({ doc, slug }, actor);
            if (flag("publish")) {
              // Publish what was live, then put the draft back on top.
              if (existsSync(join(base, "live.json"))) row = await saveDraft(row.id, { doc: readJson(join(base, "live.json")) }, actor);
              row = await publishForm(row.id, actor, "Restored from backup");
              if (existsSync(join(base, "live.json"))) row = await saveDraft(row.id, { doc }, actor);
            }
            console.log(`${existing ? "Restored the draft of" : "Created"} /f/${row.slug}${flag("publish") ? ` and published v${row.liveVersion}` : ""}.`);
          } else {
            const files = readProjectDir(base);
            const liveDir = join(base, ".backup", "live");
            let row = existing ? await saveProject(existing.id, { files }, actor) : await createProject({ files, slug }, actor);
            if (flag("publish")) {
              if (existsSync(liveDir)) row = await saveProject(row.id, { files: readProjectDir(liveDir) }, actor);
              row = await publishProject(row.id, actor, "Restored from backup");
              if (existsSync(liveDir)) row = await saveProject(row.id, { files }, actor);
            }
            // A form's own data (settings, lists) comes back only into a form that has none.
            const colDir = join(base, ".backup", "collections");
            const hasData = await prisma.formRecord.count({ where: { formId: row.id } });
            if (existsSync(colDir) && !hasData) {
              for (const file of readdirSync(colDir)) {
                for (const d of readJson(join(colDir, file)) as { id: string; data: unknown }[]) await collectionPut(row.id, file.replace(/\.json$/, ""), d.id, d.data, actor.name);
              }
            }
            console.log(`${existing ? "Restored the draft of" : "Created"} /apps/${row.slug}${flag("publish") ? ` and published v${row.liveVersion}` : ""}.`);
          }
          n++;
        }
      }
      console.log(n ? `Restored ${n} forms. Put new ones on the Forms screen from their editor (catalog.json lists where they were).` : "No forms found to restore.");
      return;
    }
    default:
      console.log(readFileSync(new URL(import.meta.url), "utf8").split("*/")[0]);
  }
}

main()
  .catch((err) => {
    if (err instanceof ProjectError) {
      console.error(err.message);
      for (const p of err.problems) console.error(`  ${p.file}${p.line ? `:${p.line}` : ""}  ${p.message}`);
    } else if (err instanceof DocError) {
      console.error(err.message);
      for (const p of err.problems) console.error(`  ${p.path || "(document)"}: ${p.message}`);
    } else console.error(err instanceof Error ? err.message : err);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
