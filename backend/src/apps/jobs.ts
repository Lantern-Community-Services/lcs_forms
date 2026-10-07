import type { FormJob } from "@prisma/client";
import { prisma } from "../prisma.js";
import { currentUserById, type CurrentUser } from "../auth/middleware.js";
import { createEntry, loadApp, type LoadedApp } from "./runtime.js";
import { fileIdsIn } from "./files.js";

/**
 * Entries one code form makes in another (ctx.db.form(slug).entries.create):
 * an encounter's bundled Hot Foods meals, incentives and content releases. The
 * call queues a job and returns; a worker in this process then saves it through
 * the other form's own rules (its beforeCreate, limits, overrides), as the person
 * who caused it. Doing it after the call — not inside it — keeps one sandbox from
 * waiting on another. Files the entry refers to are copied into the other form.
 *
 * The other form must accept them: its form.json "share": { "create": ["<this slug>"] }.
 */

export interface JobInput {
  data: unknown;
  site?: string | null;
  tenantId?: string | null;
  occurredAt?: string | null;
  override?: string | null;
  /** Shown in the source's list of what it made ("Hot Foods for Ana R."). */
  label?: string | null;
}

const TICK_MS = 30_000;
const MAX_PER_CALL = 200;
let timer: NodeJS.Timeout | null = null;
let running = false;

/** Does `target` take entries from `source`? */
async function accepting(sourceSlug: string, targetSlug: string): Promise<LoadedApp> {
  const target = await prisma.builtForm.findUnique({ where: { slug: targetSlug } });
  if (!target || target.kind !== "code") throw new Error(`No code form "${targetSlug}".`);
  const app = await loadApp(target, false).catch(() => null);
  if (!app) throw new Error(`"${targetSlug}" isn't published.`);
  if (!app.manifest.share?.create?.includes(sourceSlug)) throw new Error(`"${targetSlug}" doesn't take entries from this form: its form.json needs "share": { "create": ["${sourceSlug}"] }.`);
  return app;
}

const queuedThisCall = new WeakMap<object, number>();

/** Queue an entry for another form. In the draft nothing is made. */
export async function enqueueJob(source: LoadedApp, user: CurrentUser | null, args: { form?: unknown; entry?: unknown; sourceEntryId?: unknown; callKey?: object }) {
  const targetSlug = String(args.form ?? "");
  if (!(source.manifest.reads ?? []).includes(targetSlug)) throw new Error(`Add "${targetSlug}" to "reads" in form.json to make its entries.`);
  await accepting(source.form.slug, targetSlug);
  const e = (args.entry ?? {}) as JobInput & { sourceEntryId?: string };
  if (!e.data || typeof e.data !== "object" || Array.isArray(e.data)) throw new Error("entries.create needs { data: {...} }.");
  if (args.callKey) {
    const n = (queuedThisCall.get(args.callKey) ?? 0) + 1;
    if (n > MAX_PER_CALL) throw new Error(`At most ${MAX_PER_CALL} entries in other forms per call.`);
    queuedThisCall.set(args.callKey, n);
  }
  if (source.draft) return { queued: false, reason: `The draft (preview) doesn't make entries in "${targetSlug}".` };
  const input: JobInput = { data: e.data, site: e.site ?? null, tenantId: e.tenantId ?? null, occurredAt: e.occurredAt ?? null, override: e.override ?? null, label: typeof e.label === "string" ? e.label.slice(0, 200) : null };
  const json = JSON.stringify(input);
  if (json.length > 1_000_000) throw new Error("That entry is too big (1 MB max).");
  const job = await prisma.formJob.create({
    data: {
      formId: source.form.id,
      sourceEntryId: typeof (args.sourceEntryId ?? e.sourceEntryId) === "string" ? String(args.sourceEntryId ?? e.sourceEntryId) : null,
      targetSlug,
      input: json,
      userId: user?.userId ?? null,
      userName: user?.name ?? source.manifest.title,
    },
  });
  kick();
  return { queued: true, jobId: job.id };
}

