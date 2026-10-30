import crypto from "node:crypto";
import { prisma } from "../prisma.js";
import { appBaseUrl, env } from "../env.js";
import { HttpError, badRequest } from "../http.js";
import { audit, type Actor } from "./audit.js";
import { createForm, publishForm, saveDraft } from "../forms/service.js";
import { ProjectError, createProject, publishProject, saveProject } from "../apps/service.js";
import { buildProject } from "../apps/compile.js";
import { saveComponent } from "../apps/components.js";

/**
 * Backup of every form built in the app — form builder forms and code forms —
 * to a git repository (FORM_BACKUP_REPO, e.g. Lantern-Community-Services/lcs_forms_form_backup),
 * shared by every copy of the site (prod, Azure dev, local).
 *
 * Each form has ONE folder there, holding the newest definition any site saved
 * (draft + published). A site writes a form's folder only when its own copy
 * changed since it last matched the backup, so it never puts an older version
 * over a newer one from another site. What each site last matched is kept in
 * sites/<site>/sync.json. A form whose backup moved on while this site's copy
 * didn't "needs sync": Admin → Form builder / Code forms can pull it in (Sync,
 * Sync all). One changed on both sides "differs": an admin picks which wins.
 *
 * Site-specific things live under sites/<site>/: the Forms catalog, each form's
 * status and published versions, a code form's collections (its settings and
 * lists). Not kept: entries, uploaded files, people.
 *
 * Two ways out:
 *   - The server, every 10 minutes, through the GitHub API (FORM_BACKUP_TOKEN, a
 *     token that can write that one repository). No git needed on the server.
 *   - `npm run forms -- backup --dir <clone>` from a computer, through its own git login.
 * `npm run forms -- backup:restore <dir>` loads forms back from a copy of the repository.
 */

export type Snapshot = Record<string, string>;
type Kind = "basic" | "code" | "component";

const json = (v: unknown) => `${JSON.stringify(v, null, 2)}\n`;
const iso = (d: Date | null | undefined) => (d ? d.toISOString() : null);

const README = `# Lantern Forms — form backup

Written automatically by every Lantern Forms site (prod, Azure dev, local). Don't edit files
here by hand.

    basic/<slug>/form.json         a form builder form (draft) — the lcs-form document
    basic/<slug>/live.json         its published version, when it has one
    basic/<slug>/info.json         title, which site saved it and when

    code/<slug>/…                  a code form's files (draft): form.json, pages/, server/, …
    code/<slug>/.backup/live/…     the published files, when it has been published
    code/<slug>/.backup/info.json

    sites/<site>/catalog.json                      that site's Forms screen
    sites/<site>/forms/<kind>/<slug>/info.json     the form's status there, its catalog card
    sites/<site>/forms/<kind>/<slug>/versions/     every version published there
    sites/<site>/forms/code/<slug>/collections/    a code form's own data there (settings, lists)
    sites/<site>/sync.json                         what that site last matched (don't edit)

Each form folder holds the newest version any site saved. A site only writes a form when
its own copy changed since it last matched this repository, so an older copy never
replaces a newer one. When the backup is newer, the site's Form builder / Code forms list
marks the form "Needs sync"; Sync brings it in.

Entries (what people submitted) and uploaded photos are not here — they stay in each
site's database and its own backups.

## Restoring

From the site's backend folder, with DATABASE_URL pointing at the database to restore into:

    npm run forms -- backup:restore <path to this repository> [slug ...] [--publish] [--site <site>]

It creates missing forms and replaces drafts of existing ones; --publish also publishes
the backed-up live version; --site brings back that site's code-form data.
`;

/** Folder of a form in the backup: "basic/<slug>" or "code/<slug>". */
export const formKey = (kind: string, slug: string) => `${kind === "code" ? "code" : "basic"}/${slug}`;
const sharedInfoPath = (key: string) => (key.startsWith("code/") ? `${key}/.backup/info.json` : `${key}/info.json`);

/** What a backup folder holds, from its key: "basic/<slug>", "code/<slug>" or "components/<name>". */
const kindOf = (key: string): Kind => (key.startsWith("code/") ? "code" : key.startsWith("components/") ? "component" : "basic");

/** Is this path (inside a form's folder) part of the form's definition — what's compared between sites? */
function isDefinition(kind: Kind, rel: string) {
  if (kind === "basic") return rel === "form.json" || rel === "live.json";
  if (kind === "component") return rel !== "info.json";
  return !rel.startsWith(".backup/") || rel.startsWith(".backup/live/");
}

/** This site's name in the backup (sites/<site>/, "saved from …"). FORM_BACKUP_SITE, else the site's host. */
export function backupSite() {
  let name = env.formBackup.site;
  if (!name) {
    try {
      name = new URL(appBaseUrl).host;
    } catch {
      name = "local";
    }
  }
  return name.toLowerCase().replace(/[^a-z0-9.-]+/g, "-");
}

