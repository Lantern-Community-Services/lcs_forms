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
          // Text on a bg-navy fill: white, or near-black when a custom theme's
          // colour is light. Falls back to white where the token isn't set.
          fg: "rgb(var(--c-on-brand, 255 255 255) / <alpha-value>)",
        },
        // Theme-aware tokens (light/dark values defined in index.css).
        ink: v("--c-ink"),
        muted: v("--c-muted"),
        hairline: v("--c-hairline"),
        // A form field's edge: 3:1 against the page, so a field reads as a field (WCAG 1.4.11).
        fieldline: v("--c-fieldline"),
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
          // Solid fills that carry white text (Success / Danger buttons, "Done" chips):
          // 4.5:1 with white in light and dark. The *Dot colours are for dots, not text.
          greenFill: v("--st-green-fill"),
          redFill: v("--st-red-fill"),
          amberFill: v("--st-amber-fill"),
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
      /**
       * The type scale: one named step per role instead of hand-picked pixel
       * sizes. The small steps grow by 1px on a phone or tablet (index.css,
       * html[data-device]), where text is read at arm's length.
       *   micro 11/12 · caption 12/13 · label 13/14 · body 14/15 · body-lg 15/16
       *   lead 17 · title-sm 20 · title 24 · display 28
       */
      // Sizes only, apart from micro and meta (as before): line heights stay
      // whatever the element already had (inherited, or its own leading-*).
      fontSize: {
        micro: ["var(--fs-micro)", "1.4"],
        meta: ["var(--fs-caption)", "1.4"],
        caption: "var(--fs-caption)",
        label: "var(--fs-label)",
        body: "var(--fs-body)",
        "body-lg": "var(--fs-body-lg)",
        lead: "17px",
        "title-sm": "20px",
        title: "24px",
        display: "28px",
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

/**
 * `touch:` — on a phone or a tablet (the shell, and a code form's runtime, keep
 * the device on <html data-device>). Controls use it to reach a 44px target.
 * `:is()` rather than `:where()`: its specificity lets `touch:` win over `md:`,
 * which on an iPad would otherwise put the desktop size back.
 */
export const TOUCH_SELECTOR = ':is(html[data-device="phone"], html[data-device="tablet"]) &';

/** The app's own Tailwind build: the `touch:` variant. */
export const touchPlugin = {
  handler: ({ addVariant }: { addVariant: AddVariant }) => addVariant("touch", TOUCH_SELECTOR),
};

/** A Tailwind plugin (the handler form works on the plain object API). */
export const framePlugin = {
  handler: ({ addVariant }: { addVariant: AddVariant }) => {
    addVariant("touch", TOUCH_SELECTOR);
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
