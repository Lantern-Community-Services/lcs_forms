import { useEffect } from "react";
import { useLocation, useNavigate } from "react-router-dom";
import { useAuth } from "@/lib/auth";
import { currentDeviceKind } from "@/lib/device";
import { useTour } from "./TourProvider";
import { seenVersion, useTutorialProgress } from "./progress";
import { buildSiteTour, siteTourKey, SITE_TOUR_VERSION } from "./siteTour";

/**
 * Starts the welcome tour (siteTour.ts) by itself for someone who hasn't
 * finished or skipped it on this kind of device — once they're on their home
 * screen, so a shared link to a form opens the form, not a tour. Admin →
 * Sign-in access can turn that off. /home?tour=site runs it whatever they've
 * seen (Profile → Take the tour), without recording it.
 *
 * Not inside a preview frame (the editors' device previews load the whole app).
 */
/** Once it has run in this visit to the app (by itself or from Profile), it doesn't start by itself again. */
let ran = false;

export function SiteTourStarter() {
  const { user, can } = useAuth();
  const tour = useTour();
  const { data, isSuccess } = useTutorialProgress(user?.id ?? null);
  const { pathname, search } = useLocation();
  const navigate = useNavigate();
  const forced = new URLSearchParams(search).get("tour") === "site";

  useEffect(() => {
    if (!user || tour.active) return;
    const device = currentDeviceKind();
    if (forced) {
      // Started before the address is tidied: tidying it re-runs this effect, and would cancel a start still waiting.
      ran = tour.start(buildSiteTour({ user, can, device }, { record: false })) || ran;
      const q = new URLSearchParams(search);
      q.delete("tour");
      navigate({ pathname, search: q.toString() }, { replace: true });
      return;
    }
    if (ran || !isSuccess || !data.welcomeTour || window.self !== window.top) return;
    // Home, or the landing page they chose ("/forms" is Home's old address).
    const landing = user.defaultLandingPage && user.defaultLandingPage !== "/forms" ? user.defaultLandingPage : "/home";
    if (pathname !== "/home" && pathname !== landing) return;
    if (seenVersion(data, user.id, siteTourKey(device)) >= SITE_TOUR_VERSION) return;
    // Let the home screen draw first.
    const t = window.setTimeout(() => (ran = tour.start(buildSiteTour({ user, can, device }, { record: true })) || ran), 900);
    return () => window.clearTimeout(t);
  }, [user, isSuccess, data, pathname, forced, tour.active]); // eslint-disable-line react-hooks/exhaustive-deps

  return null;
}
