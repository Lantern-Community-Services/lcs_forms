import { Worker } from "node:worker_threads";

/**
 * Runs a code form's server code in isolation.
 *
 * Each call gets a fresh QuickJS interpreter (a separate JavaScript engine
 * compiled to WebAssembly) inside a worker thread: no Node APIs, no file
 * system, no network, no process — only the functions handed to it below, with
 * a memory cap and a deadline. The server code sees `ctx.db` and friends as
 * ordinary synchronous calls; each one is a message to the main thread (which
 * runs the real query with Prisma) while the worker waits on Atomics.wait.
 *
 * The worker source is a string so it runs the same under tsx (dev) and the
 * compiled build (Docker) with no extra file to copy.
 */

const WORKER_SOURCE = String.raw`
const { parentPort } = require("node:worker_threads");
const { newQuickJSWASMModule, shouldInterruptAfterDeadline } = require("quickjs-emscripten");
const modP = newQuickJSWASMModule();
const decoder = new TextDecoder();

parentPort.on("message", async (job) => {
  const logs = [];
  let result;
  try {
    const mod = await modP;
    const ctrl = new Int32Array(job.sab, 0, 2);
    const bytes = new Uint8Array(job.sab, 8);
    const rt = mod.newRuntime();
    rt.setMemoryLimit(job.memoryBytes);
    rt.setMaxStackSize(1024 * 1024);
    rt.setInterruptHandler(shouldInterruptAfterDeadline(Date.now() + job.timeoutMs));
    const vm = rt.newContext();
    try {
      const hostCall = vm.newFunction("__hostCall", (nameH, argsH) => {
        const name = vm.getString(nameH);
        const args = vm.getString(argsH);
        Atomics.store(ctrl, 0, 0);
        parentPort.postMessage({ type: "host", name, args });
        const waited = Atomics.wait(ctrl, 0, 0, job.hostTimeoutMs);
        if (waited === "timed-out") return vm.newString(JSON.stringify({ error: "The database took too long to answer." }));
        const len = Atomics.load(ctrl, 1);
        return vm.newString(decoder.decode(bytes.slice(0, len)));
      });
      vm.setProp(vm.global, "__hostCall", hostCall);
      hostCall.dispose();
      const logFn = vm.newFunction("__log", (h) => { if (logs.length < 200) logs.push(vm.getString(h).slice(0, 4000)); });
      vm.setProp(vm.global, "__log", logFn);
      logFn.dispose();

      for (const [label, code] of [["bootstrap", job.bootstrap], ["server", job.bundle], ["call", job.call]]) {
        const r = vm.evalCode(code, label + ".js");
        if (r.error) { const e = vm.dump(r.error); r.error.dispose(); throw Object.assign(new Error(typeof e === "object" && e ? (e.message || JSON.stringify(e)) : String(e)), { stack: e && e.stack }); }
        r.value.dispose();
      }
      // Let promises (async hooks / actions) settle.
      for (let i = 0; i < 10000; i++) {
        const out = vm.getProp(vm.global, "__out");
        const v = vm.typeof(out) === "string" ? vm.getString(out) : null;
        out.dispose();
        if (v !== null) { result = JSON.parse(v); break; }
        const jobs = rt.executePendingJobs();
        if (jobs.error) { const e = vm.dump(jobs.error); jobs.error.dispose(); throw new Error(typeof e === "object" && e ? e.message : String(e)); }
        if (jobs.value === 0) {
          const again = vm.getProp(vm.global, "__out");
          const done = vm.typeof(again) === "string";
          again.dispose();
          if (!done) throw new Error("The server code's promise never settled.");
        }
      }
    } finally {
      vm.dispose();
      rt.dispose();
    }
  } catch (err) {
    const msg = String(err && err.message || err);
    result = { ok: false, error: /interrupted/i.test(msg) ? "The server code ran too long and was stopped." : /out of memory/i.test(msg) ? "The server code used too much memory." : msg, stack: err && err.stack ? String(err.stack) : undefined };
  }
  parentPort.postMessage({ type: "done", result, logs });
});
`;

