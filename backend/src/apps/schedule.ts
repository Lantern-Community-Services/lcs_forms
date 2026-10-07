import { prisma } from "../prisma.js";
import { loadApp, runAction } from "./runtime.js";
import { readManifest, type Files } from "./project.js";
import * as time from "./time.js";

/**
 * Code forms' scheduled actions (form.json "schedule"): reminders, digests, a
 * monthly report email. A minute timer runs each published form's due actions
 * once a New York day, as nobody in particular (ctx.user null; args
 * { scheduled: true, day }). A run missed while the server was down happens
 * when it's back, later that same day. The last run day is kept per form and
 * action in FormRecord's private "__schedule" collection, written before the run
 * so two servers or a slow run can't send twice.
 */

const TICK_MS = 60_000;
const COLLECTION = "__schedule";

export interface ScheduleItem {
  action: string;
  /** "HH:MM", New York. */
  at: string;
  /** daily (default), weekdays (Mon–Fri), or monthly on `day` (1–28). */
  on?: "daily" | "weekdays" | "monthly";
  day?: number;
}

/** Is this item due on `day`, at or after its time? */
export function isDue(item: ScheduleItem, day: string, hhmm: string): boolean {
  if (hhmm < item.at) return false;
  const weekday = new Date(`${day}T12:00:00Z`).getUTCDay();
  if (item.on === "weekdays") return weekday >= 1 && weekday <= 5;
  if (item.on === "monthly") return Number(day.slice(8, 10)) === (item.day ?? 1);
  return true;
}

function nowNY() {
  const now = new Date();
  return { day: time.dayOf(now), hhmm: new Intl.DateTimeFormat("en-GB", { timeZone: time.TZ, hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).format(now) };
}

/** Claim today's run: true when this call is the one that should run it. */
async function claim(formId: string, action: string, day: string): Promise<boolean> {
  const docId = action;
  const row = await prisma.formRecord.findUnique({ where: { formId_collection_docId: { formId, collection: COLLECTION, docId } } });
  const last = row ? (JSON.parse(row.data) as { day?: string }).day : undefined;
  if (last === day) return false;
  const data = JSON.stringify({ day, at: new Date().toISOString() });
  if (!row) {
    try {
      await prisma.formRecord.create({ data: { formId, collection: COLLECTION, docId, data, updatedByName: "Schedule" } });
      return true;
    } catch {
      return false; // someone else just claimed it
    }
  }
  // Only if nobody changed it since we read it.
  const res = await prisma.formRecord.updateMany({ where: { id: row.id, updatedAt: row.updatedAt }, data: { data } });
  return res.count === 1;
}

let running = false;

export async function runDueSchedules(at = nowNY()): Promise<{ ran: string[]; failed: string[] }> {
  const ran: string[] = [];
  const failed: string[] = [];
  const forms = await prisma.builtForm.findMany({ where: { kind: "code", status: "published", liveSchema: { not: null } } });
  for (const form of forms) {
    let items: ScheduleItem[] = [];
    try {
      const files = (JSON.parse(form.liveSchema!) as { files: Files }).files;
      items = readManifest(files).manifest?.schedule ?? [];
    } catch {
      continue;
    }
    for (const item of items) {
      if (!isDue(item, at.day, at.hhmm)) continue;
      if (!(await claim(form.id, item.action, at.day))) continue;
      const label = `${form.slug}.${item.action}`;
      try {
        const app = await loadApp(form, false);
        const r = await runAction(app, null, item.action, { scheduled: true, day: at.day });
        if (r.ok) ran.push(label);
        else {
          failed.push(label);
          console.error(`[schedule] ${label} failed:`, r.error, r.logs?.join(" | "));
        }
      } catch (err) {
        failed.push(label);
        console.error(`[schedule] ${label} failed:`, err);
      }
    }
  }
  return { ran, failed };
}

export function startScheduler(): boolean {
  if (process.env.SCHEDULE_DISABLED === "true") return false;
  const tick = () => {
    if (running) return;
    running = true;
    runDueSchedules()
      .then((r) => r.ran.length && console.log(`  Schedule: ran ${r.ran.join(", ")}`))
      .catch((err) => console.error("[schedule] tick failed:", err))
      .finally(() => (running = false));
  };
  setTimeout(tick, 15_000).unref();
  setInterval(tick, TICK_MS).unref();
  return true;
}
