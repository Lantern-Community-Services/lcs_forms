import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { ExternalLink, Laptop, RefreshCw, RotateCw, Smartphone, Tablet } from "lucide-react";
import { cn } from "@/lib/utils";
import { previewFrameName, type DeviceKind } from "@/lib/device";

/**
 * The real app, in a phone, iPad or desktop frame (or iPad and phone side by
 * side), laid out at the device's true CSS size and scaled to fit. The frames
 * are same-origin iframes of an app path, so they share the sign-in, and each
 * one's width drives the app's own breakpoints exactly as the device would —
 * the sidebar folds, the tab bar appears, a code form picks its tablet view.
 * The same approach as public/devices.html, as a component.
 */

// CSS-pixel viewports of the real devices.
const MODELS: Record<DeviceKind, Record<string, [number, number]>> = {
  phone: { "iPhone 17 / 17 Pro": [402, 874], "iPhone 17 Pro Max": [440, 956], "iPhone 15 / 16": [393, 852], "iPhone SE": [375, 667], "Pixel 8": [412, 915] },
  tablet: { "iPad (10th gen) / Air": [820, 1180], "iPad mini": [744, 1133], 'iPad Pro 13"': [1032, 1376] },
  desktop: { "Laptop 1440×900": [1440, 900], "Small laptop 1280×800": [1280, 800], "Desktop 1920×1080": [1920, 1080] },
};
/** Bezel padding, status bar height, home-indicator inset (what env(safe-area-inset-bottom) would be). */
const CHROME: Record<DeviceKind, { pad: number; bar: number; inset: number }> = {
  phone: { pad: 14, bar: 54, inset: 34 },
  tablet: { pad: 22, bar: 24, inset: 20 },
  desktop: { pad: 0, bar: 34, inset: 0 },
};

type Mode = DeviceKind | "both";

interface Saved {
  mode: Mode;
  phone: string;
  tablet: string;
  desktop: string;
  landscape: boolean;
}

const STORE = "ln.devicePreview";

function load(initial: Mode): Saved {
  const base: Saved = { mode: initial, phone: Object.keys(MODELS.phone)[0], tablet: Object.keys(MODELS.tablet)[0], desktop: Object.keys(MODELS.desktop)[0], landscape: false };
  try {
    const s = { ...base, ...JSON.parse(localStorage.getItem(STORE) ?? "{}") } as Saved;
    for (const k of ["phone", "tablet", "desktop"] as DeviceKind[]) if (!MODELS[k][s[k]]) s[k] = base[k];
    return s;
  } catch {
    return base;
  }
}

