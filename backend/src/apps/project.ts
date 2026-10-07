import { z } from "zod";

/**
 * A code form's project: a map of file paths to source text, with form.json as
 * its manifest. Stored whole in BuiltForm.draftSchema; the published copy (plus
 * its compiled build) in liveSchema.
 */

export const APP_FORMAT = "lcs-app" as const;

export type Files = Record<string, string>;

export interface Project {
  format: typeof APP_FORMAT;
  version: 1;
  files: Files;
}

const roleList = z.array(z.string()).optional();

export const manifestSchema = z.object({
  $schema: z.string().optional(),
  title: z.string().trim().min(1).max(200),
  description: z.string().max(2000).optional(),
  /** Catalog icon key. */
  icon: z.string().max(40).optional(),
  /** Roles that can open the form at all. Omit for anyone signed in. Admins always can. */
  access: z.object({ roles: roleList }).strict().optional(),
  /** Tabs, in order. The first one a person can open is where the form starts. */
  pages: z
    .array(
      z.object({
        id: z.string().regex(/^[a-z][a-z0-9-]{0,39}$/, "Page ids are lowercase letters, digits and dashes."),
        label: z.string().min(1).max(40),
        file: z.string().min(1),
        /** Roles that see this tab; omit for everyone with access. */
        roles: roleList,
        /** Hold the page to the screen height (it scrolls inside itself) — for iPad-style screens. */
        fullHeight: z.boolean().optional(),
        /** Hide from the tab row (reach it with app.navigate). */
        hidden: z.boolean().optional(),
        /**
         * A different page file for some kinds of device — e.g. { "tablet": "pages/record.ipad.tsx" }.
         * Devices without their own view use `file`.
         */
        views: z.object({ phone: z.string().optional(), tablet: z.string().optional(), desktop: z.string().optional() }).strict().optional(),
        /**
         * The app's sidebar while this page is open. "auto" (default): folds to icons on an iPad in
         * portrait, like the app's own forms. "tablet": folds on any tablet, portrait or landscape.
         * "always": folds on every screen. "never": stays as the person left it.
         */
        nav: z.enum(["auto", "tablet", "always", "never"]).optional(),
      }).strict()
    )
    .min(1, "Add at least one page."),
  entries: z
    .object({
      /** Roles that can read everyone's entries. Default: Main Office, Site Admin, Site Manager, Developer. */
      read: roleList,
      /** Roles that can create entries. Default: everyone with access. */
      create: roleList,
      /** Roles that can void any entry. Default: roles with the entries.void permission. */
      void: roleList,
      /** Minutes during which people can void (undo) their own entry. Default 10; 0 turns it off. */
      undoMinutes: z.number().int().min(0).max(1440).optional(),
      /** Entries about a resident log roster activity (resets their review clock). Default true. */
      rosterActivity: z.boolean().optional(),
      /** Roles that can edit anyone's entry (every change is kept in its history). Default: admins and developers only. */
      edit: roleList,
      /** Minutes during which people can edit their own entry. Default 0 (off). */
      editOwnMinutes: z.number().int().min(0).max(10_080).optional(),
    })
    .strict()
    .optional(),
  /** Photos and files pages upload (files.upload / takePhoto). Default: 10 MB, images, PDF and office files. */
  files: z
    .object({
      maxMb: z.number().min(0.1).max(10).optional(),
      /** Like an <input accept>: "image/*,application/pdf,.docx". */
      accept: z.string().max(300).optional(),
    })
    .strict()
    .optional(),
  /** The form's own data. Default for a collection not listed: everyone reads, admins write. */
  collections: z.record(z.object({ read: roleList, write: roleList }).strict()).optional(),
  /**
   * Cards on the Forms home: the server action run as each person when the home screen loads.
   * It returns { attention?: [...], tiles?: [...] } (see the guide). `roles`: who gets them (default: everyone who can open the form).
   */
  home: z.object({ action: z.string().regex(/^[A-Za-z_$][\w$]{0,63}$/), roles: roleList }).strict().optional(),
  /**
   * Server actions run on a timer, once a New York day at `at` ("HH:MM"): daily (default), on weekdays,
   * or monthly on `day` (1–28). They run as nobody (ctx.user null) with args { scheduled: true, day }:
   * reminders, digests, a monthly report email. Only the published form runs them.
   */
  schedule: z
    .array(
      z.object({
        action: z.string().regex(/^[A-Za-z_$][\w$]{0,63}$/),
        at: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, "at is HH:MM (24-hour, New York)."),
        on: z.enum(["daily", "weekdays", "monthly"]).optional(),
        day: z.number().int().min(1).max(28).optional(),
      }).strict()
    )
    .max(10)
    .optional(),
  /** Who server code may email besides Lantern addresses: full addresses or "@domain". */
  email: z.object({ to: z.array(z.string().trim().min(3).max(200)).max(50).optional() }).strict().optional(),
  /**
   * The form's own calendar events. ownEvents: server code may add, change and remove events it
   * owns (ctx.calendar.form) for any site, without the person's calendar rights, and mark them
   * waiting on approval. Never events for every site; nobody changes them on the calendar itself.
   */
  calendar: z.object({ ownEvents: z.boolean().optional() }).strict().optional(),
  /**
   * Code forms (slugs) whose server code may read this form's entries whoever is using them (with the
   * other form listing this one in "reads"). The other form's server code decides what to show — e.g.
   * Encounters showing approved event requests at the person's own sites.
   */
  share: z
    .object({
      forms: z.array(z.string()).max(20).optional(),
      /** Code forms whose server code may add entries here (ctx.db.form(slug).entries.create), through this form's own rules. */
      create: z.array(z.string()).max(20).optional(),
    })
    .strict()
    .optional(),
  /** Other forms (slugs) whose entries the server code may read — still only if the person may, or if that form shares with this one. */
  reads: z.array(z.string()).optional(),
  /** Server entry file. Default server/index.ts when it exists. */
  server: z.string().optional(),
  /**
   * Working with no connection. `actions`: server actions that only read (meal
   * types, today's counts). The device keeps each one's last answer and, offline,
   * the page gets that instead of an error. Never list an action that saves
   * anything — offline it would look as if it had.
   */
  offline: z.object({ actions: z.array(z.string().min(1).max(60)).max(50).optional() }).strict().optional(),
}).strict();

