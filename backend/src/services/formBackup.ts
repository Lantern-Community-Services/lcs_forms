import crypto from "node:crypto";
import { prisma } from "../prisma.js";
import { env } from "../env.js";
import { audit } from "./audit.js";

/**
 * Backup of every form built in the app — form builder forms and code forms —
 * to a git repository (FORM_BACKUP_REPO, e.g. Lantern-Community-Services/lcs_forms_form_backup).
 *
 * What's kept: each form's draft and published definition, every published
 * version, a code form's collections (its settings and lists), and the Forms
 * catalog. Not kept: entries, uploaded files, people — resident data stays in
 * the database. Nothing in the snapshot carries a timestamp that changes on its
 * own, so a commit is only made when a form actually changed.
 *
 * Two ways out:
 *   - The server, every 10 minutes, through the GitHub API (FORM_BACKUP_TOKEN, a
 *     token that can write that one repository). No git needed on the server.
 *   - `npm run forms -- backup --dir <clone>` from a computer, through its own git login.
 * `npm run forms -- backup:restore <dir>` loads forms back from a copy of the repository.
 */

export type Snapshot = Record<string, string>;

const json = (v: unknown) => `${JSON.stringify(v, null, 2)}\n`;
const iso = (d: Date | null | undefined) => (d ? d.toISOString() : null);

const README = `# Lantern Forms — form backup

Written automatically by the Lantern Forms site. Don't edit files here by hand: the next
backup replaces them with what's on the site.

    basic/<slug>/form.json         a form builder form (draft) — the lcs-form document
    basic/<slug>/live.json         the published version, when it differs from the draft
    basic/<slug>/versions/vN.json  every published version
    basic/<slug>/info.json         title, status, who made it, its catalog card

    code/<slug>/…                  a code form's files (draft): form.json, pages/, server/, …
    code/<slug>/.backup/live/…     the published files, when they differ from the draft
    code/<slug>/.backup/versions/  every published version
    code/<slug>/.backup/collections/<name>.json   the form's own data (settings, lists)
    code/<slug>/.backup/info.json

    catalog.json                   the Forms screen: categories and cards, including links to
                                   forms on other sites

Entries (what people submitted) and uploaded photos are not here — they stay in the
site's database and its own backups.

## Restoring

From the site's backend folder, with DATABASE_URL pointing at the database to restore into:

    npm run forms -- backup:restore <path to this repository> [slug ...] [--publish]

It creates missing forms and replaces drafts of existing ones; --publish also publishes
the backed-up live version. Code forms can also go back one at a time:

    npm run forms -- app:push <path>/code/<slug> --publish
`;

/** The whole backup as { path: text }. */
export async function backupSnapshot(): Promise<Snapshot> {
  // Byte for byte: no line-ending conversion, so a backup from Windows and one from the server match.
  const files: Snapshot = { "README.md": README, ".gitattributes": "* -text\n" };
  const [forms, versions, records, categories, cards] = await Promise.all([
    prisma.builtForm.findMany({ orderBy: { slug: "asc" } }),
    prisma.builtFormVersion.findMany({ orderBy: [{ formId: "asc" }, { version: "asc" }] }),
    prisma.formRecord.findMany({ orderBy: [{ formId: "asc" }, { collection: "asc" }, { docId: "asc" }] }),
    prisma.formCategory.findMany({ orderBy: { sortOrder: "asc" } }),
    prisma.formLink.findMany({ orderBy: [{ categoryId: "asc" }, { sortOrder: "asc" }] }),
  ]);
  const catName = new Map(categories.map((c) => [c.id, c.name]));
  const cardOf = new Map(cards.map((c) => [c.id, c]));

  for (const f of forms) {
    const card = f.catalogLinkId ? cardOf.get(f.catalogLinkId) : null;
    const mine = versions.filter((v) => v.formId === f.id);
    const info = {
      id: f.id,
      slug: f.slug,
      kind: f.kind,
      title: f.title,
      status: f.status,
      liveVersion: f.liveVersion,
      createdByName: f.createdByName,
      createdAt: iso(f.createdAt),
      publishedAt: iso(f.publishedAt),
      catalog: card ? { category: catName.get(card.categoryId) ?? null, title: card.title, active: card.active } : null,
      versions: mine.map((v) => ({ version: v.version, note: v.note, publishedByName: v.publishedByName, publishedAt: iso(v.createdAt) })),
    };

    if (f.kind === "code") {
      const base = `code/${f.slug}`;
      const draft = (JSON.parse(f.draftSchema) as { files: Record<string, string> }).files;
      for (const [path, src] of Object.entries(draft)) files[`${base}/${path}`] = src;
      if (f.liveSchema) {
        const live = (JSON.parse(f.liveSchema) as { files: Record<string, string> }).files;
        if (JSON.stringify(live) !== JSON.stringify(draft)) for (const [path, src] of Object.entries(live)) files[`${base}/.backup/live/${path}`] = src;
      }
      for (const v of mine) files[`${base}/.backup/versions/v${v.version}.json`] = json(JSON.parse(v.schema));
      const byCollection = new Map<string, { id: string; data: unknown; updatedByName: string | null }[]>();
      for (const r of records.filter((r) => r.formId === f.id)) {
        byCollection.set(r.collection, [...(byCollection.get(r.collection) ?? []), { id: r.docId, data: JSON.parse(r.data), updatedByName: r.updatedByName }]);
      }
      for (const [name, docs] of byCollection) files[`${base}/.backup/collections/${name}.json`] = json(docs);
      files[`${base}/.backup/info.json`] = json(info);
    } else {
      const base = `basic/${f.slug}`;
      files[`${base}/form.json`] = json(JSON.parse(f.draftSchema));
      if (f.liveSchema && f.liveSchema !== f.draftSchema) files[`${base}/live.json`] = json(JSON.parse(f.liveSchema));
      for (const v of mine) files[`${base}/versions/v${v.version}.json`] = json(JSON.parse(v.schema));
      files[`${base}/info.json`] = json(info);
    }
  }

  files["catalog.json"] = json(
    categories.map((c) => ({
      name: c.name,
      icon: c.icon,
      cards: cards
        .filter((k) => k.categoryId === c.id)
        .map((k) => ({ title: k.title, url: k.url, description: k.description, keywords: k.keywords, badge: k.badge, icon: k.icon, roles: k.roles ? k.roles.split(",") : [], active: k.active })),
    }))
  );
  return files;
}