export function DevicePreview({
  src,
  reloadKey = 0,
  initialMode = "tablet",
  onFrameLoad,
  className,
  toolbarExtra,
}: {
  /** App path to show, e.g. "/f/intake/preview". */
  src: string;
  /** Change to reload every frame. */
  reloadKey?: number;
  initialMode?: Mode;
  /** Each frame's window once it has loaded (same origin). */
  onFrameLoad?: (win: Window, kind: DeviceKind) => void;
  className?: string;
  toolbarExtra?: React.ReactNode;
}) {
  const [s, setS] = useState(() => load(initialMode));
  const [manualReload, setManualReload] = useState(0);
  const stage = useRef<HTMLDivElement>(null);
  const [room, setRoom] = useState({ w: 800, h: 600 });

  const update = (patch: Partial<Saved>) =>
    setS((cur) => {
      const next = { ...cur, ...patch };
      try {
        localStorage.setItem(STORE, JSON.stringify(next));
      } catch {
        /* not remembered */
      }
      return next;
    });

  useLayoutEffect(() => {
    const el = stage.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setRoom({ w: el.clientWidth, h: el.clientHeight }));
    ro.observe(el);
    setRoom({ w: el.clientWidth, h: el.clientHeight });
    return () => ro.disconnect();
  }, []);

  const kinds: DeviceKind[] = s.mode === "both" ? ["tablet", "phone"] : [s.mode];
  const size = (k: DeviceKind): [number, number] => {
    const [w, h] = MODELS[k][s[k]];
    return k !== "desktop" && s.landscape ? [h, w] : [w, h];
  };
  const outer = (k: DeviceKind) => {
    const [w, h] = size(k);
    const c = CHROME[k];
    return [w + c.pad * 2, h + c.pad * 2 + (k === "desktop" ? c.bar : 0)] as const;
  };
  const gap = 32;
  const labelH = 26;
  const totalW = kinds.reduce((n, k) => n + outer(k)[0], 0) + gap * (kinds.length - 1);
  const totalH = Math.max(...kinds.map((k) => outer(k)[1]));
  const scale = Math.max(0.1, Math.min(1, (room.w - 32) / totalW, (room.h - 32 - labelH) / totalH));

  return (
    <div className={cn("flex h-full min-h-0 flex-col", className)}>
      <div className="flex flex-none flex-wrap items-center gap-1.5 border-b border-hairline bg-surface px-3 py-1.5">
        <div className="inline-flex rounded-input border border-hairline p-0.5">
          {([["phone", "Phone", Smartphone], ["tablet", "iPad", Tablet], ["desktop", "Desktop", Laptop], ["both", "iPad + phone", null]] as const).map(([m, label, Icon]) => (
            <button key={m} type="button" onClick={() => update({ mode: m })} className={cn("inline-flex items-center gap-1 rounded-[5px] px-2 py-1 text-[12px] font-semibold", s.mode === m ? "bg-navy text-white" : "text-muted hover:text-ink")}>
              {Icon && <Icon className="h-3.5 w-3.5" />} {label}
            </button>
          ))}
        </div>
        {kinds.map((k) => (
          <select key={k} value={s[k]} onChange={(e) => update({ [k]: e.target.value } as Partial<Saved>)} aria-label={`${k} model`} className="h-7 rounded-input border border-hairline bg-surface px-1.5 text-[12px] text-ink">
            {Object.keys(MODELS[k]).map((name) => <option key={name}>{name}</option>)}
          </select>
        ))}
        {s.mode !== "desktop" && (
          <button type="button" onClick={() => update({ landscape: !s.landscape })} className="inline-flex h-7 items-center gap-1 rounded-input border border-hairline px-2 text-[12px] font-semibold text-ink hover:border-strongline" title="Rotate">
            <RotateCw className="h-3.5 w-3.5" /> {s.landscape ? "Landscape" : "Portrait"}
          </button>
        )}
        <button type="button" onClick={() => setManualReload((n) => n + 1)} className="inline-flex h-7 items-center rounded-input border border-hairline px-2 text-ink hover:border-strongline" title="Reload" aria-label="Reload">
          <RefreshCw className="h-3.5 w-3.5" />
        </button>
        <a href={src} target="_blank" rel="noreferrer" className="inline-flex h-7 items-center rounded-input border border-hairline px-2 text-ink hover:border-strongline" title="Open in a new tab" aria-label="Open in a new tab">
          <ExternalLink className="h-3.5 w-3.5" />
        </a>
        <div className="flex-1" />
        {toolbarExtra}
        <span className="tabular text-micro text-muted">{Math.round(scale * 100)}%</span>
      </div>
      <div ref={stage} className="flex min-h-0 flex-1 items-center justify-center overflow-hidden bg-subtle2 p-4" style={{ gap: gap * scale }}>
        {kinds.map((k) => (
          <Device key={k} kind={k} model={s[k]} size={size(k)} outer={outer(k)} scale={scale} landscape={s.landscape} src={src} reload={`${reloadKey}:${manualReload}`} onLoad={onFrameLoad} />
        ))}
      </div>
    </div>
  );
}