export type Manifest = z.infer<typeof manifestSchema>;

export const DEFAULT_ENTRY_READERS = ["main_office", "site_admin", "site_manager", "developer"];

/** Roles check where "*" (or an empty/missing list) means everyone; admins always pass. */
export function roleAllowed(roles: string[] | undefined, roleKey: string, isAdmin: boolean): boolean {
  if (isAdmin) return true;
  if (!roles || roles.length === 0 || roles.includes("*")) return true;
  return roles.includes(roleKey);
}

export const PATH_RE = /^(?!\/)(?!.*\.\.)[A-Za-z0-9_\-./]{1,160}$/;
export const ALLOWED_EXT = /\.(tsx?|jsx?|css|json|md|txt)$/;
const MAX_FILES = 200;
const MAX_TOTAL = 3 * 1024 * 1024;

export interface FileProblem {
  file: string;
  line?: number;
  column?: number;
  message: string;
}

export function readManifest(files: Files): { manifest: Manifest | null; problems: FileProblem[] } {
  const text = files["form.json"];
  if (text === undefined) return { manifest: null, problems: [{ file: "form.json", message: "Every code form needs a form.json." }] };
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (e) {
    return { manifest: null, problems: [{ file: "form.json", message: `Not valid JSON: ${e instanceof Error ? e.message : e}` }] };
  }
  const parsed = manifestSchema.safeParse(raw);
  if (!parsed.success) {
    return { manifest: null, problems: parsed.error.issues.map((i) => ({ file: "form.json", message: `${i.path.join(".") || "(root)"}: ${i.message}` })) };
  }
  const m = parsed.data;
  const problems: FileProblem[] = [];
  const ids = new Set<string>();
  for (const p of m.pages) {
    if (ids.has(p.id)) problems.push({ file: "form.json", message: `Two pages use the id "${p.id}".` });
    ids.add(p.id);
    if (files[p.file] === undefined) problems.push({ file: "form.json", message: `Page "${p.id}" points at ${p.file}, which doesn't exist.` });
    for (const [kind, file] of Object.entries(p.views ?? {})) {
      if (file && files[file] === undefined) problems.push({ file: "form.json", message: `Page "${p.id}" has a ${kind} view ${file}, which doesn't exist.` });
    }
  }
  if (m.server && files[m.server] === undefined) problems.push({ file: "form.json", message: `server points at ${m.server}, which doesn't exist.` });
  return { manifest: problems.length ? null : m, problems };
}

export function serverEntry(files: Files, m: Manifest): string | null {
  if (m.server) return m.server;
  for (const f of ["server/index.ts", "server/index.js"]) if (files[f] !== undefined) return f;
  return null;
}

/** Shape checks on a set of files (paths, sizes). */
export function checkFiles(files: unknown): { files: Files | null; problems: FileProblem[] } {
  if (!files || typeof files !== "object" || Array.isArray(files)) return { files: null, problems: [{ file: "", message: "files must be an object of { path: source }." }] };
  const problems: FileProblem[] = [];
  const out: Files = {};
  let total = 0;
  const entries = Object.entries(files as Record<string, unknown>);
  if (entries.length > MAX_FILES) problems.push({ file: "", message: `At most ${MAX_FILES} files.` });
  for (const [path, src] of entries) {
    if (typeof src !== "string") problems.push({ file: path, message: "File contents must be text." });
    else if (!PATH_RE.test(path) || !ALLOWED_EXT.test(path)) problems.push({ file: path, message: "Use a relative path like pages/record.tsx (.ts .tsx .js .jsx .css .json .md .txt)." });
    else {
      out[path] = src;
      total += src.length;
    }
  }
  if (total > MAX_TOTAL) problems.push({ file: "", message: "The project is over 3 MB." });
  return { files: problems.length ? null : out, problems };
}

