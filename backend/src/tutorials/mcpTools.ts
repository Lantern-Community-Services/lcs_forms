import { z } from "zod";
import { appBaseUrl } from "../env.js";
import { HttpError } from "../http.js";
import type { Actor } from "../services/audit.js";
import type { ToolRegistrar } from "../forms/mcp.js";
import { APP_TUTORIAL_TARGETS, FORM_TUTORIAL_TARGETS, lintTutorial, pagesOf, type FormTutorial } from "../forms/engine.js";
import { DocError, findAnyForm, readDoc, saveDraft } from "../forms/service.js";
import { buildProject } from "../apps/compile.js";
import { draftFiles, patchFiles } from "../apps/service.js";
import { manifestSchema, type Files } from "../apps/project.js";
import { pageAnchors, tutorialAnchorWarnings } from "../apps/tutorialAnchors.js";
import { tutorialSchema } from "./schema.js";
import { formTutorialProgress } from "./progress.js";
import { TUTORIAL_GUIDE } from "./guide.js";

/**
 * MCP tools for a form's guided tutorial (forms/engine.ts FormTutorial): read
 * it with what its steps can point at, set or remove it in the draft, and see
 * who has been through it. A basic form's tutorial is in its document (scope
 * forms:build), a code form's in form.json (scope apps:build); either way it's
 * part of the draft until the form is published.
 */
