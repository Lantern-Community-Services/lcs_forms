import { createContext, useContext, useEffect, useLayoutEffect, useState, type ReactNode } from "react";
import { currentDeviceKind } from "./device";
import { readStorage, writeStorage } from "./storage";

// The device on <html data-device>: `touch:` controls and the type scale's touch
// steps key on it (as they do in a code form's frame). Set before the first paint.
if (typeof document !== "undefined") document.documentElement.dataset.device = currentDeviceKind();

export type ThemeName = "lantern" | "ocean" | "plum" | "forest" | "custom";

interface Prefs {
  dark: boolean;
  setDark: (dark: boolean) => void;
  theme: ThemeName;
  setTheme: (theme: ThemeName) => void;
  customThemeColor: string;
  setCustomThemeColor: (color: string) => void;
  collapsed: boolean;
  toggleCollapsed: () => void;
}

const PrefsContext = createContext<Prefs | null>(null);

function readBool(key: string, fallback: boolean): boolean {
  const v = readStorage(key);
  return v === null ? fallback : v === "1";
}

function readTheme(): ThemeName {
  const value = readStorage("ln.theme");
  return value === "ocean" || value === "plum" || value === "forest" || value === "custom" ? value : "lantern";
}

function readColor(): string {
  const value = readStorage("ln.theme.custom") ?? "";
  return /^#[0-9a-f]{6}$/i.test(value) ? value : "#2c3453";
}

function rgb(hex: string): [number, number, number] {
  const value = hex.replace("#", "");
  return [parseInt(value.slice(0, 2), 16), parseInt(value.slice(2, 4), 16), parseInt(value.slice(4, 6), 16)];
}

/** WCAG relative luminance of an sRGB colour, 0 (black) to 1 (white). */
function luminance(color: [number, number, number]): number {
  const [r, g, b] = color.map((v) => {
    const c = v / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

/** True when black text reads better on this colour than white text does. */
function isLight(color: [number, number, number]): boolean {
  // Contrast with black beats contrast with white above L ≈ 0.179.
  return luminance(color) > 0.179;
}

function blend(color: [number, number, number], against: [number, number, number], amount: number) {
  return color.map((v, i) => Math.round(v * amount + against[i] * (1 - amount))).join(" ");
}

/**
 * In dark mode a deep colour sinks into the near-black page (a navy button at
 * 1.6:1 against it). Lift it toward white until the fill stands 3:1 off the
 * page, as the built-in themes' dark versions do (index.css).
 */
function liftForDark(color: [number, number, number]): [number, number, number] {
  const page = luminance([15, 15, 15]);
  let c = color;
  for (let i = 0; i < 16 && (luminance(c) + 0.05) / (page + 0.05) < 3; i++) {
    c = c.map((v) => Math.round(v * 0.9 + 255 * 0.1)) as [number, number, number];
  }
  return c;
}

/** Local display preferences intentionally stay separate from profile data. */
export function PrefsProvider({ children }: { children: ReactNode }) {
  const [dark, setDark] = useState(() => readBool("ln.dark", window.matchMedia?.("(prefers-color-scheme: dark)").matches ?? false));
  const [theme, setTheme] = useState<ThemeName>(readTheme);
  const [customThemeColor, setCustomThemeColor] = useState(readColor);
  const [collapsed, setCollapsed] = useState(() => readBool("ln.collapsed", false));

  useEffect(() => {
    document.documentElement.classList.toggle("dark", dark);
    writeStorage("ln.dark", dark ? "1" : "0");
  }, [dark]);

  // Kept current as the window crosses a breakpoint or rotates. Read straight from
  // the browser (currentDeviceKind), not useDeviceKind, whose first render says
  // "desktop" and would flash desktop-size controls on a phone.
  useLayoutEffect(() => {
    const update = () => {
      document.documentElement.dataset.device = currentDeviceKind();
    };
    update();
    const queries = ["(max-width: 767px)", "(min-width: 768px) and (pointer: coarse)"].map((q) => window.matchMedia?.(q));
    queries.forEach((q) => q?.addEventListener?.("change", update));
    return () => queries.forEach((q) => q?.removeEventListener?.("change", update));
  }, []);


  useEffect(() => {
    const root = document.documentElement;
    root.dataset.theme = theme;
    writeStorage("ln.theme", theme);

    if (theme !== "custom") {
      ["--c-brand", "--c-brand-600", "--c-brand-700", "--c-on-brand", "--c-accent", "--c-sidebar", "--c-navsel", "--c-rowhover"].forEach((key) => root.style.removeProperty(key));
      return;
    }

    const picked = rgb(customThemeColor);
    const color = dark ? liftForDark(picked) : picked;
    const light = isLight(color);
    root.style.setProperty("--c-brand", color.join(" "));
    root.style.setProperty("--c-brand-600", blend(color, [0, 0, 0], 0.82));
    root.style.setProperty("--c-brand-700", blend(color, [0, 0, 0], 0.65));
    // Text on buttons and other brand fills flips to near-black on a light colour.
    root.style.setProperty("--c-on-brand", light ? "17 17 17" : "255 255 255");
    // Dark versions blend toward the neutral dark page (.dark in index.css), and
    // the accent goes over halfway to white so even a deep colour reads on it.
    // In light mode a light colour would vanish as link text on white, so it is
    // darkened over halfway to black instead.
    root.style.setProperty("--c-accent", dark ? blend(color, [255, 255, 255], 0.45) : light ? blend(color, [0, 0, 0], 0.45) : color.join(" "));
    root.style.setProperty("--c-sidebar", dark ? blend(color, [5, 5, 5], 0.12) : blend(color, [255, 255, 255], 0.08));
    root.style.setProperty("--c-navsel", dark ? blend(color, [15, 15, 15], 0.32) : blend(color, [255, 255, 255], 0.19));
    root.style.setProperty("--c-rowhover", dark ? blend(color, [15, 15, 15], 0.12) : blend(color, [255, 255, 255], 0.06));
    writeStorage("ln.theme.custom", customThemeColor);
  }, [theme, customThemeColor, dark]);

  // Browser chrome follows the app: Safari tints its status bar / toolbar and
  // Android its address bar from <meta name="theme-color">. Declared after the
  // effects above so it reads the colours they've just applied.
  useEffect(() => {
    const channels = getComputedStyle(document.documentElement).getPropertyValue("--c-sidebar").trim();
    if (!channels) return;
    let meta = document.querySelector<HTMLMetaElement>('meta[name="theme-color"]');
    if (!meta) {
      meta = document.createElement("meta");
      meta.name = "theme-color";
      document.head.appendChild(meta);
    }
    meta.content = `rgb(${channels.split(/\s+/).join(", ")})`;
    // Also tells iOS which way round the status-bar text should be.
    document.documentElement.style.colorScheme = dark ? "dark" : "light";
  }, [dark, theme, customThemeColor]);

  useEffect(() => {
    writeStorage("ln.collapsed", collapsed ? "1" : "0");
  }, [collapsed]);

  return (
    <PrefsContext.Provider value={{ dark, setDark, theme, setTheme, customThemeColor, setCustomThemeColor, collapsed, toggleCollapsed: () => setCollapsed((c) => !c) }}>
      {children}
    </PrefsContext.Provider>
  );
}

export function usePrefs() {
  const ctx = useContext(PrefsContext);
  if (!ctx) throw new Error("usePrefs must be used within PrefsProvider");
  return ctx;
}