/**
 * The guest-side runtime: `@lcs/server`, and ctx built on top of __hostCall.
 * Values cross the boundary as JSON text only.
 */
export const GUEST_BOOTSTRAP = String.raw`
globalThis.__out = undefined;
const __h = (name, args) => {
  const r = JSON.parse(__hostCall(name, JSON.stringify(args === undefined ? null : args)));
  if (r && r.error) { const e = new Error(r.error); e.fromHost = true; throw e; }
  return r ? r.value : undefined;
};
const __fmt = (a) => { try { return typeof a === "string" ? a : JSON.stringify(a); } catch (e) { return String(a); } };
globalThis.console = { log: (...a) => __log(a.map(__fmt).join(" ")), info: (...a) => __log(a.map(__fmt).join(" ")), warn: (...a) => __log("warn: " + a.map(__fmt).join(" ")), error: (...a) => __log("error: " + a.map(__fmt).join(" ")) };
class UserError extends Error { constructor(m) { super(m); this.name = "UserError"; this.userError = true; } }
globalThis.__lcsModules = { "@lcs/server": { defineServer: (d) => d, UserError } };
const __entriesApi = (form) => ({
  find: (q) => __h("entries.find", { form, q: q || {} }),
  count: (q) => __h("entries.count", { form, q: q || {} }),
  get: (id) => __h("entries.get", { form, id }),
});
// New York time without Intl time zones (QuickJS has none): US daylight saving
// runs from 2:00 on the second Sunday of March to 2:00 on the first Sunday of November.
const __sunday = (y, m, n) => { const first = (7 - new Date(Date.UTC(y, m, 1)).getUTCDay()) % 7; return 1 + first + (n - 1) * 7; };
const __nyOffset = (ms) => { const y = new Date(ms).getUTCFullYear(); const s = Date.UTC(y, 2, __sunday(y, 2, 2), 7); const e = Date.UTC(y, 10, __sunday(y, 10, 1), 6); return ms >= s && ms < e ? -4 : -5; };
const __local = (iso) => { const ms = typeof iso === "number" ? iso : Date.parse(iso); return new Date(ms + __nyOffset(ms) * 3600000); };
const __time = {
  partsOf: (iso) => { const l = __local(iso); return { day: l.toISOString().slice(0, 10), hour: l.getUTCHours(), weekday: (l.getUTCDay() + 6) % 7 }; },
  dayOf: (iso) => __local(iso).toISOString().slice(0, 10),
  startOfDay: (day) => { const off = __nyOffset(Date.parse(day + "T12:00:00Z")); return new Date(Date.parse(day + "T00:00:00Z") - off * 3600000).toISOString(); },
  addDays: (day, n) => { const d = new Date(day + "T12:00:00Z"); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); },
  minutesBetween: (a, b) => (Date.parse(b) - Date.parse(a)) / 60000,
};
globalThis.__makeCtx = (base) => ({
  ...base,
  db: {
    entries: __entriesApi(null),
    collections: {
      list: (name) => __h("collections.list", { name }),
      get: (name, id) => __h("collections.get", { name, id }),
      put: (name, id, data) => __h("collections.put", { name, id, data }),
      remove: (name, id) => __h("collections.remove", { name, id }),
    },
    form: (slug) => ({ entries: __entriesApi(slug) }),
  },
  roster: {
    site: (x) => __h("roster.site", { x }),
    sites: () => __h("roster.sites", {}),
    resident: (id) => __h("roster.resident", { id }),
    residents: (x) => __h("roster.residents", { x }),
  },
  time: __time,
  log: (...a) => __log(a.map(__fmt).join(" ")),
});
globalThis.__settle = (p) => Promise.resolve(p).then(
  (v) => { globalThis.__out = JSON.stringify({ ok: true, value: v === undefined ? null : v }); },
  (e) => { globalThis.__out = JSON.stringify({ ok: false, error: String(e && e.message || e), userError: !!(e && e.userError), stack: e && e.stack ? String(e.stack) : undefined }); }
);
`;