export function registerTutorialTools(tool: ToolRegistrar, need: (scope: string) => void, actor: Actor) {
  const ref = z.string().describe("The form's id or slug — a basic form or a code form.");

  const tryUrls = (row: { kind: string; slug: string }) =>
    row.kind === "code"
      ? { tryDraft: `${appBaseUrl}/apps/${row.slug}?draft=1&tour=1`, tryLive: `${appBaseUrl}/apps/${row.slug}?tour=1` }
      : { tryDraft: `${appBaseUrl}/f/${row.slug}/preview?tour=1`, tryLive: `${appBaseUrl}/f/${row.slug}?tour=1` };

  const scopeFor = (kind: string) => (kind === "code" ? "apps:build" : "forms:build");

  /** form.json as an object (the draft's), and its tutorial. */
  function manifestOf(files: Files): Record<string, unknown> {
    try {
      const m = JSON.parse(files["form.json"] ?? "");
      if (m && typeof m === "object" && !Array.isArray(m)) return m as Record<string, unknown>;
    } catch {
      /* falls through */
    }
    throw new HttpError(400, "The draft's form.json isn't valid JSON. Fix it first (read_files / edit_file).");
  }

  const liveTutorial = (row: { kind: string; liveSchema: string | null }): FormTutorial | null => {
    if (!row.liveSchema) return null;
    try {
      if (row.kind !== "code") return readDoc(row.liveSchema).tutorial ?? null;
      const live = JSON.parse(row.liveSchema) as { files: Files };
      return (JSON.parse(live.files["form.json"] ?? "{}").tutorial as FormTutorial | undefined) ?? null;
    } catch {
      return null;
    }
  };

  tool(
    "get_tutorial_reference",
    "How to write a form's guided tutorial: its shape, step actions (next / click / fill), what a step can point at on basic and code forms (fields, the submit button, data-tour anchors, tabs), how to write for site staff on phones, how to try it, and examples. Read before set_tutorial.",
    {},
    async () => TUTORIAL_GUIDE(),
    { readOnlyHint: true }
  );

  tool(
    "get_tutorial",
    "A form's tutorial — the draft's and the live one — plus everything a step can point at: a basic form's fields (id, type, label, page) and named targets, or a code form's pages with the data-tour anchors found in each and the app's own targets. Also links to try it.",
    { form: ref },
    async ({ form }) => {
      const row = await findAnyForm(form);
      need(scopeFor(row.kind));
      const live = liveTutorial(row);
      if (row.kind === "code") {
        const files = draftFiles(row);
        const raw = manifestOf(files);
        const parsed = manifestSchema.safeParse(raw);
        const pages = Array.isArray(raw.pages) ? (raw.pages as { id?: string; label?: string; roles?: string[]; hidden?: boolean }[]) : [];
        const anchors = parsed.success ? pageAnchors(files, parsed.data) : {};
        return {
          kind: "code",
          id: row.id,
          slug: row.slug,
          revision: row.revision,
          draft: raw.tutorial ?? null,
          live,
          unpublishedChanges: JSON.stringify(raw.tutorial ?? null) !== JSON.stringify(live),
          targets: {
            pages: pages.map((p) => ({ id: p.id, label: p.label, roles: p.roles ?? "everyone", hidden: Boolean(p.hidden), anchors: anchors[p.id ?? ""] ?? [] })),
            app: APP_TUTORIAL_TARGETS,
            note: "anchors are the data-tour values written out in each page's code (and files it shares). Add one with edit_file: <div data-tour=\"name\">.",
          },
          warnings: parsed.success ? tutorialAnchorWarnings(files, parsed.data).map((w) => w.message) : ["form.json doesn't pass its checks; build_code_form shows why."],
          ...tryUrls(row),
        };
      }
      const doc = readDoc(row.draftSchema);
      const pageOf = new Map(pagesOf(doc).flatMap((p, i) => p.fields.map((f) => [f.id, i + 1] as const)));
      return {
        kind: "basic",
        id: row.id,
        slug: row.slug,
        revision: row.revision,
        draft: doc.tutorial ?? null,
        live,
        unpublishedChanges: JSON.stringify(doc.tutorial ?? null) !== JSON.stringify(live),
        targets: {
          fields: doc.fields
            .filter((f) => f.type !== "hidden" && f.type !== "page")
            .map((f) => ({ id: f.id, type: f.type, label: f.label, page: pageOf.get(f.id) ?? 1, ...(f.required ? { required: true } : {}), ...(f.conditional ? { conditional: true } : {}) })),
          pages: pagesOf(doc).length,
          named: FORM_TUTORIAL_TARGETS,
          requireSite: Boolean(doc.settings.requireSite),
        },
        ...tryUrls(row),
      };
    },
    { readOnlyHint: true }
  );

  tool(
    "set_tutorial",
    "Set a form's tutorial in its draft (replacing any there). Checked like the rest of the form: unknown fields, pages or targets are refused; a code form's missing data-tour anchors come back as warnings. showAgain: true raises the version past the live one, so once published it starts again for everyone who saw the old one. Publish to make it live.",
    {
      form: ref,
      tutorial: z.record(z.unknown()).describe("The tutorial: { title?, autoStart?, roles?, version?, steps: [...] } — see get_tutorial_reference"),
      showAgain: z.boolean().optional().describe("Show it again to people who finished or skipped the live one"),
      revision: z.number().int().optional().describe("The revision you read (get_tutorial), to avoid overwriting someone else's save"),
    },
    async ({ form, tutorial, showAgain, revision }) => {
      const row = await findAnyForm(form);
      need(scopeFor(row.kind));
      const parsed = tutorialSchema.safeParse(tutorial);
      if (!parsed.success) throw new DocError(parsed.error.issues.slice(0, 30).map((i) => ({ path: `tutorial.${i.path.join(".")}`.replace(/\.$/, ""), message: i.message })));
      const next = parsed.data as FormTutorial;
      // The version people have seen: the live tutorial's (0 when nothing's live).
      const live = liveTutorial(row);
      const liveV = live ? (live.version ?? 1) : 0;

      if (row.kind === "code") {
        const files = draftFiles(row);
        const raw = manifestOf(files);
        const draftV = (raw.tutorial as FormTutorial | undefined)?.version ?? 1;
        next.version = tutorial.version !== undefined ? next.version : showAgain ? Math.max(draftV, liveV + 1) : draftV;
        const pages = new Set(Array.isArray(raw.pages) ? (raw.pages as { id?: string }[]).map((p) => String(p.id)) : []);
        const problems = lintTutorial(next, { kind: "code", pages });
        if (problems.length) throw new DocError(problems);
        const saved = await patchFiles(row.id, { "form.json": `${JSON.stringify({ ...raw, tutorial: next }, null, 2)}\n` }, actor, revision);
        const build = await buildProject(draftFiles(saved));
        return {
          saved: true,
          revision: saved.revision,
          steps: next.steps.length,
          version: next.version,
          builds: build.ok,
          ...(build.ok ? { warnings: build.build.warnings.filter((w) => w.message.startsWith("tutorial.")).map((w) => w.message) } : { problems: build.problems.map((p) => `${p.file}: ${p.message}`) }),
          next: "publish_code_form to make it live.",
          ...tryUrls(saved),
        };
      }

      const doc = readDoc(row.draftSchema);
      const draftV = doc.tutorial?.version ?? 1;
      next.version = tutorial.version !== undefined ? next.version : showAgain ? Math.max(draftV, liveV + 1) : draftV;
      const saved = await saveDraft(row.id, { doc: { ...doc, tutorial: next }, revision }, actor);
      return { saved: true, revision: saved.revision, steps: next.steps.length, version: next.version, next: "publish_form to make it live.", ...tryUrls(saved) };
    }
  );

  tool(
    "remove_tutorial",
    "Take the tutorial out of a form's draft (publish to take it off the live form). The record of who saw it stays.",
    { form: ref, revision: z.number().int().optional() },
    async ({ form, revision }) => {
      const row = await findAnyForm(form);
      need(scopeFor(row.kind));
      if (row.kind === "code") {
        const files = draftFiles(row);
        const { tutorial: _gone, ...rest } = manifestOf(files);
        const saved = await patchFiles(row.id, { "form.json": `${JSON.stringify(rest, null, 2)}\n` }, actor, revision);
        return { removed: true, revision: saved.revision, next: "publish_code_form to take it off the live form." };
      }
      const { tutorial: _gone, ...doc } = readDoc(row.draftSchema);
      const saved = await saveDraft(row.id, { doc, revision }, actor);
      return { removed: true, revision: saved.revision, next: "publish_form to take it off the live form." };
    }
  );

  tool(
    "tutorial_progress",
    "Who has been through a form's tutorial: how many finished or skipped it (per version), at which step people skip, and the most recent people.",
    { form: ref, limit: z.number().int().min(1).max(200).optional().describe("How many recent people to list (default 25)") },
    async ({ form, limit }) => {
      const row = await findAnyForm(form);
      need(scopeFor(row.kind));
      const live = liveTutorial(row);
      return { form: { id: row.id, slug: row.slug, title: row.title }, liveVersion: live ? (live.version ?? 1) : null, liveSteps: live?.steps.length ?? 0, ...(await formTutorialProgress(row.id, { limit })) };
    },
    { readOnlyHint: true }
  );
}
