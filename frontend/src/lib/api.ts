import { cachedAtOf, noteNetworkFailure, noteResponse, requestStarted } from "./offline";

const BASE = process.env.NEXT_PUBLIC_API_BASE_URL || "/api";

/**
 * Called once when the server says the caller is no longer authenticated.
 *
 * Sessions last seven days and the server re-reads permissions on every
 * request, so a session can lapse — or an admin can revoke access — in the
 * middle of somebody's afternoon. AuthProvider only asked once, at mount, so
 * the shell went on rendering them as signed in while every request 401'd:
 * an app that looks fine and does nothing. Registered by AuthProvider.
 */
let onSessionLost: (() => void) | null = null;
export function setSessionLostHandler(fn: (() => void) | null) {
  onSessionLost = fn;
}

/** Endpoints where a 401 is an answer, not a surprise. */
function expectsUnauthenticated(path: string) {
  return path.startsWith("/auth/me") || path.startsWith("/auth/logout");
}

function noteUnauthorized(path: string) {
  if (expectsUnauthenticated(path)) return;
  onSessionLost?.();
}

export class ApiError extends Error {
  status: number;
  details?: unknown;
  /** Server-side reference for a 500, to quote when reporting it. */
  requestId?: string;
  constructor(status: number, message: string, details?: unknown, requestId?: string) {
    super(message);
    this.status = status;
    this.details = details;
    this.requestId = requestId;
  }
}

/**
 * The request never got an answer: no connection, or the server is down.
 * Deliberately not an ApiError — the upload queues read "not an ApiError" as
 * "try again later". Its message replaces the browser's "Load failed".
 */
export class NetworkError extends Error {
  constructor() {
    super("No connection. Check the internet and try again.");
    this.name = "NetworkError";
  }
}

async function request<T>(method: string, path: string, body?: unknown): Promise<T> {
  return (await requestWithMeta<T>(method, path, body)).data;
}

async function requestWithMeta<T>(method: string, path: string, body?: unknown, opts: { background?: boolean } = {}): Promise<{ data: T; cachedAt: number | null }> {
  // Screens' own requests hold off background work (lib/snapshot.ts) until they're done.
  const ended = opts.background ? null : requestStarted();
  try {
    return await send<T>(method, path, body);
  } finally {
    ended?.();
  }
}

async function send<T>(method: string, path: string, body?: unknown): Promise<{ data: T; cachedAt: number | null }> {
  let res: Response;
  try {
    res = await fetch(`${BASE}${path}`, {
      method,
      credentials: "include",
      headers: body instanceof FormData ? {} : { "Content-Type": "application/json" },
      body: body instanceof FormData ? body : body != null ? JSON.stringify(body) : undefined,
    });
  } catch (e) {
    if (e instanceof DOMException && e.name === "AbortError") throw e;
    noteNetworkFailure();
    throw new NetworkError();
  }
  // Fresh from the server, or the service worker's stored copy (public/sw.js) — see lib/offline.ts.
  noteResponse(res);
  const cachedAt = cachedAtOf(res);

  if (!res.ok) {
    let payload: any = undefined;
    try {
      payload = await res.json();
    } catch {
      // ignore
    }
    if (res.status === 401) noteUnauthorized(path);
    // requestId comes back on server faults — carried so the message can quote
    // something the logs can be searched for.
    throw new ApiError(res.status, payload?.error ?? res.statusText, payload?.details, payload?.requestId);
  }

  const contentType = res.headers.get("content-type") ?? "";
  if (contentType.includes("application/json")) return { data: (await res.json()) as T, cachedAt };
  return { data: (await res.text()) as unknown as T, cachedAt };
}

export const api = {
  get: <T>(path: string) => request<T>("GET", path),
  /** A GET plus, when there's no connection and the answer is the device's stored copy, when that copy was saved (ms). */
  getWithMeta: <T>(path: string) => requestWithMeta<T>("GET", path),
  /** A GET for background work: it doesn't count as the app being busy. */
  getInBackground: <T>(path: string) => requestWithMeta<T>("GET", path, undefined, { background: true }).then((r) => r.data),
  post: <T>(path: string, body?: unknown) => request<T>("POST", path, body),
  patch: <T>(path: string, body?: unknown) => request<T>("PATCH", path, body),
  put: <T>(path: string, body?: unknown) => request<T>("PUT", path, body),
  /** Body is optional — used where a delete needs a decision, e.g. "move these people to…". */
  delete: <T>(path: string, body?: unknown) => request<T>("DELETE", path, body),

  /** Upload files (multipart). */
  upload: async <T>(path: string, formData: FormData) => request<T>("POST", path, formData),

  /** Download a file (e.g. CSV export) and trigger a browser save. */
  download: async (path: string, body: unknown, fallbackName: string) => {
    const res = await fetch(`${BASE}${path}`, {
      method: "POST",
      credentials: "include",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    if (!res.ok) {
      let payload: any;
      try {
        payload = await res.json();
      } catch {}
      if (res.status === 401) noteUnauthorized(path);
      throw new ApiError(res.status, payload?.error ?? res.statusText, payload?.details, payload?.requestId);
    }
    const blob = await res.blob();
    const disposition = res.headers.get("content-disposition") ?? "";
    const match = /filename="?([^"]+)"?/.exec(disposition);
    const name = match?.[1] ?? fallbackName;
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = name;
    a.click();
    URL.revokeObjectURL(url);
    return { batchId: res.headers.get("x-export-batch-id") };
  },
};

export { BASE as API_BASE };
