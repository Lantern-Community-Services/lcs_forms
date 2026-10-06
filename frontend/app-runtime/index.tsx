/**
 * The code-form runtime: loaded once into every code form's sandboxed frame
 * (public/app-runtime/runtime.js, built by scripts/build-app-runtime.mjs).
 * It provides the modules a page may import and mounts the page once the host
 * has said who's using it.
 */
import * as React from "react";
import * as JsxRuntime from "react/jsx-runtime";
import * as ReactDOM from "react-dom";
import * as ReactDOMClient from "react-dom/client";
import * as Lucide from "lucide-react";
import * as sdk from "./sdk";
import * as ui from "./ui";
import * as charts from "./charts";

declare global {
  interface Window {
    LCS: { modules: Record<string, unknown>; mount: (Page: React.ComponentType) => void };
  }
}

const { post, onHostMessage, contextReady, useApp } = sdk;

// Everything the page prints goes to the editor's console too.
for (const level of ["log", "info", "warn", "error"] as const) {
  const original = console[level].bind(console);
  console[level] = (...args: unknown[]) => {
    original(...args);
    try {
      post({ t: "console", level, args: args.map((a) => (a instanceof Error ? `${a.message}\n${a.stack ?? ""}` : typeof a === "string" ? a : JSON.stringify(a))) });
    } catch {
      post({ t: "console", level, args: args.map(String) });
    }
  };
}
window.addEventListener("error", (e) => post({ t: "crash", message: e.message, stack: e.error?.stack }));
window.addEventListener("unhandledrejection", (e) => post({ t: "crash", message: String(e.reason?.message ?? e.reason), stack: e.reason?.stack }));

window.addEventListener("message", (e) => {
  if (e.source !== parent || !e.data || e.data.__lcsHost !== 1) return;
  const d = e.data;
  if (d.t === "theme") applyTheme(d.theme);
  else onHostMessage(d);
});

function applyTheme(t: { className: string; dataTheme: string; style: string }) {
  const root = document.documentElement;
  root.className = t.className;
  root.dataset.theme = t.dataTheme;
  root.setAttribute("style", t.style);
}

class Boundary extends React.Component<{ children: React.ReactNode }, { error: Error | null }> {
  state = { error: null as Error | null };
  static getDerivedStateFromError(error: Error) {
    return { error };
  }
  componentDidCatch(error: Error) {
    post({ t: "crash", message: error.message, stack: error.stack });
  }
  render() {
    if (!this.state.error) return this.props.children;
    return (
      <div className="m-4 rounded-card border border-status-redDot/50 bg-status-redBg p-4 text-[13px] text-status-redText">
        <p className="font-bold">This page hit an error.</p>
        <pre className="mt-2 whitespace-pre-wrap font-mono text-[12px]">{this.state.error.message}</pre>
        <button className="mt-3 font-semibold underline" onClick={() => this.setState({ error: null })}>Try again</button>
      </div>
    );
  }
}

function Root({ Page }: { Page: React.ComponentType }) {
  const ctx = useApp();
  if (!ctx) return null;
  return (
    <Boundary>
      <Page />
    </Boundary>
  );
}

let mounted = false;
function mount(Page: React.ComponentType) {
  if (mounted) return;
  mounted = true;
  const start = () => ReactDOMClient.createRoot(document.getElementById("root")!).render(<Root Page={Page} />);
  if (contextReady()) start();
  else {
    const wait = setInterval(() => {
      if (contextReady()) {
        clearInterval(wait);
        start();
      }
    }, 10);
  }
  post({ t: "ready" });
}

window.LCS = {
  modules: {
    react: React,
    "react/jsx-runtime": JsxRuntime,
    "react-dom": ReactDOM,
    "react-dom/client": ReactDOMClient,
    "lucide-react": Lucide,
    "@lcs/sdk": sdk,
    "@lcs/ui": ui,
    "@lcs/charts": charts,
  },
  mount,
};
post({ t: "hello" });