/** Copy the files an entry refers to from the source form into the target, rewriting their ids. */
async function copyFiles(sourceFormId: string, targetFormId: string, data: unknown, createdById: string | null) {
  const ids = [...fileIdsIn(data)].filter((id) => !id.startsWith("local:"));
  if (!ids.length) return data;
  const rows = await prisma.formFile.findMany({ where: { id: { in: ids }, formId: sourceFormId } });
  const map = new Map<string, string>();
  for (const f of rows) {
    const copy = await prisma.formFile.create({ data: { formId: targetFormId, fieldId: f.fieldId, name: f.name, mime: f.mime, size: f.size, data: f.data, createdById } });
    map.set(f.id, copy.id);
  }
  const walk = (v: unknown, depth = 0): unknown => {
    if (depth > 20 || !v || typeof v !== "object") return v;
    if (Array.isArray(v)) return v.map((x) => walk(x, depth + 1));
    const o = { ...(v as Record<string, unknown>) };
    if (typeof o.fileId === "string" && map.has(o.fileId)) o.fileId = map.get(o.fileId)!;
    for (const k of Object.keys(o)) if (k !== "fileId") o[k] = walk(o[k], depth + 1);
    return o;
  };
  return walk(data);
}

async function runOne(job: FormJob) {
  const claimed = await prisma.formJob.updateMany({ where: { id: job.id, status: "queued" }, data: { status: "running", attempts: { increment: 1 } } });
  if (!claimed.count) return;
  const fail = (error: string) => prisma.formJob.update({ where: { id: job.id }, data: { status: "failed", error: error.slice(0, 1000) } });
  try {
    const source = await prisma.builtForm.findUnique({ where: { id: job.formId }, select: { slug: true } });
    if (!source) return void (await fail("The form that asked for it is gone."));
    const target = await accepting(source.slug, job.targetSlug);
    const user = job.userId ? await currentUserById(job.userId) : null;
    const input = JSON.parse(job.input) as JobInput;
    const data = await copyFiles(job.formId, target.form.id, input.data, user?.userId ?? null);
    // The job's id makes a retry find the entry an earlier try already saved.
    const out = await createEntry(target, user, { data, site: input.site, tenantId: input.tenantId, occurredAt: input.occurredAt, override: input.override, clientId: `job:${job.id}` }, {
      actorName: job.userName,
      source: `form:${source.slug}`,
      viaForm: true,
    });
    if (out.status === "saved") await prisma.formJob.update({ where: { id: job.id }, data: { status: "done", error: null, resultEntryId: out.entry.id } });
    else if (out.status === "needs_override") await fail(`Needs a reason: ${out.problems.join("; ")}`);
    else await fail(out.message);
  } catch (err) {
    await fail(err instanceof Error ? err.message : String(err));
  }
}

export async function runJobs(): Promise<number> {
  if (running) return 0;
  running = true;
  let n = 0;
  try {
    for (;;) {
      const batch = await prisma.formJob.findMany({ where: { status: "queued" }, orderBy: { createdAt: "asc" }, take: 20 });
      if (!batch.length) break;
      for (const job of batch) {
        await runOne(job);
        n++;
      }
    }
  } finally {
    running = false;
  }
  return n;
}

function kick(delay = 300) {
  if (timer) return;
  timer = setTimeout(() => {
    timer = null;
    void runJobs().catch((err) => console.error("[jobs] run failed:", err));
  }, delay);
  timer.unref?.();
}

export function startJobs() {
  // Anything left "running" by a stopped server goes again.
  void prisma.formJob.updateMany({ where: { status: "running" }, data: { status: "queued" } }).then(() => kick(2_000));
  setInterval(() => kick(0), TICK_MS).unref();
}

/** The jobs a source entry made, for its page (ctx.jobs.list). */
export async function jobsFor(formId: string, sourceEntryId: string) {
  const rows = await prisma.formJob.findMany({ where: { formId, sourceEntryId }, orderBy: { createdAt: "asc" } });
  return rows.map((j) => ({ id: j.id, form: j.targetSlug, status: j.status, error: j.error, entryId: j.resultEntryId, label: (JSON.parse(j.input) as { label?: string }).label ?? null, at: j.updatedAt.toISOString() }));
}

/** Send a failed job again, optionally with a reason for the other form's rules. */
export async function retryJob(formId: string, jobId: string, override?: string | null) {
  const job = await prisma.formJob.findFirst({ where: { id: jobId, formId } });
  if (!job) throw new Error("No such job.");
  if (job.status !== "failed") throw new Error("Only a failed one can be sent again.");
  const input = JSON.parse(job.input) as JobInput;
  if (override?.trim()) input.override = override.trim().slice(0, 500);
  await prisma.formJob.update({ where: { id: job.id }, data: { status: "queued", error: null, input: JSON.stringify(input) } });
  kick();
  return { queued: true };
}
