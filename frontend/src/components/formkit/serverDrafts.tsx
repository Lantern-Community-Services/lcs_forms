import { useCallback, useEffect, useRef, useState } from "react";
import { Loader2, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { API_BASE, ApiError, api } from "@/lib/api";
import type { FormDoc, Values } from "@/lib/formEngine";
import { draftLabelOf, reconcileDrafts, valuesForAccount, type DraftChoice, type DraftSummary, type LocalDraft } from "./draftReconcile";

/**
 * Unfinished answers to a basic form, kept in the person's account as well as
 * on the device, so a long form (the Psychosocial's 9 pages) can be carried on
 * with another day or on another device (backend services/formDrafts.ts).
 *
 * The device's copy (localStorage, FillPage's draftKey) is still written first
 * on every change, and is all there is with no connection: nothing here may
 * ever stop someone filling the form in or sending it. The account copy goes
 * up a few seconds after they stop typing, when the page is hidden or closed,
 * and when they leave the form; when it can't (offline, the server down), the
 * page says "Saved on this device" and tries again later.
 *
 * Requests here never go through the service worker's stored copies
 * (public/sw.js bypassApi): a stored list could offer a draft that's already
 * been filed, and clinical answers have no business in that cache.
 */

/** The account copy goes up this long after the last change. */
const SAVE_AFTER_MS = 3000;
/** After a failed save (offline, a 500), try again this much later even if nothing changes. */
const RETRY_AFTER_MS = 30_000;
/** Opening the form waits this long for the account's drafts, then goes on with the device's copy. */
const LIST_WAIT_MS = 3000;
/** A save sent as the page closes must be small to be allowed to finish (keepalive's 64 KB). */
const KEEPALIVE_MAX = 60_000;

export const newDraftId = () => (crypto.randomUUID ? crypto.randomUUID() : `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 12)}`);

const draftsPath = (slug: string, id?: string) => `/f/${encodeURIComponent(slug)}/drafts${id ? `/${encodeURIComponent(id)}` : ""}`;

interface SaveBody {
  values: Values;
  label: string;
  siteCode: string | null;
  page: number;
  formVersion: number | null;
  writer: string;
  base: string | null;
}

export const draftsApi = {
  list: (slug: string) => api.get<{ drafts: DraftSummary[]; version: number }>(draftsPath(slug)),
  get: (slug: string, id: string) => api.get<DraftSummary & { values: Values }>(draftsPath(slug, id)),
  save: (slug: string, id: string, body: SaveBody) => api.put<DraftSummary & { dropped: boolean }>(draftsPath(slug, id), body),
  remove: (slug: string, id: string) => api.delete<{ ok: boolean }>(draftsPath(slug, id)),
};

/** A promise that gives up after `ms` (a request hanging on Wi-Fi with no internet behind it). */
function within<T>(p: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const t = setTimeout(() => reject(new Error("timeout")), ms);
    p.then(
      (v) => { clearTimeout(t); resolve(v); },
      (e) => { clearTimeout(t); reject(e); }
    );
  });
}

// ── The device's copy ────────────────────────────────────────────────────

export function readLocalDraft(key: string | undefined): LocalDraft | null {
  if (!key) return null;
  try {
    const saved = JSON.parse(localStorage.getItem(key) ?? "null") as LocalDraft | null;
    return saved?.values && typeof saved.startedAt === "number" ? saved : null;
  } catch {
    return null; // storage blocked
  }
}

function writeLocalDraft(key: string, d: LocalDraft) {
  try {
    localStorage.setItem(key, JSON.stringify(d));
  } catch {
    /* full or blocked: drafts are a convenience */
  }
}

export function clearLocalDraft(key: string | undefined) {
  if (!key) return;
  try {
    localStorage.removeItem(key);
  } catch {
    /* ignore */
  }
}

/** A draft picked to carry on with: what FormRenderer starts from. */
export interface StartDraft {
  values: Values;
  startedAt: number;
  savedAt: number;
  draftId: string | null;
  base: string | null;
  pending: boolean;
  siteCode: string | null;
  page: number;
}

