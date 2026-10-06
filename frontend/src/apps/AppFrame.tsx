import { useEffect, useMemo, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import { api, API_BASE, ApiError } from "@/lib/api";
import { isOnline, onConnectivityChange, storeAnswer, storedAnswer } from "@/lib/offline";
import { loadTenants } from "@/lib/rosterStore";
import { useToast } from "@/components/ui/toast";
import type { Site, Tenant } from "@/lib/types";
import { runtimeApi, submitAppEntry, type AppRuntime } from "./api";
import { forcedDevice } from "@/lib/device";
import { discard, enqueue, localFile, onQueueChange, queueStatus, retryFailed, saveLocalFile } from "./queue";
import { CameraCapture, shrinkImage, type CameraRequest } from "./CameraCapture";

/**
 * One page of a code form, in a sandboxed iframe.
 *
 * sandbox="allow-scripts" without allow-same-origin gives the frame an opaque
 * origin: it can't read this app's cookies, storage or DOM, and its CSP blocks
 * network requests. The page reaches data only by asking this component
 * (postMessage), which makes each request itself — as the signed-in person,
 * through the same API and permission checks as the rest of the app.
 */

export interface ConsoleLine {
  level: "log" | "info" | "warn" | "error";
  text: string;
  source: "page" | "server";
  at: number;
}

const nyDay = () => new Intl.DateTimeFormat("en-CA", { timeZone: "America/New_York", year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date());

const BREAKPOINTS = { sm: 640, md: 768, lg: 1024, xl: 1280, "2xl": 1536 };

export type DeviceKind = "phone" | "tablet" | "desktop";
export interface DeviceInfo {
  kind: DeviceKind;
  orientation: "portrait" | "landscape";
  /** The device's window, not the frame. */
  width: number;
  height: number;
  touch: boolean;
  /** Breakpoints the window is at or past, as in the app: ["sm", "md"]. */
  breakpoints: string[];
}

/**
 * What the page is being used on. A touch device with a short side under 600px
 * is a phone and any other touch device a tablet (iPads report themselves as
 * Macs, but their pointer is coarse). Without touch, a window under 768px
 * counts as a phone and anything wider as a desktop.
 */
export function deviceInfo(): DeviceInfo {
  const width = window.innerWidth;
  const height = window.innerHeight;
  // A device preview frame says what it's standing in for (lib/device.ts).
  const forced = forcedDevice();
  const touch = forced ? forced !== "desktop" : window.matchMedia?.("(pointer: coarse)").matches ?? false;
  const short = Math.min(window.screen?.width ?? width, window.screen?.height ?? height);
  const kind: DeviceKind = forced ?? (touch ? (short < 600 ? "phone" : "tablet") : width < 768 ? "phone" : "desktop");
  return { kind, orientation: height >= width ? "portrait" : "landscape", width, height, touch, breakpoints: Object.entries(BREAKPOINTS).filter(([, px]) => width >= px).map(([k]) => k) };
}

function themeSnapshot() {
  const root = document.documentElement;
  return { className: root.className, dataTheme: root.dataset.theme ?? "", style: root.getAttribute("style") ?? "" };
}

/**
 * The runtime, fetched once and written into every frame. A sandboxed frame
 * has an opaque origin, and browsers refuse its requests to a local address
 * (and it has no network by design anyway), so nothing is loaded by URL.
 */
let assets: Promise<{ js: string; css: string }> | null = null;
function runtimeAssets() {
  assets ??= Promise.all([fetch("/app-runtime/runtime.js").then((r) => r.text()), fetch("/app-runtime/runtime.css").then((r) => r.text())]).then(([js, css]) => ({ js, css }));
  assets.catch(() => (assets = null));
  return assets;
}

/** Keep embedded code from closing its own tag early. */
const noClose = (s: string, tag: "script" | "style") => s.replace(new RegExp(`</${tag}`, "gi"), `<\\/${tag}`);

/** The page's code for this kind of device: its own view (form.json "views") when it has one. */
export const codeKey = (runtime: AppRuntime, page: string, kind: DeviceKind) => (runtime.code[`${page}@${kind}`] !== undefined ? `${page}@${kind}` : page);

function srcDoc(runtime: AppRuntime, key: string, base: { js: string; css: string }, device: DeviceInfo) {
  const code = noClose(runtime.code[key] ?? "", "script");
  const theme = themeSnapshot();
  const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/"/g, "&quot;");
  return `<!doctype html><html class="${esc(theme.className)}" data-theme="${esc(theme.dataTheme)}" data-device="${device.kind}" data-orientation="${device.orientation}" data-bp="${device.breakpoints.join(" ")}" style="${esc(theme.style)}"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline' https://fonts.googleapis.com; font-src https://fonts.gstatic.com data:; img-src https: data: blob:; media-src data: blob:">
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Archivo:wght@400;500;600;700;800&display=swap">
<style>${noClose(base.css, "style")}</style>
<style>html,body{height:100%;margin:0;background:transparent}body{color:rgb(var(--c-ink));font-family:Archivo,system-ui,sans-serif}#root{min-height:100%}${noClose(runtime.css, "style")}</style>
<script>${noClose(base.js, "script")}</script>
</head><body><div id="root"></div><script>${code}</script></body></html>`;
}

export function AppFrame({
  runtime,
  slug,
  draft,
  page,
  params,
  onNavigate,
  onSetParams,
  onConsole,
  className,
}: {
  runtime: AppRuntime;
  slug: string;
  draft: boolean;
  page: string;
  params: Record<string, string>;
  onNavigate: (page: string, params: Record<string, string>) => void;
  onSetParams: (params: Record<string, string>) => void;
  onConsole?: (line: ConsoleLine) => void;
  className?: string;
}) {
  const ref = useRef<HTMLIFrameElement>(null);
  const toast = useToast();
  const navigate = useNavigate();
  const [base, setBase] = useState<{ js: string; css: string } | null>(null);
  // device.takePhoto(): the camera dialog, and who's waiting on it.
  const [camera, setCamera] = useState<CameraRequest | null>(null);
  const cameraDone = useRef<((f: File | null) => void) | null>(null);
  const [baseError, setBaseError] = useState(false);
  useEffect(() => {
    runtimeAssets().then(setBase, () => setBaseError(true));
  }, []);
  const [device, setDevice] = useState(deviceInfo);
  useEffect(() => {
    let t: ReturnType<typeof setTimeout>;
    const update = () => {
      clearTimeout(t);
      t = setTimeout(() => setDevice((d) => {
        const n = deviceInfo();
        return JSON.stringify(n) === JSON.stringify(d) ? d : n;
      }), 120);
    };
    window.addEventListener("resize", update);
    window.addEventListener("orientationchange", update);
    return () => {
      window.removeEventListener("resize", update);
      window.removeEventListener("orientationchange", update);
    };
  }, []);
  const key = codeKey(runtime, page, device.kind);
  // The document only changes with the code; size and orientation are sent live.
  const doc = useMemo(() => (base ? srcDoc(runtime, key, base, device) : ""), [runtime.hash, key, base]); // eslint-disable-line react-hooks/exhaustive-deps
  const latest = useRef({ runtime, params, page, onNavigate, onSetParams, onConsole, device });
  latest.current = { runtime, params, page, onNavigate, onSetParams, onConsole, device };

  const send = (msg: Record<string, unknown>) => ref.current?.contentWindow?.postMessage({ __lcsHost: 1, ...msg }, "*");

  const context = () => {
    const l = latest.current;
    return {
      user: l.runtime.user,
      form: { id: l.runtime.form.id, slug: l.runtime.form.slug, title: l.runtime.form.title, version: l.runtime.form.version, draft: l.runtime.form.draft },
      page: l.page,
      params: l.params,
      pages: l.runtime.pages.filter((p) => !p.hidden).map((p) => ({ id: p.id, label: p.label })),
      online: isOnline(),
      today: nyDay(),
      device: l.device,
    };
  };

  // Keep the page's idea of the URL, the connection and the theme current.
  useEffect(() => send({ t: "context", context: context() }), [params, page, device]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    const push = () => send({ t: "context", context: context() });
    // The app's own reading of the connection (lib/offline.ts): site Wi-Fi with no internet still says navigator.onLine.
    const offConn = onConnectivityChange(push);
    const mo = new MutationObserver(() => send({ t: "theme", theme: themeSnapshot() }));
    mo.observe(document.documentElement, { attributes: true, attributeFilter: ["class", "style", "data-theme"] });
    const offQueue = onQueueChange(() => void queueStatus(slug).then((s) => send({ t: "event", name: "queue", payload: s })));
    return () => {
      offConn();
      mo.disconnect();
      offQueue();
    };
  }, [slug]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    const log = (level: ConsoleLine["level"], text: string, source: ConsoleLine["source"] = "page") => latest.current.onConsole?.({ level, text, source, at: Date.now() });
    const serverLogs = (logs?: string[]) => logs?.forEach((l) => log(l.startsWith("error:") ? "error" : l.startsWith("warn:") ? "warn" : "log", l, "server"));

    /**
     * Upload a photo or file for the page, shrinking photos first. With no
     * connection it's kept on the device under a "local:" id, and the queue
     * uploads it ahead of the entry that refers to it.
     */
    const storeFile = async (file: Blob, name: string, label?: string, shrink = true) => {
      const blob = shrink && file.type.startsWith("image/") ? await shrinkImage(file) : file;
      if (blob.size > 10 * 1024 * 1024) throw new Error("That file is over 10 MB.");
      const mime = blob.type || file.type || "application/octet-stream";
      const fileName = blob !== file && blob.type === "image/jpeg" ? `${name.replace(/\.[^.]+$/, "") || "photo"}.jpg` : name;
      const keep = () => saveLocalFile({ slug, draft, userId: latest.current.runtime.user.id, name: fileName, mime, label, data: blob });
      if (!isOnline()) return keep();
      try {
        return await runtimeApi.upload(slug, draft, { name: fileName, mime, label, data: blob });
      } catch (e) {
        if (e instanceof ApiError && e.status < 500) throw e;
        return keep();
      }
    };
    const fileBlob = async (fileId: string) => {
      if (fileId.startsWith("local:")) {
        const f = await localFile(fileId);
        if (!f) throw new Error("That photo is no longer on this device.");
        return { blob: f.data, name: f.name };
      }
      return { blob: await runtimeApi.file(slug, draft, fileId), name: "" };
    };
    const asDataUrl = (blob: Blob) =>
      new Promise<string>((resolve, reject) => {
        const r = new FileReader();
        r.onload = () => resolve(String(r.result));
        r.onerror = () => reject(r.error);
        r.readAsDataURL(blob);
      });

    const methods: Record<string, (...args: any[]) => Promise<unknown>> = {
      "app.navigate": async (p: string, prm: Record<string, string>) => latest.current.onNavigate(p, prm ?? {}),
      "app.setParams": async (prm: Record<string, string>) => latest.current.onSetParams(prm ?? {}),
      "app.toast": async (message: string, tone: "success" | "error") => toast(String(message).slice(0, 300), tone === "error" ? "error" : "success"),
      "app.openApp": async (path: string) => {
        if (typeof path === "string" && path.startsWith("/") && !path.startsWith("//")) navigate(path);
      },
      "app.download": async (filename: string, content: string, opts: { mime?: string; base64?: boolean }) => {
        const data = opts?.base64 ? Uint8Array.from(atob(content), (c) => c.charCodeAt(0)) : content;
        const url = URL.createObjectURL(new Blob([data], { type: opts?.mime || "application/octet-stream" }));
        const a = document.createElement("a");
        a.href = url;
        a.download = String(filename).replace(/[\\/:*?"<>|]+/g, "-").slice(0, 150) || "download";
        a.click();
        setTimeout(() => URL.revokeObjectURL(url), 2000);
      },
      "app.export": async (spec: Record<string, unknown>) => {
        const res = await fetch(`${API_BASE}/apps/${slug}/export${draft ? "?draft=1" : ""}`, {
          method: "POST",
          credentials: "include",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(spec),
        });
        if (!res.ok) {
          const out = await res.json().catch(() => ({}));
          throw new ApiError(res.status, out?.error ?? "The export failed.", out?.details);
        }
        const name = decodeURIComponent(/filename="?([^"]+)"?/.exec(res.headers.get("content-disposition") ?? "")?.[1] ?? "export");
        const url = URL.createObjectURL(await res.blob());
        const a = document.createElement("a");
        a.href = url;
        a.download = name;
        a.click();
        setTimeout(() => URL.revokeObjectURL(url), 2000);
      },
      "roster.sites": async () =>
        (await api.get<Site[]>("/sites")).map((s) => ({ id: s.id, code: s.code, name: s.name, siteType: s.siteType, latitude: s.latitude ?? null, longitude: s.longitude ?? null, geofenceMeters: s.geofenceMeters ?? null })),
      "roster.residents": async (code: string) => {
        // The device's own copy of the roster when it has one: instant, and offline.
        const res = await loadTenants(String(code), { userId: latest.current.runtime.user.id });
        return res.items.map((t) => ({
          id: t.id, siteId: t.siteId, name: t.displayName, firstName: t.firstName, lastName: t.lastName, preferredName: t.preferredName, unit: t.unit,
          moveInDate: t.moveInDate?.slice(0, 10) ?? null, lastActivityAt: t.lastActivityAt, needsAttention: t.needsAttention,
        }));
      },
      "roster.resident": async (id: string) => {
        const t = await api.get<Tenant & { activities: { source: string; label: string | null; occurredAt: string; recordedBy: string | null }[] }>(`/tenants/${encodeURIComponent(String(id))}`);
        return {
          id: t.id, siteId: t.siteId, site: t.site ? { code: t.site.code, name: t.site.name } : null, name: t.displayName, firstName: t.firstName, lastName: t.lastName,
          preferredName: t.preferredName, unit: t.unit, status: t.status, moveInDate: t.moveInDate?.slice(0, 10) ?? null, moveOutDate: t.moveOutDate?.slice(0, 10) ?? null,
          notes: t.notes, lastActivityAt: t.lastActivityAt, needsAttention: t.needsAttention,
          activities: (t.activities ?? []).map((a) => ({ source: a.source, label: a.label, occurredAt: a.occurredAt, recordedBy: a.recordedBy })),
        };
      },
      "entries.list": async (query: Record<string, unknown>) => runtimeApi.entries(slug, draft, query ?? {}),
      "entries.get": async (id: string) => runtimeApi.entry(slug, draft, id),
      "entries.create": async (entry: Record<string, unknown>, opts: { offline?: boolean; offlineOverride?: string }) => {
        const clientId = (entry.clientId as string) || crypto.randomUUID();
        const body = { ...entry, clientId };
        if (opts?.offline) {
          await enqueue({ clientId, slug, title: latest.current.runtime.form.title, draft, userId: latest.current.runtime.user.id, entry: body, offlineOverride: opts.offlineOverride });
          return { status: "queued", clientId };
        }
        let out;
        try {
          out = await submitAppEntry(slug, draft, body);
        } catch (e) {
          // The connection dropped: keep it rather than lose it, as if the page had asked for offline.
          if (e instanceof ApiError && e.status < 500) throw e;
          await enqueue({ clientId, slug, title: latest.current.runtime.form.title, draft, userId: latest.current.runtime.user.id, entry: body, offlineOverride: opts?.offlineOverride });
          return { status: "queued", clientId };
        }
        serverLogs(out.logs);
        return out;
      },
      "entries.update": async (id: string, body: { data: unknown; reason?: string }) => {
        const out = await runtimeApi.update(slug, draft, String(id), { data: body?.data, reason: body?.reason ?? null });
        serverLogs(out.logs);
        return { ...out, logs: undefined };
      },
      "entries.history": async (id: string) => runtimeApi.history(slug, draft, String(id)),
      "entries.void": async (id: string, reason: string) => runtimeApi.void(slug, draft, id, reason),
      "files.upload": async (f: { name?: string; mime?: string; label?: string; data: ArrayBuffer; shrink?: boolean }) => {
        if (!(f?.data instanceof ArrayBuffer)) throw new Error("files.upload takes a File or Blob.");
        return storeFile(new Blob([f.data], { type: f.mime || "application/octet-stream" }), String(f.name || "file").slice(0, 200), f.label, f.shrink !== false);
      },
      "files.read": async (fileId: string) => asDataUrl((await fileBlob(String(fileId))).blob),
      "files.download": async (fileId: string, filename?: string) => {
        const { blob, name } = await fileBlob(String(fileId));
        const url = URL.createObjectURL(blob);
        const a = document.createElement("a");
        a.href = url;
        a.download = String(filename || name || "file").replace(/[\\/:*?"<>|]+/g, "-").slice(0, 150);
        a.click();
        setTimeout(() => URL.revokeObjectURL(url), 2000);
      },
      "device.takePhoto": (opts: { title?: string; facing?: "environment" | "user"; label?: string }) =>
        new Promise((resolve, reject) => {
          // One at a time: a second request cancels the first.
          cameraDone.current?.(null);
          cameraDone.current = (file) => {
            cameraDone.current = null;
            setCamera(null);
            if (!file) return resolve(null);
            storeFile(file, file.name || "photo.jpg", opts?.label ?? "photo").then(resolve, reject);
          };
          setCamera({ title: opts?.title ? String(opts.title).slice(0, 80) : undefined, facing: opts?.facing === "user" ? "user" : "environment" });
        }),
      "entries.restore": async (id: string) => runtimeApi.restore(slug, draft, id),
      "collections.list": async (name: string) => runtimeApi.collection(slug, draft, name),
      "collections.get": async (name: string, id: string) => runtimeApi.doc(slug, draft, name, id),
      "collections.put": async (name: string, id: string | null, data: unknown) => runtimeApi.put(slug, draft, name, id, data),
      "collections.remove": async (name: string, id: string) => runtimeApi.remove(slug, draft, name, id),
      "actions.call": async (name: string, args: unknown) => {
        // form.json offline.actions: ones that only read. Their last answer is
        // kept, and given back when there's no connection.
        const keep = latest.current.runtime.offlineActions?.includes(name);
        const key = `${slug}/${draft ? "draft" : "live"}/${encodeURIComponent(name)}?${encodeURIComponent(JSON.stringify(args ?? null))}`;
        try {
          const r = await runtimeApi.action(slug, draft, name, args);
          serverLogs(r.logs);
          if (keep) void storeAnswer(key, r.value);
          return r.value;
        } catch (e) {
          if (keep && !(e instanceof ApiError && e.status < 500)) {
            const stored = await storedAnswer(key);
            if (stored !== undefined) return stored;
          }
          serverLogs((e as { logs?: string[] }).logs);
          throw e;
        }
      },
      "device.location": (opts: { timeoutMs?: number }) =>
        new Promise((resolve) => {
          if (!navigator.geolocation) return resolve(null);
          navigator.geolocation.getCurrentPosition(
            (p) => resolve({ latitude: p.coords.latitude, longitude: p.coords.longitude, accuracy: p.coords.accuracy }),
            () => resolve(null),
            { enableHighAccuracy: true, timeout: Math.min(30_000, opts?.timeoutMs ?? 10_000), maximumAge: 60_000 }
          );
        }),
      // Per device, person and form. Keys are namespaced so a form can't read another's.
      "local.get": async (key: string) => {
        try {
          return localStorage.getItem(`lcs.app.${slug}.${latest.current.runtime.user.id}.${String(key).slice(0, 100)}`);
        } catch {
          return null;
        }
      },
      "local.set": async (key: string, value: string) => {
        try {
          localStorage.setItem(`lcs.app.${slug}.${latest.current.runtime.user.id}.${String(key).slice(0, 100)}`, String(value).slice(0, 10_000));
        } catch {
          /* private mode: not remembered */
        }
      },
      "local.remove": async (key: string) => {
        try {
          localStorage.removeItem(`lcs.app.${slug}.${latest.current.runtime.user.id}.${String(key).slice(0, 100)}`);
        } catch {
          /* ignore */
        }
      },
      // The calendar, as this person sees it (and can change it) on /calendar.
      "calendar.events": async (q: { from?: string; to?: string; site?: string | string[] }) => {
        const p = new URLSearchParams({ from: String(q?.from ?? ""), to: String(q?.to ?? "") });
        if (q?.site) p.set("site", Array.isArray(q.site) ? q.site.join(",") : String(q.site));
        return (await api.get<{ items: Record<string, unknown>[] }>(`/calendar?${p}`)).items;
      },
      "calendar.categories": async () =>
        (await api.get<{ id: string; name: string; colorSlot: number }[]>("/calendar/categories")).map((c) => ({ id: c.id, name: c.name, colorSlot: c.colorSlot })),
      "calendar.event": async (id: string) => api.get(`/calendar/events/${encodeURIComponent(String(id))}`),
      "calendar.create": async (event: unknown) => {
        if (draft) throw new Error("The preview doesn't add calendar events — publish to try it for real.");
        return api.post<{ id: string }>("/calendar/events", event);
      },
      "calendar.update": async (id: string, change: { scope?: string; date?: string; event: unknown }) => {
        if (draft) throw new Error("The preview doesn't change calendar events — publish to try it for real.");
        return api.patch<{ id: string }>(`/calendar/events/${encodeURIComponent(String(id))}`, { scope: change?.scope ?? "all", date: change?.date, event: change?.event });
      },
      "calendar.remove": async (id: string, opts: { scope?: string; date?: string }) => {
        if (draft) throw new Error("The preview doesn't remove calendar events — publish to try it for real.");
        const p = new URLSearchParams({ scope: opts?.scope ?? "all" });
        if (opts?.date) p.set("date", opts.date);
        await api.delete(`/calendar/events/${encodeURIComponent(String(id))}?${p}`);
      },
      "queue.status": async () => queueStatus(slug),
      "queue.retry": async () => retryFailed(slug),
      "queue.discard": async (clientId: string) => discard(clientId),
    };

    const onMessage = async (e: MessageEvent) => {
      if (e.source !== ref.current?.contentWindow || !e.data || e.data.__lcsApp !== 1) return;
      const d = e.data as { t: string; id?: number; method?: string; args?: unknown[]; level?: ConsoleLine["level"]; message?: string; stack?: string };
      if (d.t === "hello" || d.t === "ready") {
        send({ t: "context", context: context() });
        return;
      }
      if (d.t === "console") return log(d.level ?? "log", (d.args as string[] | undefined)?.join(" ") ?? "");
      if (d.t === "crash") return log("error", `${d.message}${d.stack ? `\n${d.stack}` : ""}`);
      if (d.t !== "call" || !d.method) return;
      const fn = methods[d.method];
      try {
        if (!fn) throw new Error(`Unknown SDK call ${d.method}.`);
        const value = await fn(...(Array.isArray(d.args) ? d.args : []));
        send({ t: "result", id: d.id, ok: true, value: value === undefined ? null : JSON.parse(JSON.stringify(value)) });
      } catch (err) {
        const status = (err as { status?: number }).status;
        send({ t: "result", id: d.id, ok: false, error: err instanceof Error ? err.message : String(err), status });
        if (draft) log("warn", `${d.method} failed: ${err instanceof Error ? err.message : err}`);
      }
    };
    window.addEventListener("message", onMessage);
    return () => window.removeEventListener("message", onMessage);
  }, [slug, draft, toast, navigate]);

  if (baseError) return <p className="p-6 text-[13px] text-status-redText">Couldn't load the code-form runtime. Check your connection and reload.</p>;
  if (!base) return null;
  return (
    <>
    <CameraCapture request={camera} onDone={(f) => cameraDone.current?.(f)} />
    <iframe
      ref={ref}
      key={`${runtime.hash}:${key}`}
      title={runtime.form.title}
      sandbox="allow-scripts allow-forms allow-modals allow-downloads"
      srcDoc={doc}
      // Transparent: the page sits on the app's own background, like any screen.
      className={className ?? "block h-full w-full border-0 bg-transparent"}
    />
    </>
  );
}
