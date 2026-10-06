import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from "react";

/**
 * @lcs/sdk inside the sandboxed frame. Every call is a message to the host page
 * (src/apps/bridge.ts), which checks it and makes the real request as the
 * signed-in person. The frame itself has no network access at all.
 */

type Json = unknown;

interface AppContext {
  user: { id: string; name: string; email: string; roleKey: string; roleName: string; permissions: string[]; siteIds: string[] | null };
  form: { id: string; slug: string; title: string; version: number; draft: boolean };
  page: string;
  params: Record<string, string>;
  pages: { id: string; label: string }[];
  online: boolean;
  today: string;
  device: Device;
}

export interface Device {
  kind: "phone" | "tablet" | "desktop";
  orientation: "portrait" | "landscape";
  width: number;
  height: number;
  touch: boolean;
  breakpoints: string[];
}

/** Mirror the host device onto <html>, so phone:/tablet:/md:/portrait: classes follow the real window. */
function applyDevice(d: Device | undefined) {
  if (!d) return;
  const root = document.documentElement;
  root.dataset.device = d.kind;
  root.dataset.orientation = d.orientation;
  root.dataset.bp = d.breakpoints.join(" ");
}

let ctx: AppContext | null = null;
const ctxListeners = new Set<() => void>();
const eventListeners = new Map<string, Set<(payload: Json) => void>>();
const pending = new Map<number, { resolve: (v: Json) => void; reject: (e: Error) => void }>();
let nextId = 1;

export function post(msg: Record<string, unknown>) {
  parent.postMessage({ __lcsApp: 1, ...msg }, "*");
}

export function onHostMessage(data: { t: string; [k: string]: unknown }) {
  if (data.t === "result") {
    const p = pending.get(data.id as number);
    if (!p) return;
    pending.delete(data.id as number);
    if (data.ok) p.resolve(data.value);
    else p.reject(Object.assign(new Error(String(data.error)), { status: data.status, details: data.details }));
  } else if (data.t === "context") {
    ctx = data.context as AppContext;
    applyDevice(ctx.device);
    ctxListeners.forEach((l) => l());
  } else if (data.t === "event") {
    eventListeners.get(data.name as string)?.forEach((l) => l(data.payload));
  }
}

export const contextReady = () => ctx !== null;

export function call<T = Json>(method: string, ...args: Json[]): Promise<T> {
  const id = nextId++;
  return new Promise<T>((resolve, reject) => {
    pending.set(id, { resolve: resolve as (v: Json) => void, reject });
    post({ t: "call", id, method, args });
  });
}

function on(name: string, fn: (payload: Json) => void) {
  const set = eventListeners.get(name) ?? new Set();
  set.add(fn);
  eventListeners.set(name, set);
  return () => set.delete(fn);
}

export function useApp(): AppContext {
  const value = useSyncExternalStore(
    (l) => {
      ctxListeners.add(l);
      return () => ctxListeners.delete(l);
    },
    () => ctx
  );
  return value!;
}

/** The device the form is being used on (the real window, not the frame), kept current. */
export function useDevice(): Device {
  return useApp().device;
}

export const app = {
  context: async () => ctx!,
  navigate: (page: string, params?: Record<string, string>) => void call("app.navigate", page, params ?? {}),
  setParams: (params: Record<string, string>) => void call("app.setParams", params),
  toast: (message: string, tone?: "success" | "error") => void call("app.toast", message, tone ?? "success"),
  download: (filename: string, content: string, opts?: { mime?: string; base64?: boolean }) => void call("app.download", filename, content, opts ?? {}),
  print: () => window.print(),
  openApp: (path: string) => void call("app.openApp", path),
};

export const roster = {
  sites: () => call("roster.sites"),
  residents: (siteCode: string) => call("roster.residents", siteCode),
};

export const entries = {
  list: (query?: Json) => call("entries.list", query ?? {}),
  get: (id: string) => call("entries.get", id),
  create: (entry: Json, opts?: Json) => call("entries.create", entry, opts ?? {}),
  update: (id: string, data: Json, opts?: { reason?: string }) => call("entries.update", id, { data, reason: opts?.reason }),
  history: (id: string) => call("entries.history", id),
  void: (id: string, reason: string) => call("entries.void", id, reason),
  restore: (id: string) => call("entries.restore", id),
};

export const calendar = {
  events: (q: { from: string; to: string; site?: string | string[] }) => call("calendar.events", q),
  categories: () => call("calendar.categories"),
  event: (id: string) => call("calendar.event", id),
  create: (event: Json) => call<{ id: string }>("calendar.create", event),
  update: (id: string, change: Json) => call<{ id: string }>("calendar.update", id, change),
  remove: (id: string, opts?: { scope?: "all" | "this" | "following"; date?: string }) => call<void>("calendar.remove", id, opts ?? {}),
};

export const collections = {
  list: (name: string) => call("collections.list", name),
  get: (name: string, id: string) => call("collections.get", name, id),
  put: (name: string, id: string | null, data: Json) => call("collections.put", name, id, data),
  remove: (name: string, id: string) => call("collections.remove", name, id),
};

export const actions = {
  call: (name: string, args?: Json) => call("actions.call", name, args ?? null),
};

export const local = {
  get: (key: string) => call<string | null>("local.get", key),
  set: (key: string, value: string) => call<void>("local.set", key, value),
  remove: (key: string) => call<void>("local.remove", key),
};

export const device = {
  location: (opts?: { timeoutMs?: number }) => call("device.location", opts ?? {}),
  takePhoto: (opts?: { title?: string; facing?: "environment" | "user"; label?: string }) => call<FileRef | null>("device.takePhoto", opts ?? {}),
};

