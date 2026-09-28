import { createContext, useContext, useEffect, useState, type ReactNode } from "react";
import { readStorage, writeStorage } from "./storage";

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

function blend(color: [number, number, number], against: [number, number, number], amount: number) {
  return color.map((v, i) => Math.round(v * amount + against[i] * (1 - amount))).join(" ");
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

  useEffect(() => {
    const root = document.documentElement;
    root.dataset.theme = theme;
    writeStorage("ln.theme", theme);

    if (theme !== "custom" || dark) {
      ["--c-brand", "--c-brand-600", "--c-brand-700", "--c-accent", "--c-sidebar", "--c-navsel", "--c-rowhover"].forEach((key) => root.style.removeProperty(key));
      return;
    }

    const color = rgb(customThemeColor);
    root.style.setProperty("--c-brand", color.join(" "));
    root.style.setProperty("--c-brand-600", blend(color, [0, 0, 0], 0.82));
    root.style.setProperty("--c-brand-700", blend(color, [0, 0, 0], 0.65));
    root.style.setProperty("--c-accent", dark ? blend(color, [255, 255, 255], 0.68) : color.join(" "));
    root.style.setProperty("--c-sidebar", dark ? blend(color, [15, 19, 30], 0.20) : blend(color, [255, 255, 255], 0.08));
    root.style.setProperty("--c-navsel", dark ? blend(color, [15, 19, 30], 0.38) : blend(color, [255, 255, 255], 0.19));
    root.style.setProperty("--c-rowhover", dark ? blend(color, [23, 29, 43], 0.14) : blend(color, [255, 255, 255], 0.06));
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