function Device({ kind, model, size, outer, scale, landscape, src, reload, onLoad }: {
  kind: DeviceKind;
  model: string;
  size: [number, number];
  outer: readonly [number, number];
  scale: number;
  landscape: boolean;
  src: string;
  reload: string;
  onLoad?: (win: Window, kind: DeviceKind) => void;
}) {
  const [w, h] = size;
  const c = CHROME[kind];
  const frame = useRef<HTMLIFrameElement>(null);
  const [dark, setDark] = useState(false);
  const [bar, setBar] = useState<string>("");
  const [clock, setClock] = useState(() => time());
  useEffect(() => {
    const id = setInterval(() => setClock(time()), 30_000);
    return () => clearInterval(id);
  }, []);

  /** What a real device gives the page (the home-bar inset) and what the page gives back (the status bar's color). */
  const sync = useCallback(() => {
    try {
      const doc = frame.current?.contentDocument;
      if (!doc) return;
      if (!doc.getElementById("device-preview-inset")) {
        const style = doc.createElement("style");
        style.id = "device-preview-inset";
        style.textContent = `html:root { --safe-bottom: ${c.inset}px; }`;
        doc.head.appendChild(style);
      }
      const root = doc.documentElement;
      setDark(root.classList.contains("dark"));
      const meta = doc.querySelector<HTMLMetaElement>('meta[name="theme-color"]');
      const channels = getComputedStyle(root).getPropertyValue(kind === "phone" ? "--c-sidebar" : "--c-surface").trim();
      setBar(kind === "phone" && meta?.content ? meta.content : channels ? `rgb(${channels.split(/\s+/).join(", ")})` : "");
    } catch {
      /* mid-navigation */
    }
  }, [c.inset, kind]);

  return (
    <div className="flex flex-none flex-col items-center gap-2">
      <p className="text-micro font-semibold text-muted">{model} · {w}×{h}{landscape && kind !== "desktop" ? " landscape" : ""}</p>
      <div className="relative" style={{ width: outer[0] * scale, height: outer[1] * scale }}>
        <div
          className="absolute left-0 top-0 origin-top-left shadow-[0_20px_50px_rgba(0,0,0,.25)]"
          style={{ transform: `scale(${scale})`, padding: c.pad, borderRadius: kind === "phone" ? 58 : kind === "tablet" ? 38 : 10, background: kind === "desktop" ? "transparent" : "#1b1f27" }}
        >
          <div className="relative flex flex-col overflow-hidden bg-white" style={{ width: w, height: h + (kind === "desktop" ? c.bar : 0), borderRadius: kind === "phone" ? 46 : kind === "tablet" ? 18 : 10 }}>
            {kind === "desktop" ? (
              <div className="flex flex-none items-center gap-1.5 border-b border-[#d9dde5] bg-[#eef0f4] px-3" style={{ height: c.bar }}>
                <span className="h-3 w-3 rounded-full bg-[#ff5f57]" /><span className="h-3 w-3 rounded-full bg-[#febc2e]" /><span className="h-3 w-3 rounded-full bg-[#28c840]" />
                <span className="ml-4 flex-1 truncate rounded-md bg-white px-3 py-1 text-[12px] text-[#6a7189]">{location.host}{src}</span>
              </div>
            ) : (
              <div className={cn("relative flex flex-none items-center justify-between font-semibold", dark ? "text-[#f2f2f2]" : "text-[#111]")} style={{ height: c.bar, background: bar || "#fbfcfd", padding: kind === "phone" ? "0 30px" : "0 22px", fontSize: kind === "phone" ? 15 : 12 }}>
                <span>{clock}</span>
                {kind === "phone" && <span className="absolute left-1/2 top-[11px] h-[34px] w-[120px] -translate-x-1/2 rounded-[20px] bg-black" />}
                <span className="text-[12px] tracking-[2px]">●●● 100%</span>
              </div>
            )}
            <iframe
              ref={frame}
              key={`${src}:${reload}:${kind}`}
              name={previewFrameName(kind)}
              src={src}
              title={`${model} preview`}
              onLoad={() => {
                sync();
                const win = frame.current?.contentWindow;
                if (win) onLoad?.(win, kind);
                try {
                  const doc = frame.current!.contentDocument!;
                  const mo = new MutationObserver(sync);
                  mo.observe(doc.documentElement, { attributes: true, attributeFilter: ["class", "style", "data-theme"] });
                  mo.observe(doc.head, { subtree: true, attributes: true, childList: true, attributeFilter: ["content"] });
                } catch {
                  /* ignore */
                }
              }}
              className="block border-0 bg-white"
              style={{ width: w, height: h - (kind === "desktop" ? 0 : c.bar) }}
            />
            {kind !== "desktop" && <div className={cn("pointer-events-none absolute bottom-2 left-1/2 h-[5px] -translate-x-1/2 rounded-[3px]", dark ? "bg-white/85" : "bg-black/85")} style={{ width: kind === "phone" ? 134 : 180 }} />}
          </div>
        </div>
      </div>
    </div>
  );
}

const time = () => new Date().toLocaleTimeString([], { hour: "numeric", minute: "2-digit" }).replace(/\s?[AP]M/, "");
