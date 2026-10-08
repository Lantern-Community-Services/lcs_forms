/**
 * Runs before the app starts (Next's instrumentation-client), ahead of the dev
 * server's hot-reload connection.
 *
 * `next dev` only. The hot-reload client reconnects to the dev server, and after
 * 12 failed tries (about 40 s) it reloads the page, taking it to be gone for
 * good. Offline — an iPad testing offline mode against the dev server through
 * scripts/dev-https.mjs — that meant a reload from the service worker's copy
 * every 40 s or so, losing whatever was half typed. Here a hot-reload socket
 * that can't connect keeps quietly retrying instead of reporting the failure,
 * so the count never runs out. When the dev server is back it connects as
 * usual; Next still reloads then if the server restarted in between.
 *
 * The production build has no hot-reload client, so none of this runs there.
 */

if (process.env.NODE_ENV === "development" && typeof window !== "undefined") {
  const Real = window.WebSocket;
  const RETRY_MS = 5000;

  /** A hot-reload socket that stays "connecting" until a real one opens. */
  class PatientSocket extends EventTarget {
    binaryType: BinaryType = "blob";
    onopen: ((ev: Event) => void) | null = null;
    onmessage: ((ev: MessageEvent) => void) | null = null;
    onerror: ((ev: Event) => void) | null = null;
    onclose: ((ev: CloseEvent) => void) | null = null;
    private socket: WebSocket | null = null;
    private opened = false;
    private closed = false;
    private retry: ReturnType<typeof setTimeout> | null = null;

    constructor(
      readonly url: string,
      private readonly protocols?: string | string[]
    ) {
      super();
      this.connect();
    }

    get readyState() {
      if (this.closed) return Real.CLOSED;
      return this.opened && this.socket ? this.socket.readyState : Real.CONNECTING;
    }

    private connect() {
      if (this.closed) return;
      const socket = new Real(this.url, this.protocols);
      socket.binaryType = this.binaryType;
      this.socket = socket;
      socket.onopen = (ev) => {
        this.opened = true;
        socket.binaryType = this.binaryType;
        this.emit("open", ev);
      };
      socket.onmessage = (ev) => this.emit("message", ev);
      socket.onerror = (ev) => {
        if (this.opened) this.emit("error", ev);
      };
      socket.onclose = (ev) => {
        // Lost after connecting: tell the hot-reload client, which makes a new socket.
        if (this.opened) return this.emit("close", ev);
        // Never connected (no server, no network): try again, saying nothing.
        if (!this.closed) this.retry = setTimeout(() => this.connect(), RETRY_MS);
      };
    }

    private emit(type: "open" | "message" | "error" | "close", ev: Event) {
      const handler = this[`on${type}`] as ((ev: Event) => void) | null;
      handler?.call(this, ev);
      this.dispatchEvent(new (ev.constructor as typeof Event)(ev.type, ev));
    }

    send(data: string | ArrayBufferLike | Blob | ArrayBufferView) {
      if (this.opened) this.socket?.send(data);
    }

    close(code?: number, reason?: string) {
      this.closed = true;
      if (this.retry) clearTimeout(this.retry);
      this.socket?.close(code, reason);
    }
  }

  window.WebSocket = new Proxy(Real, {
    construct(target, args: [string | URL, (string | string[])?]) {
      const url = String(args[0]);
      if (url.includes("/_next/hmr")) return new PatientSocket(url, args[1]);
      return Reflect.construct(target, args);
    },
  });
}
