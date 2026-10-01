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