export interface SandboxResult {
  ok: boolean;
  value?: unknown;
  error?: string;
  userError?: boolean;
  stack?: string;
  logs: string[];
}

export type HostHandler = (name: string, args: any) => Promise<unknown>;

interface Slot {
  worker: Worker;
  busy: boolean;
}

const POOL_SIZE = 2;
const pool: Slot[] = [];
const waiting: ((s: Slot) => void)[] = [];
const REPLY_BYTES = 16 * 1024 * 1024;

function spawn(): Slot {
  const slot: Slot = { worker: new Worker(WORKER_SOURCE, { eval: true }), busy: false };
  slot.worker.unref();
  slot.worker.on("error", (err) => console.error("[apps] sandbox worker failed:", err));
  return slot;
}

function acquire(): Promise<Slot> {
  const free = pool.find((s) => !s.busy);
  if (free) {
    free.busy = true;
    return Promise.resolve(free);
  }
  if (pool.length < POOL_SIZE) {
    const s = spawn();
    s.busy = true;
    pool.push(s);
    return Promise.resolve(s);
  }
  return new Promise((resolve) => waiting.push(resolve));
}

function release(slot: Slot) {
  const next = waiting.shift();
  if (next) next(slot);
  else slot.busy = false;
}

function replace(slot: Slot) {
  const i = pool.indexOf(slot);
  void slot.worker.terminate();
  const fresh = spawn();
  if (i >= 0) pool[i] = fresh;
  return fresh;
}

/**
 * Run `call` (guest code that ends with __settle(...)) against a server
 * bundle. Host calls from the guest are answered by `onHost`.
 */
export async function runInSandbox(opts: { bundle: string; call: string; onHost: HostHandler; timeoutMs?: number }): Promise<SandboxResult> {
  const timeoutMs = opts.timeoutMs ?? 3000;
  let slot = await acquire();
  const sab = new SharedArrayBuffer(8 + REPLY_BYTES);
  const ctrl = new Int32Array(sab, 0, 2);
  const bytes = new Uint8Array(sab, 8);
  const encoder = new TextEncoder();

  return new Promise<SandboxResult>((resolve) => {
    let finished = false;
    // Wall-clock backstop: the interpreter's own deadline stops loops in guest
    // code, but not a guest stuck waiting on a host call that never returns.
    const killer = setTimeout(() => finish({ ok: false, error: "The server code ran too long and was stopped.", logs: [] }, true), timeoutMs + 5000);

    const finish = (r: SandboxResult, broken = false) => {
      if (finished) return;
      finished = true;
      clearTimeout(killer);
      slot.worker.off("message", onMessage);
      if (broken) slot = replace(slot);
      release(slot);
      resolve(r);
    };

    const onMessage = async (msg: { type: string; name?: string; args?: string; result?: SandboxResult; logs?: string[] }) => {
      if (msg.type === "done") return finish({ ...(msg.result as SandboxResult), logs: msg.logs ?? [] });
      if (msg.type !== "host") return;
      let reply: string;
      try {
        const value = await opts.onHost(msg.name!, JSON.parse(msg.args ?? "null"));
        reply = JSON.stringify({ value: value === undefined ? null : value });
      } catch (err) {
        reply = JSON.stringify({ error: err instanceof Error ? err.message : String(err) });
      }
      let buf = encoder.encode(reply);
      if (buf.length > REPLY_BYTES) buf = encoder.encode(JSON.stringify({ error: "That query returned too much data; ask for less (limit, dates)." }));
      bytes.set(buf);
      Atomics.store(ctrl, 1, buf.length);
      Atomics.store(ctrl, 0, 1);
      Atomics.notify(ctrl, 0);
    };

    slot.worker.on("message", onMessage);
    slot.worker.postMessage({
      sab,
      bootstrap: GUEST_BOOTSTRAP,
      bundle: opts.bundle,
      call: opts.call,
      timeoutMs,
      hostTimeoutMs: 10_000,
      memoryBytes: 64 * 1024 * 1024,
    });
  });
}
