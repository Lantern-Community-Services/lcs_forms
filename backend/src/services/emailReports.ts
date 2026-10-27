import { z } from "zod";
import type { BuiltForm } from "@prisma/client";
import { prisma } from "../prisma.js";
import { appBaseUrl } from "../env.js";
import { badRequest } from "../http.js";
import type { Values } from "../forms/engine.js";
import { ENTRY_CREATED, ROUTE_ID_RE, recipientSchema, type Route } from "../forms/routingSchema.js";
import { checkEmailFields, checkRoutes, emailValues, emailableFields, planRoutes } from "./routing.js";
import { brandedEmail, isInternalAddress } from "./emailTemplate.js";
import { logEmail, mailConfigured, sendLogged } from "./mailer.js";
import { audit, type Actor } from "./audit.js";

/**
 * Weekly summary reports: a form's entries from the past 7 days, emailed on a
 * day and hour (New York time) to the same kinds of people a route can reach.
 * Like the Unit Inspection weekly report: a count, a table of chosen answers,
 * and a button to the entries, either one report for every site or one per
 * site, each to that site's people.
 *
 * The table goes only to Lantern addresses, and only answers that may go in
 * an email at all (routing.ts emailableFields). Anyone else gets the count and
 * the button. Saved per form (FormRecord "email"/"reports"), outside the form,
 * like its routing; sent by startEmailReports, once per week each.
 */

const COLLECTION = "email";
const DOC = "reports";
const TZ = "America/New_York";
const WEEK = 7 * 86_400_000;
/** Most rows in one email; the rest are a count and the button. */
const MAX_ROWS = 200;
/** A report missed for longer than this (the server was down) waits for next week. */
const CATCH_UP_MS = 6 * 3_600_000;

export const reportSchema = z
  .object({
    id: z.string().trim().regex(ROUTE_ID_RE, "An id is letters, numbers, - and _."),
    name: z.string().trim().min(1).max(120),
    enabled: z.boolean().default(true),
    /** 0 Sunday … 6 Saturday. */
    day: z.number().int().min(0).max(6),
    /** 0–23, New York time. */
    hour: z.number().int().min(0).max(23),
    /** One report for every site, or one per site to that site's people. */
    split: z.enum(["all", "site"]).default("all"),
    /** Send even when there were no entries (a "nothing this week" email). */
    includeEmpty: z.boolean().default(false),
    /** The table's columns: ids from emailableFields. */
    fields: z.array(z.string().trim().min(1).max(64)).max(12).default([]),
    to: z.array(recipientSchema).min(1, "A report needs someone to send it to.").max(50),
    whatToDo: z.string().trim().max(500).optional(),
    /** Set by the server when the scheduled report goes. */
    lastSentAt: z.string().nullable().optional(),
  })
  .strict();
export type Report = z.infer<typeof reportSchema>;

export interface ReportsDoc {
  reports: (Report & { nextRun: string | null })[];
  revision: number;
  updatedByName: string | null;
  updatedAt: string | null;
}

// ── New York time ────────────────────────────────────────────────────────