/** Git's id for a file's content, so files can be compared without downloading them. */
export const blobSha = (text: string) => {
  const body = Buffer.from(text, "utf8");
  return crypto.createHash("sha1").update(`blob ${body.length}\0`).update(body).digest("hex");
};

/** One value for a form's definition files ({ path inside its folder: blob sha }); null when it has none. */
function fingerprint(files: Map<string, string>) {
  if (!files.size) return null;
  const lines = [...files].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)).map(([p, s]) => `${p} ${s}`);
  return crypto.createHash("sha256").update(lines.join("\n")).digest("hex");
}

// ── What this site has ───────────────────────────────────────────────────

interface SiteForm {
  key: string;
  kind: Kind;
  slug: string;
  title: string;
  updatedAt: Date;
  /** More for the shared info.json (a form's status, live version). */
  info: Record<string, unknown>;
  /** The definition, by path inside the form's folder. */
  def: Snapshot;
}

/** Every form on this site, and the site's own files (under sites/<site>/, without sync.json). */
async function readSite(): Promise<{ forms: Map<string, SiteForm>; files: Snapshot }> {
  const prefix = `sites/${backupSite()}`;
  const files: Snapshot = {};
  const [forms, versions, records, categories, cards, components] = await Promise.all([
    prisma.builtForm.findMany({ orderBy: { slug: "asc" } }),
    prisma.builtFormVersion.findMany({ orderBy: [{ formId: "asc" }, { version: "asc" }] }),
    prisma.formRecord.findMany({ orderBy: [{ formId: "asc" }, { collection: "asc" }, { docId: "asc" }] }),
    prisma.formCategory.findMany({ orderBy: { sortOrder: "asc" } }),
    prisma.formLink.findMany({ orderBy: [{ categoryId: "asc" }, { sortOrder: "asc" }] }),
    prisma.uiComponent.findMany({ orderBy: { name: "asc" } }),
  ]);
  const catName = new Map(categories.map((c) => [c.id, c.name]));
  const cardOf = new Map(cards.map((c) => [c.id, c]));
  const out = new Map<string, SiteForm>();

  for (const f of forms) {
    const kind: Kind = f.kind === "code" ? "code" : "basic";
    const key = formKey(kind, f.slug);
    const card = f.catalogLinkId ? cardOf.get(f.catalogLinkId) : null;
    const mine = versions.filter((v) => v.formId === f.id);
    const def: Snapshot = {};
    if (kind === "code") {
      for (const [path, src] of Object.entries((JSON.parse(f.draftSchema) as { files: Snapshot }).files)) def[path] = src;
      if (f.liveSchema) for (const [path, src] of Object.entries((JSON.parse(f.liveSchema) as { files: Snapshot }).files)) def[`.backup/live/${path}`] = src;
    } else {
      def["form.json"] = json(JSON.parse(f.draftSchema));
      if (f.liveSchema) def["live.json"] = json(JSON.parse(f.liveSchema));
    }
    out.set(key, { key, kind, slug: f.slug, title: f.title, updatedAt: f.updatedAt, info: { status: f.status, liveVersion: f.liveVersion, publishedAt: iso(f.publishedAt) }, def });

    const base = `${prefix}/forms/${key}`;
    files[`${base}/info.json`] = json({
      id: f.id,
      slug: f.slug,
      kind,
      title: f.title,
      status: f.status,
      liveVersion: f.liveVersion,
      createdByName: f.createdByName,
      createdAt: iso(f.createdAt),
      publishedAt: iso(f.publishedAt),
      catalog: card ? { category: catName.get(card.categoryId) ?? null, title: card.title, active: card.active } : null,
      versions: mine.map((v) => ({ version: v.version, note: v.note, publishedByName: v.publishedByName, publishedAt: iso(v.createdAt) })),
    });
    for (const v of mine) files[`${base}/versions/v${v.version}.json`] = json(JSON.parse(v.schema));
    if (kind === "code") {
      const byCollection = new Map<string, { id: string; data: unknown; updatedByName: string | null }[]>();
      for (const r of records.filter((r) => r.formId === f.id)) {
        byCollection.set(r.collection, [...(byCollection.get(r.collection) ?? []), { id: r.docId, data: JSON.parse(r.data), updatedByName: r.updatedByName }]);
      }
      for (const [name, docs] of byCollection) files[`${base}/collections/${name}.json`] = json(docs);
    }
  }

  // The shared component library (@lcs/components/<name>): code forms build against it, so it travels with them.
  for (const c of components) {
    const key = `components/${c.name}`;
    const def: Snapshot = { ...(JSON.parse(c.files) as Snapshot) };
    def["component.json"] = json({ title: c.title, description: c.description, category: c.category, api: c.api, usage: c.usage });
    out.set(key, { key, kind: "component", slug: c.name, title: c.title, updatedAt: c.updatedAt, info: { version: c.version }, def });
  }

  files[`${prefix}/catalog.json`] = json(
    categories.map((c) => ({
      name: c.name,
      icon: c.icon,
      description: c.description,
      cards: cards
        .filter((k) => k.categoryId === c.id)
        .map((k) => ({ title: k.title, url: k.url, description: k.description, keywords: k.keywords, badge: k.badge, icon: k.icon, roles: k.roles ? k.roles.split(",") : [], active: k.active })),
    }))
  );
  return { forms: out, files };
}