// ── Photos and files ─────────────────────────────────────────────────────

export interface FileRef {
  fileId: string;
  name: string;
  mime: string;
  size: number;
}

/** Data URLs already fetched, by fileId (a file never changes once uploaded). */
const urlCache = new Map<string, Promise<string>>();

/** A file input in the frame itself: it has to open from the tap that asked for it. */
function pick(opts: { accept?: string; capture?: "environment" | "user"; multiple?: boolean } = {}): Promise<File[]> {
  return new Promise((resolve) => {
    const input = document.createElement("input");
    input.type = "file";
    if (opts.accept) input.accept = opts.accept;
    if (opts.capture) input.setAttribute("capture", opts.capture);
    input.multiple = Boolean(opts.multiple);
    input.style.display = "none";
    document.body.appendChild(input);
    const done = (files: File[]) => {
      input.remove();
      resolve(files);
    };
    input.addEventListener("change", () => done(Array.from(input.files ?? [])));
    input.addEventListener("cancel", () => done([]));
    input.click();
  });
}

async function upload(file: Blob, opts: { name?: string; label?: string; shrink?: boolean } = {}): Promise<FileRef> {
  const name = opts.name ?? (file instanceof File ? file.name : "file");
  return call<FileRef>("files.upload", { name, mime: file.type, label: opts.label, shrink: opts.shrink, data: await file.arrayBuffer() });
}

export const files = {
  upload,
  pick,
  /** Pick (must be called from a tap) and upload. Returns [] if the person cancels. */
  choose: async (opts: { accept?: string; capture?: "environment" | "user"; multiple?: boolean; label?: string } = {}) => {
    const picked = await pick(opts);
    return Promise.all(picked.map((f) => upload(f, { label: opts.label })));
  },
  /** A data: URL of the file, for an <img> or a link. */
  url: (ref: FileRef | string) => {
    const id = typeof ref === "string" ? ref : ref.fileId;
    let p = urlCache.get(id);
    if (!p) {
      p = call<string>("files.read", id);
      p.catch(() => urlCache.delete(id));
      urlCache.set(id, p);
    }
    return p;
  },
  download: (ref: FileRef, filename?: string) => call<void>("files.download", ref.fileId, filename ?? ref.name),
};

/** files.url as a hook: undefined while loading. */
export function useFileUrl(ref: FileRef | string | null | undefined): string | undefined {
  const id = !ref ? null : typeof ref === "string" ? ref : ref.fileId;
  const [url, setUrl] = useState<string | undefined>(undefined);
  useEffect(() => {
    setUrl(undefined);
    if (!id) return;
    let live = true;
    files.url(id).then((u) => live && setUrl(u), () => undefined);
    return () => {
      live = false;
    };
  }, [id]);
  return url;
}

export const queue = {
  status: () => call("queue.status"),
  subscribe: (fn: (s: Json) => void) => {
    const off = on("queue", fn);
    void call("queue.status").then(fn);
    return off;
  },
  retry: () => call("queue.retry"),
  discard: (clientId: string) => call("queue.discard", clientId),
};

export function useData<T>(fn: () => Promise<T>, deps: unknown[] = []) {
  const [state, setState] = useState<{ data: T | undefined; error: Error | null; loading: boolean }>({ data: undefined, error: null, loading: true });
  const [tick, setTick] = useState(0);
  const fnRef = useRef(fn);
  fnRef.current = fn;
  useEffect(() => {
    let live = true;
    setState((s) => ({ ...s, loading: true }));
    fnRef.current().then(
      (data) => live && setState({ data, error: null, loading: false }),
      (error: Error) => live && setState((s) => ({ data: s.data, error, loading: false }))
    );
    return () => {
      live = false;
    };
  }, [...deps, tick]); // eslint-disable-line react-hooks/exhaustive-deps
  const refresh = useCallback(() => setTick((t) => t + 1), []);
  return { ...state, refresh };
}

// ── Dates (New York) ─────────────────────────────────────────────────────

const TZ = "America/New_York";
const dayFmt = new Intl.DateTimeFormat("en-CA", { timeZone: TZ, year: "numeric", month: "2-digit", day: "2-digit" });
const timeFmt = new Intl.DateTimeFormat("en-GB", { timeZone: TZ, hour: "2-digit", minute: "2-digit", hour12: false });

export const dates = {
  today: () => dayFmt.format(new Date()),
  addDays: (day: string, n: number) => {
    const d = new Date(`${day}T12:00:00Z`);
    d.setUTCDate(d.getUTCDate() + n);
    return d.toISOString().slice(0, 10);
  },
  dayOf: (iso: string) => dayFmt.format(new Date(iso)),
  timeOf: (iso: string) => timeFmt.format(new Date(iso)),
  format: (iso: string, style: "date" | "datetime" | "time" | "relative" = "datetime") => {
    const d = new Date(iso);
    if (style === "relative") {
      const s = Math.round((Date.now() - d.getTime()) / 1000);
      if (s < 45) return "just now";
      if (s < 3600) return `${Math.round(s / 60)} min ago`;
      if (s < 86400) return `${Math.round(s / 3600)} h ago`;
      return `${Math.round(s / 86400)} d ago`;
    }
    const opts: Intl.DateTimeFormatOptions =
      style === "date" ? { dateStyle: "medium" } : style === "time" ? { timeStyle: "short" } : { dateStyle: "medium", timeStyle: "short" };
    return d.toLocaleString("en-US", { timeZone: TZ, ...opts });
  },
};