export function titleOf(files: Files): string {
  try {
    const t = JSON.parse(files["form.json"] ?? "{}").title;
    return typeof t === "string" && t.trim() ? t.trim().slice(0, 200) : "Untitled code form";
  } catch {
    return "Untitled code form";
  }
}

/** A new project: one page, a server file with a rule and an action, a settings collection. */
export function starterProject(title: string): Files {
  return {
    "form.json": JSON.stringify(
      {
        title,
        icon: "clipboard",
        pages: [
          { id: "record", label: "Record", file: "pages/record.tsx" },
          { id: "entries", label: "Entries", file: "pages/entries.tsx", roles: ["main_office", "site_admin", "site_manager", "developer"] },
        ],
        entries: { undoMinutes: 10 },
        collections: { settings: { read: ["*"], write: ["admin"] } },
      },
      null,
      2
    ),
    "pages/record.tsx": `import { useState } from "react";
import { app, entries, roster, useApp, useData } from "@lcs/sdk";
import { Button, Card, Field, Input, Page, PageHeader, Select } from "@lcs/ui";

export default function Record() {
  const { user } = useApp();
  const { data: sites } = useData(() => roster.sites(), []);
  const [site, setSite] = useState("");
  const [note, setNote] = useState("");
  const [saving, setSaving] = useState(false);

  async function save() {
    setSaving(true);
    const res = await entries.create({ data: { note }, site }, { offline: true });
    setSaving(false);
    if (res.status === "saved" || res.status === "queued") {
      app.toast(res.status === "queued" ? "Saved on this device — it'll upload when you're back online." : "Saved.");
      setNote("");
    } else if (res.status === "invalid") app.toast(res.message, "error");
  }

  return (
    <Page className="max-w-[640px]">
      <PageHeader title="${title.replace(/"/g, '\\"')}" subtitle={\`Hi \${user.name.split(" ")[0]} — record something.\`} />
      <Card className="space-y-4 p-5">
        <Field label="Site">
          <Select value={site} onChange={(e) => setSite(e.target.value)} placeholder="Pick a site…" options={(sites ?? []).map((s) => ({ value: s.code, label: s.name }))} />
        </Field>
        <Field label="Note">
          <Input value={note} onChange={(e) => setNote(e.target.value)} />
        </Field>
        <Button onClick={save} disabled={!site || !note || saving}>Save</Button>
      </Card>
    </Page>
  );
}
`,
    "pages/entries.tsx": `import { entries, dates, useData } from "@lcs/sdk";
import { Card, EmptyState, LoadingState, Page, PageHeader } from "@lcs/ui";

export default function Entries() {
  const { data, loading } = useData(() => entries.list<{ note: string }>({ limit: 100 }), []);
  if (loading) return <LoadingState />;
  return (
    <Page>
      <PageHeader title="Entries" subtitle={\`\${data?.total ?? 0} so far\`} />
      <Card>
        {!data?.items.length ? <EmptyState title="Nothing yet" /> : (
          <ul>
            {data.items.map((e) => (
              <li key={e.id} className="border-b border-hairline px-4 py-3 last:border-0">
                <p className="text-[14px] font-semibold text-ink">{e.data.note}</p>
                <p className="text-micro text-muted">{dates.format(e.occurredAt, "datetime")} · {e.createdByName}{e.site ? \` · \${e.site.name}\` : ""}</p>
              </li>
            ))}
          </ul>
        )}
      </Card>
    </Page>
  );
}
`,
    "server/index.ts": `import { defineServer } from "@lcs/server";

export default defineServer({
  // Runs on the server before every entry is saved — the server's word is final.
  beforeCreate(entry, ctx) {
    const note = String(entry.data.note ?? "").trim();
    if (!note) return { errors: { note: "Write a note." } };
    if (note.length > 500) return { errors: { note: "Keep it under 500 characters." } };
  },

  actions: {
    // Pages call this with actions.call("todayCount")
    todayCount(_args, ctx) {
      return ctx.db.entries.count({ from: ctx.today, to: ctx.today });
    },
  },
});
`,
    "styles.css": "/* Styles for this form only. Tailwind classes work in every page too. */\n",
    "README.md": `# ${title}

A Lantern code form. Pages live in pages/, server logic in server/index.ts, and form.json lists the tabs,
who sees them, and who can read or void entries. See the SDK reference in the editor (or lcs-sdk.d.ts).
`,
  };
}