// ── Comparing with the backup ────────────────────────────────────────────

/** The backup as it is now: every file's blob sha, and a way to read one. */
export interface RepoView {
  files: Map<string, string>;
  read(path: string): Promise<string>;
}

export type SyncState = "in_sync" | "behind" | "differs" | "only_backup";

/** One form, here and in the backup. */
export interface FormSync {
  key: string;
  kind: Kind;
  slug: string;
  title: string;
  /**
   * in_sync — same as the backup (or just saved to it).
   * behind — the backup has a newer version from another site: Sync brings it in.
   * differs — changed both here and in the backup since they last matched (or they never matched): an admin picks.
   * only_backup — in the backup, not on this site.
   */
  state: SyncState;
  /** Who saved the backup's version, and when. */
  backup: { title: string | null; savedFrom: string | null; savedAt: string | null } | null;
  /** When this site's copy was last edited. */
  editedHere: string | null;
}

interface BackupInfo {
  title?: string;
  savedFrom?: string;
  savedAt?: string;
  status?: string;
  liveVersion?: number;
  publishedAt?: string | null;
}

/** Backups from before live files were always written left them out when they matched the draft. */
const wasPublished = (info: BackupInfo | null) => Boolean(info && (info.status === "published" || info.status === "closed" || (info.liveVersion ?? 0) > 0));

/** Each form folder in the backup: its definition files' blob shas. */
async function repoForms(view: RepoView) {
  const out = new Map<string, Map<string, string>>();
  for (const [path, sha] of view.files) {
    const m = /^(basic|code|components)\/([^/]+)\/(.+)$/.exec(path);
    if (!m || !isDefinition(kindOf(`${m[1]}/`), m[3])) continue;
    const key = `${m[1]}/${m[2]}`;
    if (!out.has(key)) out.set(key, new Map());
    out.get(key)!.set(m[3], sha);
  }
  for (const [key, files] of out) {
    if (kindOf(key) === "component") continue;
    const code = key.startsWith("code/");
    if ([...files.keys()].some((p) => (code ? p.startsWith(".backup/live/") : p === "live.json"))) continue;
    if (!wasPublished(await readInfo(view, key))) continue;
    // An old-layout published form: its live version is its draft.
    for (const [p, sha] of [...files]) if (code || p === "form.json") files.set(code ? `.backup/live/${p}` : "live.json", sha);
  }
  return out;
}

const infoCache = new Map<string, BackupInfo>();
async function readInfo(view: RepoView, key: string): Promise<BackupInfo | null> {
  const path = sharedInfoPath(key);
  const sha = view.files.get(path);
  if (!sha) return null;
  if (!infoCache.has(sha)) {
    try {
      infoCache.set(sha, JSON.parse(await view.read(path)) as BackupInfo);
    } catch {
      return null;
    }
  }
  return infoCache.get(sha)!;
}

async function readBase(view: RepoView): Promise<Record<string, string>> {
  const path = `sites/${backupSite()}/sync.json`;
  if (!view.files.has(path)) return {};
  try {
    return (JSON.parse(await view.read(path)) as { forms?: Record<string, string> }).forms ?? {};
  } catch {
    return {};
  }
}

/**
 * What to write so the backup holds this site's changes, and each form's state.
 * `baseOverride`: forms whose last match is set by hand (just synced, or "keep this site's").
 */