function nyParts(d: Date) {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat("en-US", { timeZone: TZ, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", hourCycle: "h23" })
      .formatToParts(d)
      .map((p) => [p.type, p.value])
  );
  return { y: Number(parts.year), m: Number(parts.month), d: Number(parts.day), h: Number(parts.hour) };
}

/** That calendar day and hour in New York, as an instant. */
function nyToUtc(y: number, m: number, d: number, h: number): Date {
  const want = Date.UTC(y, m - 1, d, h);
  let t = want;
  for (let i = 0; i < 3; i++) {
    const p = nyParts(new Date(t));
    t += want - Date.UTC(p.y, p.m - 1, p.d, p.h);
  }
  return new Date(t);
}

/** The report's latest time slot at or before `now`, or its next one after. */
function slot(report: Pick<Report, "day" | "hour">, now: Date, which: "last" | "next"): Date {
  const p = nyParts(now);
  for (let i = 0; i <= 8; i++) {
    const offset = which === "last" ? -i : i;
    const cal = new Date(Date.UTC(p.y, p.m - 1, p.d + offset));
    if (cal.getUTCDay() !== report.day) continue;
    const at = nyToUtc(cal.getUTCFullYear(), cal.getUTCMonth() + 1, cal.getUTCDate(), report.hour);
    if (which === "last" ? at <= now : at > now) return at;
  }
  return now;
}

const nyDate = (d: Date) => new Intl.DateTimeFormat("en-US", { timeZone: TZ, month: "2-digit", day: "2-digit", year: "numeric" }).format(d);

// ── Saved reports ────────────────────────────────────────────────────────

export async function loadReports(form: BuiltForm): Promise<ReportsDoc> {
  const row = await prisma.formRecord.findUnique({ where: { formId_collection_docId: { formId: form.id, collection: COLLECTION, docId: DOC } } });
  const saved = row ? (JSON.parse(row.data) as { reports?: unknown[]; revision?: number }) : { reports: [], revision: 0 };
  const reports = (saved.reports ?? []).flatMap((r) => {
    const p = reportSchema.safeParse(r);
    return p.success ? [p.data] : [];
  });
  const now = new Date();
  return {
    reports: reports.map((r) => ({ ...r, nextRun: r.enabled ? slot(r, now, "next").toISOString() : null })),
    revision: saved.revision ?? 0,
    updatedByName: row?.updatedByName ?? null,
    updatedAt: row?.updatedAt.toISOString() ?? null,
  };
}

/** A report's recipients as a route, so routing's own checks and planning apply. */
const asRoute = (r: Pick<Report, "id" | "name" | "to">): Route => ({ id: r.id, name: r.name, event: ENTRY_CREATED, enabled: true, to: r.to, email: "always", urgent: false });

/** Check reports against the form: their fields and recipients. */
export async function checkReports(form: BuiltForm, input: unknown[]): Promise<Report[]> {
  const ids = new Set<string>();
  const reports = input.map((raw, i) => {
    const p = reportSchema.safeParse(raw);
    if (!p.success) throw badRequest(`Report ${i + 1}: ${p.error.issues.map((x) => `${x.path.join(".") || "report"}: ${x.message}`).join("; ")}`);
    if (ids.has(p.data.id)) throw badRequest(`Report “${p.data.name}”: another report already has the id "${p.data.id}".`);
    ids.add(p.data.id);
    checkEmailFields(form, p.data.fields, `Report “${p.data.name}”`);
    return p.data;
  });
  // Recipients: the same rules as a route's (known roles, groups, sites).
  await checkRoutes(form, reports.map(asRoute));
  return reports;
}

export async function saveReports(form: BuiltForm, input: unknown[], actor: Actor, revision?: number): Promise<ReportsDoc> {
  if (input.length > 20) throw badRequest("A form can have at most 20 summary reports.");
  const reports = await checkReports(form, input);
  const now = await loadReports(form);
  if (revision !== undefined && revision !== now.revision) throw badRequest("Someone else changed this form's reports while you were editing. Reload and try again.");
  // When each last went is the server's to keep.
  const sent = new Map(now.reports.map((r) => [r.id, r.lastSentAt ?? null]));
  const next = { reports: reports.map((r) => ({ ...r, lastSentAt: sent.get(r.id) ?? null })), revision: now.revision + 1 };
  await writeDoc(form.id, next, actor.name);
  await audit({ actor, action: "forms.reports_changed", summary: `Changed “${form.title}”'s summary reports (${reports.length})` }).catch(() => undefined);
  return loadReports(form);
}

async function writeDoc(formId: string, data: { reports: Report[]; revision: number }, by: string) {
  await prisma.formRecord.upsert({
    where: { formId_collection_docId: { formId, collection: COLLECTION, docId: DOC } },
    create: { formId, collection: COLLECTION, docId: DOC, data: JSON.stringify(data), updatedByName: by.slice(0, 255) },
    update: { data: JSON.stringify(data), updatedByName: by.slice(0, 255) },
  });
}

// ── Building and sending ─────────────────────────────────────────────────

export interface ReportEmail {
  to: string;
  subject: string;
  site: string;
  entries: number;
  withAnswers: boolean;
  html: string;
}

/** Everyone a report would send, for each site: built, not sent. */
export async function buildReport(form: BuiltForm, report: Report, now = new Date()): Promise<{ emails: ReportEmail[]; notes: string[] }> {
  const since = new Date(now.getTime() - WEEK);
  const entries = await prisma.formEntry.findMany({
    where: { formId: form.id, status: "active", source: { not: "preview" }, createdAt: { gte: since, lt: now } },
    orderBy: { createdAt: "asc" },
    select: { data: true, siteId: true, createdAt: true, createdByName: true, followUp: true },
  });
  const sites = await prisma.site.findMany({ where: { active: true }, select: { id: true, code: true, name: true }, orderBy: { name: "asc" } });
  const siteBy = new Map(sites.map((s) => [s.id, s]));

  const groups: { label: string; site: (typeof sites)[number] | null; rows: typeof entries }[] = [];
  if (report.split === "all") {
    groups.push({ label: "All Sites", site: null, rows: entries });
  } else {
    for (const s of sites) {
      const rows = entries.filter((e) => e.siteId === s.id);
      if (rows.length || report.includeEmpty) groups.push({ label: s.name, site: s, rows });
    }
    const noSite = entries.filter((e) => !e.siteId || !siteBy.has(e.siteId));
    if (noSite.length) groups.push({ label: "No site", site: null, rows: noSite });
  }

  const columns = emailableFields(form).filter((f) => report.fields.includes(f.id));
  const notes: string[] = [];
  const emails: ReportEmail[] = [];
  const url = `${appBaseUrl}${form.kind === "code" ? `/apps/${form.slug}` : `/f/${form.slug}/entries`}`;

  for (const g of groups) {
    if (!g.rows.length && !report.includeEmpty) continue;
    const [plan] = await planRoutes(form, [asRoute(report)], { event: ENTRY_CREATED, title: report.name, site: g.site });
    if (!plan) continue;
    notes.push(...plan.notes.map((n) => `${g.label}: ${n}`));
    const addresses = [...plan.people.map((p) => p.email), ...plan.emails];
    if (!addresses.length) {
      notes.push(`${g.label}: nobody to send it to.`);
      continue;
    }
    const shown = g.rows.slice(-MAX_ROWS).reverse();
    const rows = shown.map((e) => {
      const site = e.siteId ? siteBy.get(e.siteId) ?? null : null;
      const values = emailValues(form, report.fields, { data: JSON.parse(e.data) as Values, site, createdAt: e.createdAt, byName: e.createdByName, followUp: e.followUp });
      return columns.map((c) => values.find((v) => v.label === c.label)?.value ?? "");
    });
    const subject = `${report.name} - ${g.label} - ${nyDate(now)}`.slice(0, 200);
    const count = g.rows.length;
    const open = g.rows.filter((e) => e.followUp === "open").length;
    for (const to of [...new Set(addresses.map((a) => a.toLowerCase()))]) {
      const withAnswers = isInternalAddress(to) && columns.length > 0 && rows.length > 0;
      emails.push({
        to,
        subject,
        site: g.label,
        entries: count,
        withAnswers,
        html: brandedEmail({
          kicker: form.title,
          heading: `${report.name}: ${g.label}`,
          intro: count
            ? `Entries submitted in the past 7 days: ${count}${g.rows.some((e) => e.followUp) ? ` (${open} still open)` : ""}`
            : `No entries were submitted for ${g.label} in the past 7 days.`,
          whatToDo: report.whatToDo,
          table: withAnswers ? { columns: columns.map((c) => c.label), rows, more: Math.max(0, count - shown.length) } : null,
          button: { label: "Open the entries", url },
          note: withAnswers || !count ? null : "The entries aren't in this email. Sign in to see them.",
        }),
      });
    }
  }
  return { emails, notes };
}

/** Send a report now (or say what it would send). Each address gets its own email. */
export async function sendReport(form: BuiltForm, report: Report, opts: { actor: Actor; dryRun?: boolean; now?: Date }) {
  const { emails, notes } = await buildReport(form, report, opts.now);
  const summary = emails.map(({ html: _html, ...e }) => e);
  if (opts.dryRun) return { sent: 0, emails: summary, notes, preview: emails.find((e) => e.withAnswers)?.html ?? emails[0]?.html ?? null };
  let sent = 0;
  for (const e of emails) {
    if (!mailConfigured()) {
      await logEmail({ to: e.to, subject: e.subject, kind: "report", status: "skipped", formId: form.id, error: "Email isn't set up on this server (MAIL_FROM)." });
      continue;
    }
    try {
      await sendLogged({ to: [e.to], subject: e.subject, html: e.html, kind: "report", formId: form.id, withAnswers: e.withAnswers });
      sent++;
    } catch (err) {
      notes.push(`${e.to}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  await audit({ actor: opts.actor, action: "forms.report_sent", summary: `“${form.title}” sent “${report.name}” to ${sent} of ${emails.length}` }).catch(() => undefined);
  return { sent, emails: summary, notes, preview: null };
}

// ── The weekly run ───────────────────────────────────────────────────────

const SYSTEM: Actor = { id: null, name: "Summary reports" };

/** Sends every report whose weekly slot has come and that hasn't gone for it. */
export async function runDueReports(now = new Date()): Promise<number> {
  const rows = await prisma.formRecord.findMany({ where: { collection: COLLECTION, docId: DOC }, select: { formId: true } });
  let ran = 0;
  for (const { formId } of rows) {
    const form = await prisma.builtForm.findUnique({ where: { id: formId } });
    if (!form || form.status === "archived") continue;
    const doc = await loadReports(form);
    for (const r of doc.reports) {
      if (!r.enabled) continue;
      const due = slot(r, now, "last");
      if (now.getTime() - due.getTime() > CATCH_UP_MS) continue;
      if (r.lastSentAt && new Date(r.lastSentAt) >= due) continue;
      // Claim it first, so a restart mid-send doesn't send it twice.
      const fresh = await loadReports(form);
      const next = fresh.reports.map(({ nextRun: _n, ...x }) => (x.id === r.id ? { ...x, lastSentAt: now.toISOString() } : x));
      await writeDoc(form.id, { reports: next, revision: fresh.revision }, "Summary reports");
      const { nextRun: _next, ...report } = r;
      await sendReport(form, report, { actor: SYSTEM, now }).catch((err) => console.error(`[reports] ${form.slug} “${r.name}” failed:`, err));
      ran++;
    }
  }
  return ran;
}

let timer: NodeJS.Timeout | null = null;

export function startEmailReports() {
  if (timer) return;
  const tick = () => void runDueReports().catch((err) => console.error("[reports] run failed:", err));
  timer = setInterval(tick, 5 * 60_000);
  timer.unref();
  setTimeout(tick, 30_000).unref();
}