export const startFromLocal = (d: LocalDraft): StartDraft => ({
  values: d.values,
  startedAt: d.startedAt,
  savedAt: d.savedAt,
  draftId: d.draftId ?? null,
  base: d.base ?? null,
  pending: d.pending !== false,
  siteCode: d.siteCode ?? null,
  page: d.page ?? 0,
});

// ── Saving as they type ──────────────────────────────────────────────────

export interface DraftSnapshot {
  values: Values;
  startedAt: number;
  siteCode: string | null;
  page: number;
}

export type DraftStatus =
  | { state: "idle" }
  | { state: "saving" }
  | { state: "saved"; at: number; dropped?: boolean; note?: string }
  /** Kept on this device only for now: offline, or the account refused it (note says why). */
  | { state: "device"; note?: string };

/**
 * Keeps the answers being filled in: on the device at once, and (with
 * `account`) in the person's account a few seconds later. One per open form.
 */
export function useDraftKeeper({
  draftKey,
  account,
  doc,
  start,
  resumed,
}: {
  /** The device's slot; none: nothing is kept anywhere. */
  draftKey?: string;
  /** The form's slug and the version shown; null: the device only. */
  account: { slug: string; formVersion: number | null } | null;
  doc: FormDoc;
  /** What the form opened with. */
  start: StartDraft | null;
  /** Picked from the list when the form opened: the device's slot becomes this draft at once. */
  resumed: boolean;
}) {
  const writer = useRef(newDraftId()).current;
  const id = useRef<string | null>(start?.draftId ?? null);
  const base = useRef<string | null>(start?.base ?? null);
  const latest = useRef<DraftSnapshot | null>(start ? { values: start.values, startedAt: start.startedAt, siteCode: start.siteCode, page: start.page } : null);
  /** The account doesn't have the latest answers yet. */
  const dirty = useRef(Boolean(account && start?.pending));
  const busy = useRef(false);
  /** Saving to the account has stopped for this form (refused, or not allowed). */
  const off = useRef(false);
  /** Being sent as an entry: no more saves unless that fails and they change something. */
  const held = useRef(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const live = useRef(true);
  /** These answers were split off into a draft of their own (changed on another device too). */
  const split = useRef(false);
  const [status, setStatus] = useState<DraftStatus>(() =>
    !account || !start ? { state: "idle" } : start.base && !start.pending ? { state: "saved", at: Date.parse(start.base) } : { state: "device" }
  );
  const show = (s: DraftStatus) => live.current && setStatus(s);

  const writeLocal = (snap: DraftSnapshot, pending: boolean) => {
    if (!draftKey) return;
    writeLocalDraft(draftKey, { values: snap.values, savedAt: Date.now(), startedAt: snap.startedAt, draftId: id.current, base: base.current, pending, writer, siteCode: snap.siteCode, page: snap.page, label: draftLabelOf(doc, snap.values) });
  };

  /** The device's slot, after the account took these answers: nothing waiting, and which save it is. */
  const markSent = (sentId: string) => {
    if (!draftKey) return;
    const cur = readLocalDraft(draftKey);
    if (cur && cur.draftId === sentId) writeLocalDraft(draftKey, { ...cur, base: base.current, pending: dirty.current });
  };

  const bodyOf = (snap: DraftSnapshot): SaveBody => ({
    values: valuesForAccount(doc, snap.values).values,
    label: draftLabelOf(doc, snap.values),
    siteCode: snap.siteCode,
    page: snap.page,
    formVersion: account?.formVersion ?? null,
    writer,
    base: base.current,
  });

  const schedule = (ms: number) => {
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => void send(), ms);
  };

  const send = async (): Promise<void> => {
    timer.current = null;
    if (!account || off.current || held.current || !dirty.current || !latest.current) return;
    if (busy.current) return schedule(1000);
    busy.current = true;
    dirty.current = false;
    const snap = latest.current;
    const sentId = (id.current ??= newDraftId());
    // Quiet: the last "Saved …" stays up while the next save goes.
    if (live.current) setStatus((s) => (s.state === "saved" ? s : { state: "saving" }));
    try {
      const res = await draftsApi.save(account.slug, sentId, bodyOf(snap));
      if (id.current !== sentId) return; // discarded (or split off) meanwhile
      base.current = res.updatedAt;
      markSent(sentId);
      const at = Date.parse(res.updatedAt);
      // The server never sees the signatures and files (left out above), so whether any were is the page's to say.
      show({ state: "saved", at, dropped: res.dropped || valuesForAccount(doc, snap.values).dropped, note: split.current ? `Saved ${savedWhen(at)} as a separate draft, because it was also changed on another device` : undefined });
    } catch (e) {
      if (id.current !== sentId) return;
      const reason = e instanceof ApiError ? (e.details as { reason?: string } | undefined)?.reason : undefined;
      if (e instanceof ApiError && e.status === 409 && reason === "changed") {
        // Someone carried on with this draft on another device since this page last saved it:
        // these answers become a draft of their own rather than overwrite theirs.
        id.current = newDraftId();
        base.current = null;
        dirty.current = true;
        split.current = true;
        writeLocal(latest.current ?? snap, true);
        schedule(0);
      } else if (e instanceof ApiError && e.status < 500) {
        // Refused for good (too many drafts, too long, or drafts aren't allowed here): the device keeps them.
        off.current = true;
        dirty.current = true;
        const note = e.status === 409 ? e.message : e.status === 413 ? "These answers are too long to save to your account. They're kept on this device." : undefined;
        show({ state: "device", note });
      } else {
        // Offline or the server's trouble: kept on the device, tried again later.
        dirty.current = true;
        show({ state: "device" });
        schedule(RETRY_AFTER_MS);
      }
    } finally {
      busy.current = false;
    }
  };

  /** The page is closing: a last save that's allowed to finish after it's gone (when small enough). */
  const sendAsPageCloses = () => {
    if (!account || off.current || held.current || !dirty.current || !latest.current || busy.current) return;
    const body = JSON.stringify(bodyOf(latest.current));
    const sentId = (id.current ??= newDraftId());
    try {
      void fetch(`${API_BASE}${draftsPath(account.slug, sentId)}`, { method: "PUT", credentials: "include", headers: { "Content-Type": "application/json" }, body, keepalive: body.length < KEEPALIVE_MAX }).catch(() => undefined);
    } catch {
      /* the device's copy is still there */
    }
  };

  useEffect(() => {
    live.current = true;
    // Carried on from the list: the device's slot is this draft now.
    if (resumed && start && latest.current) writeLocal(latest.current, start.pending);
    if (dirty.current) schedule(SAVE_AFTER_MS);
    const onHidden = () => {
      if (document.visibilityState === "hidden") void send();
    };
    const onOnline = () => dirty.current && schedule(500);
    document.addEventListener("visibilitychange", onHidden);
    window.addEventListener("pagehide", sendAsPageCloses);
    window.addEventListener("online", onOnline);
    return () => {
      document.removeEventListener("visibilitychange", onHidden);
      window.removeEventListener("pagehide", sendAsPageCloses);
      window.removeEventListener("online", onOnline);
      // Leaving the form inside the app (no pagehide): what's waiting goes now.
      live.current = false;
      if (timer.current) clearTimeout(timer.current);
      void send();
    };
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  return {
    status,
    /** New answers (or page, or site): on the device now, to the account shortly. */
    changed: useCallback((snap: DraftSnapshot) => {
      latest.current = snap;
      held.current = false;
      if (account && !id.current) id.current = newDraftId();
      writeLocal(snap, true);
      if (!account || off.current) return;
      dirty.current = true;
      schedule(SAVE_AFTER_MS);
    }, []), // eslint-disable-line react-hooks/exhaustive-deps
    /** Being sent as an entry: hold saves, and say which draft it was (the server removes it once it's filed). */
    submitting: useCallback(() => {
      held.current = true;
      if (timer.current) clearTimeout(timer.current);
      return account ? id.current : null;
    }, []), // eslint-disable-line react-hooks/exhaustive-deps
    /** The send failed and they're still here: saving carries on. */
    release: useCallback(() => {
      if (!held.current) return;
      held.current = false;
      if (dirty.current) schedule(SAVE_AFTER_MS);
    }, []), // eslint-disable-line react-hooks/exhaustive-deps
    /** Start over: gone from the device and the account. */
    discard: useCallback(() => {
      if (timer.current) clearTimeout(timer.current);
      const gone = id.current;
      id.current = null;
      base.current = null;
      latest.current = null;
      dirty.current = false;
      clearLocalDraft(draftKey);
      show({ state: "idle" });
      if (account && gone) void draftsApi.remove(account.slug, gone).catch(() => undefined);
    }, []), // eslint-disable-line react-hooks/exhaustive-deps
  };
}

// ── Opening the form ─────────────────────────────────────────────────────

type Pick =
  | { phase: "checking" }
  | { phase: "choose"; choices: DraftChoice[] }
  /** start: a draft to carry on with; null: a new one; undefined: the device's copy, if any (as before account drafts). */
  | { phase: "ready"; start: StartDraft | null | undefined; resumed: boolean };

/**
 * When the form opens: the account's drafts and the device's copy, put
 * together (draftReconcile.ts). With any, the person picks one or starts new;
 * with none, or no answer from the server in a few seconds, the form opens
 * with the device's copy as it always did.
 */
export function useDraftPick({ slug, draftKey, doc, formVersion, enabled, round }: { slug: string; draftKey?: string; doc: FormDoc | undefined; formVersion: number | null; enabled: boolean; round: number }) {
  const on = enabled && Boolean(draftKey && doc);
  // Each opening of the form (another round, another form) starts over: until its own answer is in,
  // it's checking, so the form never shows for a moment before the list.
  const key = `${on}:${slug}:${draftKey}:${round}`;
  const [kept, setKept] = useState<{ key: string; pick: Pick } | null>(null);
  const state: Pick = kept?.key === key ? kept.pick : on ? { phase: "checking" } : { phase: "ready", start: undefined, resumed: false };
  const setState = (next: Pick | ((s: Pick) => Pick)) => setKept((k) => ({ key, pick: typeof next === "function" ? next(k?.key === key ? k.pick : state) : next }));
  const [opening, setOpening] = useState<string | null>(null);

  useEffect(() => {
    if (!on || !doc) return;
    let live = true;
    void (async () => {
      try {
        const { drafts } = await within(draftsApi.list(slug), LIST_WAIT_MS);
        const r = reconcileDrafts(readLocalDraft(draftKey), drafts, newDraftId);
        if (r.dropLocal) clearLocalDraft(draftKey);
        if (r.push && draftKey) {
          const { id, base, draft } = r.push;
          const writer = newDraftId();
          writeLocalDraft(draftKey, { ...draft, draftId: id, base, pending: true, writer });
          try {
            const res = await within(
              draftsApi.save(slug, id, { values: valuesForAccount(doc, draft.values).values, label: draftLabelOf(doc, draft.values), siteCode: draft.siteCode ?? null, page: draft.page ?? 0, formVersion, writer, base }),
              LIST_WAIT_MS
            );
            writeLocalDraft(draftKey, { ...draft, draftId: id, base: res.updatedAt, pending: false, writer });
          } catch {
            /* stays on the device, offered from there and sent once the form is open */
          }
        }
        if (!live) return;
        setState(r.choices.length ? { phase: "choose", choices: r.choices } : { phase: "ready", start: r.dropLocal ? null : undefined, resumed: false });
      } catch {
        // No answer: the device's copy, as before.
        if (live) setState({ phase: "ready", start: undefined, resumed: false });
      }
    })();
    return () => {
      live = false;
    };
  }, [key]); // eslint-disable-line react-hooks/exhaustive-deps

  /** Carry on with one: the device's copy when it's that one, else fetched. False when it couldn't be opened. */
  const resume = async (c: DraftChoice): Promise<boolean> => {
    const local = readLocalDraft(draftKey);
    if (c.fromDevice && local?.draftId === c.id) {
      setState({ phase: "ready", start: startFromLocal(local), resumed: true });
      return true;
    }
    setOpening(c.id);
    try {
      const d = await within(draftsApi.get(slug, c.id), 8000);
      setState({
        phase: "ready",
        start: { values: d.values, startedAt: Date.parse(d.createdAt), savedAt: Date.parse(d.updatedAt), draftId: d.id, base: d.updatedAt, pending: false, siteCode: d.siteCode, page: d.page },
        resumed: true,
      });
      return true;
    } catch {
      return false;
    } finally {
      setOpening(null);
    }
  };

  const startNew = () => setState({ phase: "ready", start: null, resumed: false });

  /** Discard one from the list: from the account, and the device's copy if it's that one. */
  const discard = (c: DraftChoice) => {
    if (readLocalDraft(draftKey)?.draftId === c.id) clearLocalDraft(draftKey);
    void draftsApi.remove(slug, c.id).catch(() => undefined);
    setState((s) => {
      if (s.phase !== "choose") return s;
      const left = s.choices.filter((x) => x.id !== c.id);
      return left.length ? { phase: "choose", choices: left } : { phase: "ready", start: null, resumed: false };
    });
  };

  return { state, opening, resume, startNew, discard };
}

// ── What the person sees ─────────────────────────────────────────────────

const sameDay = (a: Date, b: Date) => a.toDateString() === b.toDateString();

/** "12:04 PM" today, "Nov 18, 12:04 PM" before. */
export function savedWhen(at: number) {
  const d = new Date(at);
  const time = d.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
  return sameDay(d, new Date()) ? time : `${d.toLocaleDateString([], { month: "short", day: "numeric" })}, ${time}`;
}

/** The quiet line under the form: whether the answers are saved, and where. */
export function draftStatusText(s: DraftStatus): string | null {
  if (s.state === "saving") return "Saving…";
  if (s.state === "saved") return s.note ?? `Saved ${savedWhen(s.at)}${s.dropped ? " (signatures and files stay on this device)" : ""}`;
  if (s.state === "device") return s.note ?? "Saved on this device";
  return null;
}

/** The account's drafts of this form, when it opens: carry on with one, or start new. */
export function DraftChooser({ choices, opening, onResume, onStartNew, onDiscard }: { choices: DraftChoice[]; opening: string | null; onResume: (c: DraftChoice) => void; onStartNew: () => void; onDiscard: (c: DraftChoice) => void }) {
  return (
    <div data-tour="form-drafts">
      <p className="font-heading text-lead font-extrabold text-ink">Carry on where you left off?</p>
      <p className="mt-1 text-body text-muted">You have unfinished answers saved for this form.</p>
      <ul className="mt-4 divide-y divide-hairline rounded-card border border-hairline">
        {choices.map((c) => (
          <li key={c.id} className="flex items-center gap-2 px-3 py-2.5">
            <div className="min-w-0 flex-1">
              <p className="truncate text-body font-semibold text-ink">{c.label}</p>
              <p className="text-micro text-muted">Saved {savedWhen(c.savedAt)}{c.fromDevice ? (c.summary ? " · last open on this device" : " on this device") : ""}</p>
            </div>
            <Button type="button" size="sm" onClick={() => onResume(c)} disabled={opening !== null}>
              {opening === c.id && <Loader2 className="h-3.5 w-3.5 animate-spin" />} Resume
            </Button>
            <button
              type="button"
              onClick={() => window.confirm(`Discard the unfinished answers for “${c.label}”? They're removed from every device.`) && onDiscard(c)}
              disabled={opening !== null}
              className="rounded p-2 text-muted hover:bg-rowhover hover:text-status-redText"
              aria-label={`Discard ${c.label}`}
            >
              <Trash2 className="h-4 w-4" />
            </button>
          </li>
        ))}
      </ul>
      <div className="mt-4 flex flex-wrap items-center gap-3">
        <Button type="button" variant="secondary" onClick={onStartNew} disabled={opening !== null}>Start new</Button>
        <span className="text-micro text-muted">Unfinished answers are kept for 30 days.</span>
      </div>
    </div>
  );
}
