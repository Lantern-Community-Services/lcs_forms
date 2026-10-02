import { useMediaQuery } from "./useMediaQuery";

/**
 * The device a page is being shown on, when a preview says so.
 *
 * The device previews (components/preview/DevicePreview, public/devices.html)
 * load the real app in an iframe at a device's true size, which gets the
 * breakpoints right, but a desktop browser still reports a mouse, so an
 * "iPad" frame would look like a narrow desktop to anything that asks about
 * touch. The preview names its iframe "lcs-device:<kind>"; code that decides
 * phone / tablet / desktop checks this first.
 */
export type DeviceKind = "phone" | "tablet" | "desktop";

export function forcedDevice(): DeviceKind | null {
  try {
    const m = /^lcs-device:(phone|tablet|desktop)$/.exec(window.name);
    return (m?.[1] as DeviceKind | undefined) ?? null;
  } catch {
    return null;
  }
}

export const previewFrameName = (kind: DeviceKind) => `lcs-device:${kind}`;

/**
 * A phone or a tablet, as opposed to a computer, however wide or narrow its
 * window — where offline mode runs (lib/offline.ts). Touch as the main pointer,
 * or an iPhone / iPad / Android device by name: an iPad with a trackpad
 * keyboard can report a fine pointer, and iPadOS Safari calls itself a Mac
 * (but has touch points). A Windows touch laptop's main pointer is its
 * trackpad, so it counts as a computer. Not a hook: decided once, at start.
 */
export function isMobileDevice(): boolean {
  const forced = forcedDevice();
  if (forced) return forced !== "desktop";
  if (typeof window === "undefined") return false;
  const ua = navigator.userAgent;
  if (/iPhone|iPad|iPod|Android/i.test(ua)) return true;
  if (/Macintosh/.test(ua) && navigator.maxTouchPoints > 1) return true;
  return window.matchMedia?.("(pointer: coarse)").matches ?? false;
}

/**
 * Which navigation the shell shows: the sidebar on a computer, the dock on a
 * phone or a tablet. A tablet is a touch screen at least `md` wide — a coarse
 * primary pointer — so a touch laptop, whose primary pointer is still the
 * trackpad, keeps the sidebar. A preview frame's word wins over both.
 */
export function useDeviceKind(): DeviceKind {
  const narrow = useMediaQuery("(max-width: 767px)");
  const touchWide = useMediaQuery("(min-width: 768px) and (pointer: coarse)");
  const forced = forcedDevice();
  if (forced) return forced;
  return narrow ? "phone" : touchWide ? "tablet" : "desktop";
}