export async function planBackup(view: RepoView, baseOverride: Record<string, string> = {}) {
  const site = backupSite();
  const now = new Date().toISOString();
  const { forms, files: siteFiles } = await readSite();
  const inRepo = await repoForms(view);
  const base = { ...(await readBase(view)), ...baseOverride };
  const nextBase: Record<string, string> = {};
  const writes = new Map<string, string | null>();
  const saved: string[] = [];
  const out: FormSync[] = [];

  const put = (path: string, text: string) => {
    if (view.files.get(path) !== blobSha(text)) writes.set(path, text);
  };
  /** Make everything under `prefix` exactly `want`. */
  const replaceFolder = (prefix: string, want: Snapshot) => {
    for (const path of view.files.keys()) if (path.startsWith(prefix) && !(path in want)) writes.set(path, null);
    for (const [path, text] of Object.entries(want)) put(path, text);
  };

  for (const key of [...new Set([...forms.keys(), ...inRepo.keys()])].sort()) {
    const here = forms.get(key);
    const repoFiles = inRepo.get(key);
    const S = here ? fingerprint(new Map(Object.entries(here.def).map(([p, t]) => [p, blobSha(t)]))) : null;
    const R = repoFiles ? fingerprint(repoFiles) : null;
    const B = base[key];
    let state: SyncState;
    if (!here) state = "only_backup";
    else if (S === R) state = "in_sync";
    else if (!R || B === R) {
      // Changed only here (or new): save it.
      const want: Snapshot = {};
      for (const [rel, text] of Object.entries(here.def)) want[`${key}/${rel}`] = text;
      want[sharedInfoPath(key)] = json({
        slug: here.slug,
        kind: here.kind,
        title: here.title,
        savedFrom: site,
        savedAt: now,
        editedAt: iso(here.updatedAt),
        ...here.info,
      });
      replaceFolder(`${key}/`, want);
      saved.push(key);
      state = "in_sync";
    } else if (B === S) state = "behind";
    else state = "differs";

    if (state === "in_sync" && S) nextBase[key] = S;
    else if ((state === "behind" || state === "differs") && B) nextBase[key] = B;

    const info = state === "in_sync" ? null : await readInfo(view, key);
    out.push({
      key,
      kind: kindOf(key),
      slug: here?.slug ?? key.split("/")[1],
      title: here?.title ?? info?.title ?? key.split("/")[1],
      state,
      backup: info ? { title: info.title ?? null, savedFrom: info.savedFrom ?? null, savedAt: info.savedAt ?? info.publishedAt ?? null } : null,
      editedHere: here ? iso(here.updatedAt) : null,
    });
  }

  const sitePrefix = `sites/${site}/`;
  replaceFolder(sitePrefix, { ...siteFiles, [`${sitePrefix}sync.json`]: json({ site, forms: Object.fromEntries(Object.entries(nextBase).sort()) }) });
  put("README.md", README);
  put(".gitattributes", "* -text\n"); // byte for byte: no line-ending conversion
  if (view.files.has("catalog.json")) writes.set("catalog.json", null); // the old shared catalog; each site has its own now

  const names = saved.map((k) => k.replace(/^(basic|code|components)\//, ""));
  const message = names.length
    ? `${site}: ${names.slice(0, 6).join(", ")}${names.length > 6 ? ` and ${names.length - 6} more` : ""}\n\n${saved.join("\n")}`
    : `${site}: site data`;
  return { writes, forms: out, saved, message };
}

// ── GitHub ───────────────────────────────────────────────────────────────

export const backupConfigured = () => Boolean(env.formBackup.repo && env.formBackup.token);

async function gh<T>(method: string, path: string, body?: unknown): Promise<{ status: number; data: T }> {
  const res = await fetch(`https://api.github.com/repos/${env.formBackup.repo}${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${env.formBackup.token}`,
      Accept: "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28",
      ...(body ? { "Content-Type": "application/json" } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(60_000),
  });
  const data = (await res.json().catch(() => ({}))) as T;
  return { status: res.status, data };
}

const fail = (what: string, r: { status: number; data: unknown }) => new Error(`GitHub ${what} answered ${r.status}: ${JSON.stringify(r.data).slice(0, 300)}`);

/** The branch's head commit, making the first commit if the repository is still empty. */
async function head(branch: string): Promise<{ commit: string; tree: string }> {
  let ref = await gh<{ object?: { sha: string } }>("GET", `/git/ref/heads/${encodeURIComponent(branch)}`);
  if (ref.status === 401) throw new Error("GitHub refused the token (401). It may have expired or been revoked — make a new one and update FORM_BACKUP_TOKEN.");
  if (ref.status === 404 || ref.status === 409) {
    // GitHub says 404 both for "no such branch" and "this token can't see the repository".
    const repo = await gh<{ permissions?: { push?: boolean } }>("GET", "");
    if (repo.status === 404 || repo.status === 403) {
      throw new Error(
        `This token can't see ${env.formBackup.repo}. Check that its resource owner is Lantern-Community-Services, that the repository is selected, ` +
          "that it has Contents: read and write, and that an org owner has approved it if the org requires approval."
      );
    }
    if (repo.data.permissions && !repo.data.permissions.push) throw new Error(`This token can read ${env.formBackup.repo} but not write to it — give it Contents: read and write.`);
  }
  if (ref.status === 404 || ref.status === 409) {
    // The Git data API doesn't work on an empty repository; the contents API can make its first commit.
    const init = await gh("PUT", "/contents/README.md", { message: "Start the form backup", content: Buffer.from(README).toString("base64"), branch });
    if (init.status >= 300) throw fail("creating the first commit", init);
    ref = await gh<{ object?: { sha: string } }>("GET", `/git/ref/heads/${encodeURIComponent(branch)}`);
  }
  if (ref.status !== 200 || !ref.data.object) throw fail("reading the branch", ref);
  const commit = await gh<{ tree: { sha: string } }>("GET", `/git/commits/${ref.data.object.sha}`);
  if (commit.status !== 200) throw fail("reading the last commit", commit);
  return { commit: ref.data.object.sha, tree: commit.data.tree.sha };
}

const blobCache = new Map<string, string>();

/** The branch as it is now, read through the API (file contents only when asked for). */
async function githubView(): Promise<RepoView & { head: { commit: string; tree: string } }> {
  const at = await head(env.formBackup.branch);
  const tree = await gh<{ tree: { path: string; type: string; sha: string }[]; truncated?: boolean }>("GET", `/git/trees/${at.tree}?recursive=1`);
  if (tree.status !== 200) throw fail("listing the files", tree);
  if (tree.data.truncated) throw new Error("The backup repository has too many files for GitHub to list at once.");
  const files = new Map(tree.data.tree.filter((e) => e.type === "blob").map((e) => [e.path, e.sha]));
  return {
    head: at,
    files,
    async read(path) {
      const sha = files.get(path);
      if (!sha) throw new Error(`${path} isn't in the backup.`);
      if (!blobCache.has(sha)) {
        const blob = await gh<{ content: string; encoding: string }>("GET", `/git/blobs/${sha}`);
        if (blob.status !== 200) throw fail(`reading ${path}`, blob);
        blobCache.set(sha, Buffer.from(blob.data.content, "base64").toString("utf8"));
      }
      return blobCache.get(sha)!;
    },
  };
}

/** One commit with these changes (null deletes) on top of `parent`. Refuses if someone else committed meanwhile. */
async function commitToGitHub(parent: { commit: string; tree: string }, writes: Map<string, string | null>, message: string) {
  const url = `https://github.com/${env.formBackup.repo}`;
  if (!writes.size) return { changed: false, commit: parent.commit, url };
  const tree = await gh<{ sha: string }>("POST", "/git/trees", {
    base_tree: parent.tree,
    tree: [...writes].map(([path, content]) => (content === null ? { path, mode: "100644", type: "blob", sha: null } : { path, mode: "100644", type: "blob", content })),
  });
  if (tree.status !== 201) throw fail("writing the files", tree);
  if (tree.data.sha === parent.tree) return { changed: false, commit: parent.commit, url };
  const commit = await gh<{ sha: string }>("POST", "/git/commits", {
    message,
    tree: tree.data.sha,
    parents: [parent.commit],
    author: { name: "Lantern Forms", email: "forms-backup@lanterncommunity.org", date: new Date().toISOString() },
  });
  if (commit.status !== 201) throw fail("making the commit", commit);
  // Not forced: if another site committed since we read the branch, this fails and the next run starts over from theirs.
  const ref = await gh("PATCH", `/git/refs/heads/${encodeURIComponent(env.formBackup.branch)}`, { sha: commit.data.sha, force: false });
  if (ref.status === 422) throw new Error("Another site saved to the backup at the same moment. Try again.");
  if (ref.status !== 200) throw fail("moving the branch", ref);
  return { changed: true, commit: commit.data.sha, url: `${url}/commit/${commit.data.sha}` };
}

// ── Bringing a form in from the backup ───────────────────────────────────

const sameDoc = (stored: string | null | undefined, doc: unknown) => stored != null && json(JSON.parse(stored)) === json(doc);
const sortedFiles = (files: Snapshot) => JSON.stringify(Object.entries(files).sort(([a], [b]) => (a < b ? -1 : 1)));
const sameFiles = (stored: string | null | undefined, files: Snapshot) => stored != null && sortedFiles((JSON.parse(stored) as { files: Snapshot }).files) === sortedFiles(files);

/** While syncing: which backup items still need bringing in, and which were brought in already. */
export interface PullContext {
  needs: (key: string) => boolean;
  /** Started (so never twice). */
  done: Set<string>;
  /** Brought in. */
  pulled: Set<string>;
}

/** Components a set of files imports (@lcs/components/<name>). */
const importedComponents = (files: Snapshot) => {
  const out = new Set<string>();
  for (const text of Object.values(files)) for (const m of text.matchAll(/@lcs\/components\/([A-Za-z][A-Za-z0-9_]*)/g)) out.add(m[1]);
  return [...out];
};

/**
 * Make this site's copy match the backup's. A code form (or component) first gets the library components
 * it imports that aren't in sync here, and its published version is built before anything is saved, so a
 * sync that can't work leaves the form as it was. A form then gets the backup's live version published (if
 * it differs), then its draft.
 */
export async function pullForm(view: RepoView, key: string, actor: Actor, ctx: PullContext = { needs: () => true, done: new Set(), pulled: new Set() }) {
  const kind = kindOf(key);
  const slug = key.split("/")[1];
  ctx.done.add(key);
  const prefix = `${key}/`;
  const def: Snapshot = {};
  const paths = [...view.files.keys()].filter((p) => p.startsWith(prefix) && isDefinition(kind, p.slice(prefix.length)));
  if (!paths.length) throw badRequest(`${slug} isn't in the backup.`);
  for (const p of paths) def[p.slice(prefix.length)] = await view.read(p);
  const info = await readInfo(view, key);
  const note = `Synced from the backup${info?.savedFrom ? ` (saved from ${info.savedFrom})` : ""}`;

  if (kind !== "basic") {
    for (const name of importedComponents(def)) {
      const dep = `components/${name}`;
      if (dep === key || ctx.done.has(dep) || !view.files.has(`${dep}/component.json`) || !ctx.needs(dep)) continue;
      await pullForm(view, dep, actor, ctx);
    }
  }

  if (kind === "component") {
    const { "component.json": meta, ...files } = def;
    const m = JSON.parse(meta ?? "{}") as { title?: string; description?: string; category?: string; api?: string | null; usage?: string | null };
    const row = await prisma.uiComponent.findUnique({ where: { name: slug } });
    if (row && sortedFiles(JSON.parse(row.files) as Snapshot) === sortedFiles(files)) {
      await saveComponent({ name: slug, title: m.title, description: m.description, category: m.category, api: m.api, usage: m.usage }, actor);
    } else {
      await saveComponent({ name: slug, title: m.title ?? slug, description: m.description ?? slug, category: m.category ?? "Helpers", api: m.api, usage: m.usage, files, note }, actor);
    }
    ctx.pulled.add(key);
    return;
  }

  const published = wasPublished(info);
  let row = await prisma.builtForm.findUnique({ where: { slug } });
  if (row && row.kind !== kind) throw badRequest(`On this site ${slug} is a ${row.kind} form, in the backup a ${kind} form — rename one first.`);

  if (kind === "basic") {
    const draft = JSON.parse(def["form.json"] ?? "null");
    if (!draft) throw badRequest(`The backup of ${slug} has no form.json.`);
    const live = def["live.json"] ? JSON.parse(def["live.json"]) : published ? draft : null;
    if (live && !(row && sameDoc(row.liveSchema, live))) {
      row = row ? await saveDraft(row.id, { doc: live }, actor) : await createForm({ doc: live, slug }, actor);
      row = await publishForm(row.id, actor, note);
    }
    if (!row) row = await createForm({ doc: draft, slug }, actor);
    else if (!sameDoc(row.draftSchema, draft)) row = await saveDraft(row.id, { doc: draft }, actor);
  } else {
    const draft: Snapshot = {};
    const liveFiles: Snapshot = {};
    for (const [rel, text] of Object.entries(def)) {
      if (rel.startsWith(".backup/live/")) liveFiles[rel.slice(".backup/live/".length)] = text;
      else draft[rel] = text;
    }
    const live = Object.keys(liveFiles).length ? liveFiles : published ? draft : null;
    const publish = live && !(row && sameFiles(row.liveSchema, live));
    if (publish) {
      // Build first: if the backup's version can't build here, nothing is changed.
      const res = await buildProject(live);
      if (!res.ok) {
        const first = res.problems[0];
        throw new ProjectError(res.problems, `The backup's version doesn't build here${first ? ` (${first.file ? `${first.file}: ` : ""}${first.message})` : ""}. Nothing was changed.`);
      }
      row = row ? await saveProject(row.id, { files: live }, actor) : await createProject({ files: live, slug }, actor);
      row = await publishProject(row.id, actor, note);
    }
    if (!row) row = await createProject({ files: draft, slug }, actor);
    else if (!sameFiles(row.draftSchema, draft)) row = await saveProject(row.id, { files: draft }, actor);
  }
  ctx.pulled.add(key);
}

// ── The server's schedule ────────────────────────────────────────────────

const EVERY_MS = 10 * 60_000;

export type JobAction = "sync" | "keep" | "remove" | "backup";

/** Work an admin asked for, waiting its turn (one backup job runs at a time). */
interface Job {
  id: number;
  action: JobAction;
  /** The form ("basic/<slug>"), or null for a backup. */
  key: string | null;
  actor: Actor;
  running: boolean;
}

/** How a finished job went, for the admin who's watching. */
export interface JobResult {
  id: number;
  action: JobAction;
  key: string | null;
  ok: boolean;
  error: string | null;
  at: string;
}

export interface BackupStatus {
  configured: boolean;
  repo: string | null;
  site: string;
  running: boolean;
  lastCheckedAt: string | null;
  lastCommitAt: string | null;
  lastCommitUrl: string | null;
  lastError: string | null;
  /** Every form that isn't simply in sync (from the last check), so lists can label them. */
  forms: FormSync[];
  /** Waiting and running jobs, oldest first. */
  jobs: { id: number; action: JobAction; key: string | null; running: boolean; by: string }[];
  /** The last finished jobs, newest last. */
  results: JobResult[];
}

const state = {
  running: false,
  lastCheckedAt: null as string | null,
  lastCommitAt: null as string | null,
  lastCommitUrl: null as string | null,
  lastError: null as string | null,
  forms: [] as FormSync[],
  /** Forms whose last match was set here (synced, or "keep this site's") until sync.json records it. */
  baseOverride: {} as Record<string, string>,
  jobs: [] as Job[],
  results: [] as JobResult[],
  nextJob: 1,
};

export function backupStatus(): BackupStatus {
  const { baseOverride: _b, forms, jobs, nextJob: _n, ...s } = state;
  return {
    ...s,
    forms: forms.filter((f) => f.state !== "in_sync"),
    jobs: jobs.map((j) => ({ id: j.id, action: j.action, key: j.key, running: j.running, by: j.actor.name })),
    configured: backupConfigured(),
    repo: env.formBackup.repo || null,
    site: backupSite(),
  };
}

/** One backup job at a time: the timer, Back up now, Sync. */
let queue: Promise<unknown> = Promise.resolve();
function exclusive<T>(fn: () => Promise<T>): Promise<T> {
  const run = queue.then(async () => {
    state.running = true;
    try {
      return await fn();
    } finally {
      state.running = false;
    }
  });
  queue = run.catch(() => undefined);
  return run;
}

function needConfig() {
  if (!backupConfigured()) throw badRequest("The form backup isn't set up on this server (FORM_BACKUP_REPO and FORM_BACKUP_TOKEN).");
}

/** Compare with the backup and save what changed here. Inside exclusive(). */
async function backupOnce(by?: string) {
  try {
    const view = await githubView();
    const plan = await planBackup(view, state.baseOverride);
    state.lastCheckedAt = new Date().toISOString();
    const r = await commitToGitHub(view.head, plan.writes, plan.message);
    state.forms = plan.forms;
    state.baseOverride = {};
    if (r.changed) {
      state.lastCommitAt = new Date().toISOString();
      state.lastCommitUrl = r.url;
      if (plan.saved.length) await audit({ actor: { id: null, name: by ?? "Form backup" }, action: "forms.backed_up", summary: `Backed up ${plan.saved.length} form${plan.saved.length === 1 ? "" : "s"} to ${env.formBackup.repo}: ${plan.saved.join(", ")}` });
    }
    state.lastError = null;
  } catch (err) {
    state.lastError = err instanceof Error ? err.message : String(err);
    console.error("[backup] form backup failed:", state.lastError);
  }
  return backupStatus();
}

/** Until the next check, show these forms as settled (synced, kept or removed). */
function settle(keys: string[], removed = false) {
  state.forms = removed ? state.forms.filter((f) => !keys.includes(f.key)) : state.forms.map((f) => (keys.includes(f.key) ? { ...f, state: "in_sync" as const } : f));
}

/** Pull these forms in from the backup. Inside exclusive(); the caller backs up afterwards. */
async function syncKeys(keys: string[], actor: Actor) {
  const view = await githubView();
  const plan = await planBackup(view, state.baseOverride);
  const byKey = new Map(plan.forms.map((f) => [f.key, f]));
  const synced: string[] = [];
  const failed: { key: string; error: string }[] = [];
  const repo = await repoForms(view);
  // Components a form needs come along when they aren't in sync here; each is brought in once.
  const ctx: PullContext = { needs: (k) => byKey.has(k) && byKey.get(k)!.state !== "in_sync", done: new Set(), pulled: new Set() };
  for (const key of keys) {
    const f = byKey.get(key);
    if (!f) {
      failed.push({ key, error: "Not in the backup." });
      continue;
    }
    if (f.state === "in_sync" || ctx.done.has(key)) continue;
    try {
      await pullForm(view, key, actor, ctx);
    } catch (err) {
      failed.push({ key, error: err instanceof Error ? err.message : String(err) });
    }
  }
  // What this site now matches (the form, and components that came with it); the next backup run records it.
  for (const k of ctx.pulled) {
    state.baseOverride[k] = fingerprint(repo.get(k)!)!;
    synced.push(k);
  }
  if (synced.length) await audit({ actor, action: "forms.synced", summary: `Synced ${synced.length} form${synced.length === 1 ? "" : "s"} from the backup: ${synced.join(", ")}` });
  settle(synced);
  return { synced, failed };
}

/** This site's version of a form wins over the backup's. Inside exclusive(); the caller backs up afterwards. */
async function keepKey(key: string, actor: Actor) {
  const view = await githubView();
  const R = await repoFingerprint(view, key);
  if (R) state.baseOverride[key] = R;
  await audit({ actor, action: "forms.backup_kept", summary: `Kept this site's version of ${key} over the backup's` });
  settle([key]);
}

/** Take a form that's only in the backup out of it. Inside exclusive(). */
async function removeKey(key: string, actor: Actor) {
  const [kind, slug] = key.split("/");
  const here =
    kind === "components"
      ? await prisma.uiComponent.findUnique({ where: { name: slug } })
      : await prisma.builtForm.findFirst({ where: { slug, kind: kind === "code" ? "code" : { not: "code" } } });
  if (here) throw new HttpError(400, "That's on this site, so the next backup would put it back. Delete it here first.");
  const view = await githubView();
  const writes = new Map<string, string | null>();
  for (const path of view.files.keys()) if (path.startsWith(`${key}/`)) writes.set(path, null);
  if (!writes.size) throw badRequest(`${slug} isn't in the backup.`);
  await commitToGitHub(view.head, writes, `${backupSite()}: removed ${slug}\n\n${key}`);
  await audit({ actor, action: "forms.backup_removed", summary: `Removed ${key} from the form backup` });
  settle([key], true);
}

/**
 * Queue work and return at once: each job runs in turn in the background, so an admin
 * can click Sync on several forms in a row. The backup itself runs once the queue is empty.
 * A form already waiting for the same action isn't queued twice.
 */
export function queueBackupJobs(action: JobAction, keys: (string | null)[], actor: Actor) {
  needConfig();
  for (const key of keys) {
    if (state.jobs.some((j) => j.action === action && j.key === key && !j.running)) continue;
    const job: Job = { id: state.nextJob++, action, key, actor, running: false };
    state.jobs.push(job);
    void exclusive(async () => {
      job.running = true;
      let error: string | null = null;
      try {
        if (action === "sync") {
          const r = await syncKeys([key!], actor);
          if (r.failed.length) error = r.failed[0].error;
        } else if (action === "keep") await keepKey(key!, actor);
        else if (action === "remove") await removeKey(key!, actor);
      } catch (err) {
        error = err instanceof Error ? err.message : String(err);
      }
      state.jobs = state.jobs.filter((j) => j !== job);
      // One backup after a run of jobs, not after each.
      if (action === "backup" || !state.jobs.length) {
        await backupOnce(actor.name);
        if (action === "backup" && state.lastError) error = state.lastError;
      }
      state.results = [...state.results, { id: job.id, action, key, ok: !error, error, at: new Date().toISOString() }].slice(-20);
    });
  }
  return backupStatus();
}

/**
 * What Sync all brings in: every form and component on this site whose backup differs (needs sync, or
 * changed on both sides — the backup's version wins), that `allowed` lets through. Components first, so
 * the forms build against them. Not ones that exist only in the backup.
 */
export const formsToSync = (allowed: (key: string) => boolean = () => true) =>
  state.forms
    .filter((f) => (f.state === "behind" || f.state === "differs") && allowed(f.key))
    .sort((a, b) => Number(b.kind === "component") - Number(a.kind === "component"))
    .map((f) => f.key);

/** Back up now: save every form changed here, never over a newer one. Waits for it. */
export async function runFormBackup(opts: { by?: string } = {}) {
  needConfig();
  return exclusive(() => backupOnce(opts.by));
}

/**
 * Bring forms in from the backup and wait for it (the MCP tool). `keys`: form folders
 * ("basic/<slug>", "code/<slug>", "components/<name>"), or "all" (formsToSync).
 */
export async function syncFromBackup(keys: string[] | "all", actor: Actor, allowed: (key: string) => boolean = () => true) {
  needConfig();
  return exclusive(async () => {
    let todo = keys;
    if (todo === "all") {
      await backupOnce(actor.name);
      todo = formsToSync(allowed);
    }
    const r = await syncKeys(todo, actor);
    return { ...r, status: await backupOnce(actor.name) };
  });
}

/** The backup's fingerprint of one form's definition, or null when it isn't there. */
export async function repoFingerprint(view: RepoView, key: string) {
  const files = (await repoForms(view)).get(key);
  return files ? fingerprint(files) : null;
}

/** For a form that differs: this site's version wins and goes to the backup. Waits for it. */
export async function keepSiteVersion(key: string, actor: Actor) {
  needConfig();
  return exclusive(async () => {
    await keepKey(key, actor);
    return backupOnce(actor.name);
  });
}

/** Take a form that's only in the backup (not on this site) out of it. Waits for it. */
export async function removeFromBackup(key: string, actor: Actor) {
  needConfig();
  return exclusive(async () => {
    await removeKey(key, actor);
    return backupOnce(actor.name);
  });
}

export function startFormBackup() {
  if (!backupConfigured()) return false;
  const tick = () => {
    if (!state.running) void exclusive(() => backupOnce());
  };
  setTimeout(tick, 30_000).unref();
  setInterval(tick, EVERY_MS).unref();
  return true;
}
