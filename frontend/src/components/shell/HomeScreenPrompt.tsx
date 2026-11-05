import { useEffect, useState } from "react";
import { ChevronDown, Ellipsis, Share, SquarePlus } from "lucide-react";
import { useAuth } from "@/lib/auth";
import { useTour } from "@/lib/tour/TourProvider";
import { ResponsiveDialog } from "@/components/ui/responsive-dialog";
import { Button } from "@/components/ui/button";

/**
 * Asks someone using the site in an iPad or iPhone browser tab to add it to
 * their home screen, and shows them how.
 *
 * A home-screen app is what the site is built for (no browser bar, pull to
 * refresh), and offline mode is safer there: iOS may erase everything a
 * website saved in Safari — the offline copy and entries still waiting to
 * upload — once it hasn't been opened for seven days. Home-screen apps are
 * exempt.
 *
 * Shown by itself a few seconds after the app opens, never over the welcome
 * tour or a form locked for a resident; "Not now" waits three days. Profile →
 * Offline opens it any time (openHomeScreenHelp).
 */

const SNOOZE_KEY = "lcs.homeScreen.snoozedUntil";
const SNOOZE_MS = 3 * 24 * 60 * 60 * 1000;
const OPEN_EVENT = "lcs:home-screen-help";

export type AppleDevice = "iphone" | "ipad";

/** An iPhone or iPad (iPadOS Safari calls itself a Mac, but has touch points), else null. */
export function appleDevice(): AppleDevice | null {
  if (typeof navigator === "undefined") return null;
  const ua = navigator.userAgent;
  if (/iPhone|iPod/.test(ua)) return "iphone";
  if (/iPad/.test(ua) || (/Macintosh/.test(ua) && navigator.maxTouchPoints > 1)) return "ipad";
  return null;
}

/** Opened from the home-screen icon rather than a browser tab. */
export function isHomeScreenApp(): boolean {
  if (typeof window === "undefined") return false;
  return (navigator as Navigator & { standalone?: boolean }).standalone === true || window.matchMedia?.("(display-mode: standalone)").matches === true;
}

/** Could add the site to the home screen and hasn't: on an iPhone or iPad, in a browser tab. */
export function canAddToHomeScreen(): boolean {
  return appleDevice() !== null && !isHomeScreenApp();
}

/** Opens the how-to popup (it's mounted in the app shell). */
export function openHomeScreenHelp() {
  window.dispatchEvent(new Event(OPEN_EVENT));
}

function snoozed(): boolean {
  try {
    return Number(localStorage.getItem(SNOOZE_KEY) ?? 0) > Date.now();
  } catch {
    return false;
  }
}

function snooze() {
  try {
    localStorage.setItem(SNOOZE_KEY, String(Date.now() + SNOOZE_MS));
  } catch {
    // storage blocked: it asks again next time
  }
}

/** Once it has opened by itself in this visit to the app, it doesn't again. */
let shown = false;

export function HomeScreenPrompt({ enabled }: { enabled: boolean }) {
  const { user } = useAuth();
  const tour = useTour();
  const [open, setOpen] = useState(false);
  const device = appleDevice();

  // Profile → Offline → "Add to Home Screen".
  useEffect(() => {
    const show = () => setOpen(true);
    window.addEventListener(OPEN_EVENT, show);
    return () => window.removeEventListener(OPEN_EVENT, show);
  }, []);

  useEffect(() => {
    if (shown || !enabled || !user || tour.active || !canAddToHomeScreen() || snoozed() || window.self !== window.top) return;
    // Let the screen draw, and the welcome tour start first if it's going to; this waits for it to end.
    const t = window.setTimeout(() => {
      shown = true;
      setOpen(true);
    }, 2500);
    return () => window.clearTimeout(t);
  }, [enabled, user, tour.active]);

  if (!device) return null;

  const close = () => {
    if (canAddToHomeScreen()) snooze();
    setOpen(false);
  };

  return (
    <ResponsiveDialog
      open={open}
      onOpenChange={(o) => (o ? setOpen(true) : close())}
      title="Add to your Home Screen"
      footer={
        <Button variant="secondary" onClick={close}>
          Not now
        </Button>
      }
    >
      <p className="text-[14px] leading-relaxed text-ink">
        Lantern Forms works best as an app on your {device === "ipad" ? "iPad" : "iPhone"}: it opens full screen, and forms you fill in
        without internet are kept safe until they upload.
      </p>

      <ol className="mt-5 space-y-3">
        {device === "ipad" ? (
          <Step n={1} icon={<Share className="h-[18px] w-[18px]" />}>
            Tap <b>Share</b> at the top right of the screen.
          </Step>
        ) : (
          <Step n={1} icon={<Share className="h-[18px] w-[18px]" />}>
            Tap <b>Share</b>. On newer iPhones it's inside the <Ellipsis className="inline h-4 w-4 align-[-3px]" aria-label="More" /> button at the
            bottom of the screen.
          </Step>
        )}
        <Step n={2} icon={<ChevronDown className="h-[18px] w-[18px]" />}>
          Tap <b>View More</b>, if you don't see the next step's button.
        </Step>
        <Step n={3} icon={<SquarePlus className="h-[18px] w-[18px]" />}>
          Tap <b>Add to Home Screen</b>, then <b>Add</b>.
        </Step>
      </ol>

      <p className="mt-5 rounded-input bg-appbg px-3.5 py-3 text-[13px] leading-relaxed text-muted">
        From now on, open Lantern Forms from its new icon on your Home Screen. You'll sign in once more the first time. No Share button? Open
        this page in Safari first.
      </p>
    </ResponsiveDialog>
  );
}

function Step({ n, icon, children }: { n: number; icon: React.ReactNode; children: React.ReactNode }) {
  return (
    <li className="flex items-start gap-3">
      <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-appbg text-accent dark:text-white" aria-hidden>
        {icon}
      </span>
      <p className="pt-2 text-[14px] leading-snug text-ink">
        <span className="sr-only">Step {n}: </span>
        {children}
      </p>
    </li>
  );
}
