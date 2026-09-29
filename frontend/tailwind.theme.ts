/**
 * Lantern design tokens for Tailwind — the one place they're defined.
 * Used by tailwind.config.ts, and copied to backend/src/apps/tailwindTheme.ts
 * (by `npm run sync:engine` in backend/) so code forms' CSS is compiled with the
 * same tokens as the app. Edit here, then sync.
 */
import type { Config } from "tailwindcss";

const v = (name: string) => `rgb(var(${name}) / <alpha-value>)`;

export const theme: Config["theme"] = {
    extend: {
      colors: {
        navy: {
          DEFAULT: v("--c-brand"),
          600: v("--c-brand-600"),
          700: v("--c-brand-700"),
        },
        // Theme-aware tokens (light/dark values defined in index.css).
        ink: v("--c-ink"),
        muted: v("--c-muted"),
        hairline: v("--c-hairline"),
        divider: v("--c-divider"),
        appbg: v("--c-appbg"),
        surface: v("--c-surface"),
        sidebar: v("--c-sidebar"),
        rowhover: v("--c-rowhover"),
        navsel: v("--c-navsel"),
        subtle: v("--c-subtle"),
        subtle2: v("--c-subtle2"),
        strongline: v("--c-strongline"),
        accent: v("--c-accent"),
        teal: {
          DEFAULT: v("--c-teal"),
          tint: v("--c-teal-tint"),
          tintborder: v("--c-teal-tintborder"),
        },
        // Status palette (theme-aware; dark values muted in index.css).
        status: {
          amberBg: v("--st-amber-bg"),
          amberText: v("--st-amber-text"),
          amberDot: v("--st-amber-dot"),
          blueBg: v("--st-blue-bg"),
          blueText: v("--st-blue-text"),
          blueDot: v("--st-blue-dot"),
          violetBg: v("--st-violet-bg"),
          violetText: v("--st-violet-text"),
          violetDot: v("--st-violet-dot"),
          greenBg: v("--st-green-bg"),
          greenText: v("--st-green-text"),
          greenDot: v("--st-green-dot"),
          redBg: v("--st-red-bg"),
          redText: v("--st-red-text"),
          redDot: v("--st-red-dot"),
          neutralBg: v("--st-neutral-bg"),
          neutralText: v("--st-neutral-text"),
        },
        aibanner: {
          bg: v("--c-aibanner-bg"),
          border: v("--c-aibanner-border"),
          text: v("--c-aibanner-text"),
        },
        aging: {
          bg: v("--c-aging-bg"),
          text: v("--c-aging-text"),
          border: v("--c-aging-border"),
        },
      },
      fontFamily: {
        heading: ['Archivo', 'system-ui', 'sans-serif'],
        body: ['Archivo', 'system-ui', 'sans-serif'],
      },
      borderRadius: {
        card: "10px",
        panel: "9px",
        input: "6px",
        pill: "100px",
      },
      boxShadow: {
        panel: "0 16px 44px rgba(35,42,58,.10)",
        modal: "0 24px 60px rgba(35,42,58,.28)",
        card: "0 1px 2px rgba(35,42,58,.06)",
      },
      fontSize: {
        micro: ["11px", "1.4"],
        meta: ["11.5px", "1.4"],
      },
      /**
       * Phone chrome: the notch insets folded into ordinary padding, so
       * `pt-safe-top` reads as "the usual top padding, clear of the status
       * bar" and collapses to plain 12px on a device without one.
       *
       * `pb-safe-bottom` is the one bottom inset for every phone surface that
       * meets the bottom edge — the tab bar, sheets, sticky footers — so none
       * of them puts a control on the iOS swipe-home strip, and they all stop
       * at the same height (see --tabbar-bottom in index.css).
       */
      spacing: {
        "safe-top": "calc(12px + var(--safe-top))",
        "safe-bottom": "var(--tabbar-bottom)",
      },
    },
  };

// ── Code-form frames ────────────────────────────────────────────────────────
//
// A code form's page runs in an iframe, where a media query sees the frame's
// width, not the device's. So inside frames the breakpoints are variants keyed
// on attributes the runtime keeps on <html> from the HOST window: `md:` means
// what it means everywhere else in the app (the device is at least 768px wide),
// and a page ported from the app lays out exactly the same. Frames also get
// phone: / tablet: / desktop: and portrait: / landscape: for the device itself.

export const FRAME_BREAKPOINTS = { sm: 640, md: 768, lg: 1024, xl: 1280, "2xl": 1536 } as const;

type AddVariant = (name: string, selector: string) => void;

/** A Tailwind plugin (the handler form works on the plain object API). */
export const framePlugin = {
  handler: ({ addVariant }: { addVariant: AddVariant }) => {
    const names = Object.keys(FRAME_BREAKPOINTS);
    for (const n of names) addVariant(n, `:where(html[data-bp~="${n}"]) &`);
    for (const n of [...names].reverse()) addVariant(`max-${n}`, `:where(html:not([data-bp~="${n}"])) &`);
    addVariant("portrait", ':where(html[data-orientation="portrait"]) &');
    addVariant("landscape", ':where(html[data-orientation="landscape"]) &');
    for (const d of ["phone", "tablet", "desktop"]) addVariant(d, `:where(html[data-device="${d}"]) &`);
  },
};

/** The theme for frames: the app's tokens, with media-query breakpoints swapped for the variants above. */
export const frameTheme = { ...theme, screens: {} } as Config["theme"];