export const snapshotHash = (s: Snapshot) =>
  crypto.createHash("sha256").update(JSON.stringify(Object.keys(s).sort().map((k) => [k, s[k]]))).digest("hex");

/** Form folders whose files differ between two snapshots, for the commit message. */
export function changedForms(before: Snapshot | null, after: Snapshot): string[] {
  if (!before) return [];
  const keyOf = (p: string) => (/^(basic|code)\/[^/]+/.exec(p)?.[0] ?? p);
  const out = new Set<string>();
  for (const p of new Set([...Object.keys(before), ...Object.keys(after)])) if (before[p] !== after[p]) out.add(keyOf(p));
  return [...out].sort();
}

export function commitMessage(before: Snapshot | null, after: Snapshot) {
  const changed = changedForms(before, after);
  const forms = Object.keys(after).filter((p) => /^(basic\/[^/]+\/info\.json|code\/[^/]+\/\.backup\/info\.json)$/.test(p)).length;
  if (!changed.length) return `Backup of ${forms} forms`;
  const names = changed.map((c) => c.replace(/^(basic|code)\//, ""));
  return `Backup: ${names.slice(0, 6).join(", ")}${names.length > 6 ? ` and ${names.length - 6} more` : ""}\n\n${changed.join("\n")}`;
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

/** Make the repository hold exactly `files` (one commit), unless it already does. */
export async function pushToGitHub(files: Snapshot, message: string): Promise<{ changed: boolean; commit: string; url: string }> {
  const branch = env.formBackup.branch;
  const parent = await head(branch);
  const tree = await gh<{ sha: string }>("POST", "/git/trees", {
    // No base_tree: the new tree is the snapshot exactly, so deleted forms disappear.
    tree: Object.entries(files).map(([path, content]) => ({ path, mode: "100644", type: "blob", content })),
  });
  if (tree.status !== 201) throw fail("writing the files", tree);
  const url = `https://github.com/${env.formBackup.repo}`;
  if (tree.data.sha === parent.tree) return { changed: false, commit: parent.commit, url };
  const commit = await gh<{ sha: string }>("POST", "/git/commits", {
    message,
    tree: tree.data.sha,
    parents: [parent.commit],
    author: { name: "Lantern Forms", email: "forms-backup@lanterncommunity.org", date: new Date().toISOString() },
  });
  if (commit.status !== 201) throw fail("making the commit", commit);
  const ref = await gh("PATCH", `/git/refs/heads/${encodeURIComponent(branch)}`, { sha: commit.data.sha });
  if (ref.status !== 200) throw fail("moving the branch", ref);
  return { changed: true, commit: commit.data.sha, url: `${url}/commit/${commit.data.sha}` };
}

// ── The server's schedule ────────────────────────────────────────────────

const EVERY_MS = 10 * 60_000;

interface Status {
  configured: boolean;
  repo: string | null;
  running: boolean;
  lastCheckedAt: string | null;
  lastCommitAt: string | null;
  lastCommitUrl: string | null;
  lastError: string | null;
}

const state: Status & { lastHash: string | null; lastSnapshot: Snapshot | null } = {
  configured: false,
  repo: null,
  running: false,
  lastCheckedAt: null,
  lastCommitAt: null,
  lastCommitUrl: null,
  lastError: null,
  lastHash: null,
  lastSnapshot: null,
};

export function backupStatus(): Status {
  const { lastHash: _h, lastSnapshot: _s, ...s } = state;
  return { ...s, configured: backupConfigured(), repo: env.formBackup.repo || null };
}

/** Back up now if anything changed since the last backup (or always, with force). */
export async function runFormBackup(opts: { force?: boolean; by?: string } = {}) {
  if (!backupConfigured()) throw new Error("The form backup isn't set up: set FORM_BACKUP_REPO and FORM_BACKUP_TOKEN.");
  if (state.running) return backupStatus();
  state.running = true;
  try {
    const snap = await backupSnapshot();
    const hash = snapshotHash(snap);
    state.lastCheckedAt = new Date().toISOString();
    if (opts.force || hash !== state.lastHash) {
      const r = await pushToGitHub(snap, commitMessage(state.lastSnapshot, snap));
      if (r.changed) {
        state.lastCommitAt = new Date().toISOString();
        state.lastCommitUrl = r.url;
        await audit({ actor: { id: null, name: opts.by ?? "Form backup" }, action: "forms.backed_up", summary: `Backed up the forms to ${env.formBackup.repo}` });
      }
      state.lastHash = hash;
      state.lastSnapshot = snap;
    }
    state.lastError = null;
  } catch (err) {
    state.lastError = err instanceof Error ? err.message : String(err);
    console.error("[backup] form backup failed:", state.lastError);
  } finally {
    state.running = false;
  }
  return backupStatus();
}

export function startFormBackup() {
  if (!backupConfigured()) return false;
  setTimeout(() => void runFormBackup(), 30_000).unref();
  setInterval(() => void runFormBackup(), EVERY_MS).unref();
  return true;
}
