import { useEffect, useMemo, useRef, useState } from "react";
import type { CodeBlock, Values } from "@/lib/formEngine";

/**
 * A custom code block, run in a sandboxed iframe.
 *
 * `sandbox="allow-scripts"` without allow-same-origin gives the frame an
 * opaque origin: it can't read this app's cookies, storage or DOM, and can't
 * call the API as the person filling in. Its own CSP blocks network requests,
 * so it can't send answers anywhere either. It talks to the form only through
 * postMessage, via the small `lcs` object defined in BOOTSTRAP below (the
 * documented API is CODE_BLOCK_API in formEngine).
 */

const BOOTSTRAP = `
(function () {
  var state = { value: undefined, values: {}, user: null, listeners: [] };
  function post(msg) { parent.postMessage(Object.assign({ __lcs: true }, msg), "*"); }
  window.lcs = {
    get value() { return state.value; },
    get values() { return JSON.parse(JSON.stringify(state.values)); },
    get user() { return state.user; },
    setValue: function (v) { state.value = v; post({ t: "set", value: v === undefined ? null : JSON.parse(JSON.stringify(v)) }); },
    setValid: function (ok, message) { post({ t: "valid", ok: !!ok, message: message ? String(message) : "" }); },
    onChange: function (fn) { if (typeof fn === "function") state.listeners.push(fn); },
    resize: function (px) { post({ t: "height", px: typeof px === "number" ? px : contentHeight() }); }
  };
  // The root element's box is the content's height (scrollHeight would never
  // report less than the frame is now, so a frame could grow but not shrink).
  function contentHeight() { return Math.ceil(document.documentElement.getBoundingClientRect().height); }
  window.addEventListener("message", function (e) {
    var d = e.data || {};
    if (!d.__lcs) return;
    if (d.t === "init") { state.value = d.value; state.values = d.values || {}; state.user = d.user || null; document.dispatchEvent(new Event("lcs:ready")); }
    if (d.t === "values") { state.values = d.values || {}; state.listeners.forEach(function (fn) { try { fn(window.lcs.values); } catch (err) { console.error(err); } }); }
  });
  window.addEventListener("error", function (e) { post({ t: "error", message: String(e.message || e) }); });
  document.addEventListener("DOMContentLoaded", function () {
    new ResizeObserver(function () { window.lcs.resize(); }).observe(document.body);
  });
})();`;

function srcDoc(code: CodeBlock) {
  // The user script waits for the first values so `lcs.value` is filled in when it runs.
  const js = (code.js ?? "").replace(/<\/script/gi, "<\\/script");
  return `<!doctype html><html><head><meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data: https:; font-src data:">
<style>html,body{margin:0;font:14px system-ui,-apple-system,Segoe UI,sans-serif;color:#232a3a;background:transparent}${code.css ?? ""}</style>
<script>${BOOTSTRAP}</script></head><body>${code.html ?? ""}
<script>document.addEventListener("lcs:ready",function(){try{${js}\n}catch(err){parent.postMessage({__lcs:true,t:"error",message:String(err&&err.message||err)},"*")}},{once:true});</script>
</body></html>`;
}

export function CodeBlockFrame({
  code,
  value,
  values,
  user,
  onChange,
  onValidity,
  title,
}: {
  code: CodeBlock;
  value: unknown;
  values: Values;
  user: { name: string; email: string } | null;
  onChange?: (v: unknown) => void;
  onValidity?: (message: string | null) => void;
  title: string;
}) {
  const ref = useRef<HTMLIFrameElement>(null);
  const [height, setHeight] = useState(code.height ?? 120);
  const [error, setError] = useState<string | null>(null);
  const doc = useMemo(() => srcDoc(code), [code.html, code.css, code.js]); // eslint-disable-line react-hooks/exhaustive-deps
  const latest = useRef({ value, values, user, onChange, onValidity });
  latest.current = { value, values, user, onChange, onValidity };

  useEffect(() => {
    const onMessage = (e: MessageEvent) => {
      if (e.source !== ref.current?.contentWindow || !e.data?.__lcs) return;
      const d = e.data;
      if (d.t === "set") latest.current.onChange?.(d.value);
      if (d.t === "valid") latest.current.onValidity?.(d.ok ? null : d.message || "Please complete this part.");
      if (d.t === "height" && typeof d.px === "number") setHeight(Math.max(20, Math.min(4000, d.px)));
      if (d.t === "error") setError(d.message);
    };
    window.addEventListener("message", onMessage);
    return () => window.removeEventListener("message", onMessage);
  }, []);

  // Tell the frame about every answer change (it may compute from them).
  useEffect(() => {
    ref.current?.contentWindow?.postMessage({ __lcs: true, t: "values", values }, "*");
  }, [values]);

  return (
    <div>
      <iframe
        ref={ref}
        title={title}
        sandbox="allow-scripts"
        srcDoc={doc}
        onLoad={() => {
          setError(null);
          const l = latest.current;
          ref.current?.contentWindow?.postMessage({ __lcs: true, t: "init", value: l.value ?? null, values: l.values, user: l.user }, "*");
        }}
        style={{ height }}
        className="block w-full rounded-input border border-hairline bg-white"
      />
      {error && <p className="mt-1 text-micro text-status-redText">Custom code error: {error}</p>}
    </div>
  );
}
