import type { FormDoc, Values } from "@/lib/formEngine";

/**
 * The pure half of saving unfinished answers to the person's account
 * (serverDrafts.tsx; backend services/formDrafts.ts): what the device keeps,
 * and how its copy and the account's drafts are put together when the form
 * opens. No React and no storage here, so it can be checked on its own.
 */

/** The device's copy of the answers being filled in (localStorage, FillPage's draftKey). */
export interface LocalDraft {
  values: Values;
  savedAt: number;
  /** When the person first answered something (the entry's time to fill). */
  startedAt: number;
  /** The account draft these answers belong to (made on the device, so it exists before the first save). */
  draftId?: string | null;
  /** When the account last had them, as the server said; null until the first save got through. */
  base?: string | null;
  /** Changed on the device since the account last had them. Copies kept before account drafts have none: unsent. */
  pending?: boolean;
  /** The open copy of the form (random per page load) that kept them, and sends them to the account. */
  writer?: string;
  siteCode?: string | null;
  page?: number;
  label?: string;
}

/** An account draft as the list gives it (no answers). */
export interface DraftSummary {
  id: string;
  label: string;
  siteCode: string | null;
  page: number;
  formVersion: number;
  /** The open copy of the form that saved it last. */
  writer: string | null;
  createdAt: string;
  updatedAt: string;
}

/** One draft the person can carry on with. */
export interface DraftChoice {
  id: string;
  label: string;
  /** When it was last saved (ms). */
  savedAt: number;
  startedAt: number;
  /** Its answers are this device's copy (newer than the account's, or not on the account yet); else they're fetched. */
  fromDevice: boolean;
  summary: DraftSummary | null;
}

export interface Reconciled {
  choices: DraftChoice[];
  /**
   * The device's copy to send to the account before offering the list: `id` is
   * the draft it goes to and `base` what the device last saw of it (null: a new
   * draft). Null when the device has nothing the account lacks.
   */
  push: { id: string; base: string | null; draft: LocalDraft } | null;
  /** The device's copy belonged to a draft that's gone from the account (filed or discarded elsewhere): forget it. */
  dropLocal: boolean;
}

/**
 * Put the device's copy and the account's drafts together. Never compares the
 * device's clock with the server's: the device remembers which save of the
 * account's draft it last saw (`base`) and whether it has changed since
 * (`pending`).
 *
 *   on the account, unchanged since this device saved it, and nothing new here: offer the account's
 *   on the account, unchanged since, and newer answers here: send them, offer them
 *   on the account and changed elsewhere, nothing new here: the account's wins
 *   changed both here and elsewhere: both are kept; this device's goes up as a separate draft
 *   never got to the account (offline, or kept before account drafts): send it as a new draft
 *   got to the account once and isn't there now: filed or discarded on another device, so dropped
 *
 * `newId` makes the id for a draft that's going up for the first time.
 */
export function reconcileDrafts(local: LocalDraft | null, server: DraftSummary[], newId: () => string): Reconciled {
  const choices: DraftChoice[] = server.map((s) => ({
    id: s.id,
    label: s.label,
    savedAt: Date.parse(s.updatedAt),
    startedAt: Date.parse(s.createdAt),
    fromDevice: false,
    summary: s,
  }));
  let push: Reconciled["push"] = null;
  let dropLocal = false;
  const usable = local && local.values && typeof local.savedAt === "number" && typeof local.startedAt === "number" ? local : null;
  if (usable) {
    const pending = usable.pending !== false;
    const twin = usable.draftId ? server.find((s) => s.id === usable.draftId) : undefined;
    const asDevice = (id: string): DraftChoice => ({ id, label: usable.label || twin?.label || "Draft", savedAt: usable.savedAt, startedAt: usable.startedAt, fromDevice: true, summary: twin ?? null });
    if (twin) {
      // The account's copy is still the one this device last saw, or the last save was this device's own
      // (sent as the page closed, with no answer back): nobody else has changed it.
      if (usable.base === twin.updatedAt || (usable.writer && twin.writer === usable.writer)) {
        // This device's answers are the newest (and still have their signatures, which the
        // account doesn't keep). Sent up first if they changed since.
        if (pending) push = { id: twin.id, base: twin.updatedAt, draft: usable };
        choices[choices.findIndex((c) => c.id === twin.id)] = asDevice(twin.id);
      } else if (pending) {
        // Changed here and on another device: neither overwrites the other.
        const id = newId();
        push = { id, base: null, draft: { ...usable, draftId: id, base: null } };
        choices.push({ ...asDevice(id), summary: null });
      }
      // Not changed here: the account's copy is the one to carry on with.
    } else if (usable.draftId && usable.base) {
      dropLocal = true;
    } else if (pending) {
      const id = usable.draftId || newId();
      push = { id, base: null, draft: { ...usable, draftId: id } };
      choices.push(asDevice(id));
    }
  }
  choices.sort((a, b) => b.savedAt - a.savedAt);
  return { choices, push, dropLocal };
}

/** Not sent to the account (the server leaves them out too): signatures are big pictures, and files unattached to an entry are swept after a day. */
const DEVICE_ONLY = new Set(["signature", "file"]);

/**
 * The answers as the account keeps them: without signatures and files (neither
 * can be inside a repeater). `dropped`: a signature or file was answered, so the
 * page says those stay on this device.
 */
export function valuesForAccount(doc: Pick<FormDoc, "fields">, values: Values): { values: Values; dropped: boolean } {
  const out: Values = { ...values };
  let dropped = false;
  for (const f of doc.fields) {
    if (!DEVICE_ONLY.has(f.type) || !(f.id in out)) continue;
    const v = out[f.id];
    if (v !== "" && v != null && !(Array.isArray(v) && !v.length)) dropped = true;
    delete out[f.id];
  }
  return { values: out, dropped };
}

/** A short name to tell drafts apart: the resident picked (the first Resident question answered), else "Draft". Same rule as the server's. */
export function draftLabelOf(doc: Pick<FormDoc, "fields">, values: Values): string {
  for (const f of doc.fields) {
    if (f.type !== "resident") continue;
    const name = (values[f.id] as { name?: unknown } | undefined)?.name;
    if (typeof name === "string" && name.trim()) return name.trim().slice(0, 120);
  }
  return "Draft";
}
