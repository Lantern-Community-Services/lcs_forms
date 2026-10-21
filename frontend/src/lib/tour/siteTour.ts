import { ADMIN_AREA, isSiteSettingsOnly } from "@/lib/auth";
import type { DeviceKind } from "@/lib/device";
import type { PermissionKey, User } from "@/lib/types";
import type { TourDef, TourStep } from "./types";

/**
 * The welcome tour: the site, the first time someone signs in, shown for what
 * they can do (their role's permissions, whether they have sites) and on the
 * device they're using (the sidebar on a computer, the dock on a phone or an
 * iPad). It runs once per kind of device — someone who took it on a computer
 * gets the dock version the first time they use their phone.
 *
 * Every step points at a data-tour="…" anchor in the shell or a screen. One
 * that isn't on screen (a form-less catalog, a role without Admin) is passed over.
 *
 * Raise SITE_TOUR_VERSION when the tour changes enough to show everyone again.
 */
export const SITE_TOUR_VERSION = 1;

export const siteTourKey = (device: DeviceKind) => (device === "desktop" ? "site:desktop" : "site:touch");

const at = (name: string) => ({ in: "page" as const, selector: `[data-tour="${name}"]` });

/** "a Site Manager", "an Admin", "Site Staff". */
const withArticle = (role: string) => (/staff$/i.test(role) ? role : `${/^[aeiou]/i.test(role) ? "an" : "a"} ${role}`);

function list(items: string[]) {
  return items.length <= 1 ? items.join("") : `${items.slice(0, -1).join(", ")} and ${items[items.length - 1]}`;
}

export function buildSiteTour(
  { user, can, device }: { user: User; can: (p: PermissionKey) => boolean; device: DeviceKind },
  opts: { record: boolean }
): TourDef {
  const touch = device !== "desktop";
  const tap = touch ? "Tap" : "Click";
  const first = user.name.split(" ")[0];
  const roster = can("roster.view");
  const noSites = !user.allSites && user.sites.length === 0;
  const calendarEdit = can("calendar.manage") || can("calendar.edit");
  const steps: TourStep[] = [];
  const add = (s: Omit<TourStep, "id"> & { id: string }) => steps.push(s);

  add({
    id: "welcome",
    title: `Welcome to Lantern Forms${first ? `, ${first}` : ""}`,
    body:
      `This is where Lantern's forms${roster ? ", the residents' roster" : ""} and the calendar live. Here's a quick look around, ` +
      `shown for what you can do as ${withArticle(user.role?.name ?? "member of staff")}.\n\nIt takes about a minute. Skip it if you like: it's on your Profile whenever you want it.`,
  });

  if (!touch) {
    add({
      id: "sidebar",
      target: at("nav"),
      placement: "right",
      title: "Everything is in the sidebar",
      body: `Home, ${roster ? "the Roster, " : ""}the Calendar and every form you can use, in groups. Press **Ctrl K** to find a form by name.`,
    });
  } else {
    add({
      id: "dock",
      target: at("dock"),
      placement: "top",
      title: "Everything is down here",
      body: `Home, ${roster ? "the Roster, " : ""}the Calendar and the forms you pin. **All forms** opens every form, like the apps on a home screen.`,
    });
  }

  add({
    id: "forms",
    route: "/forms",
    target: at("home-forms"),
    title: "Your forms",
    body:
      device === "phone"
        ? "Every form you can fill in, in groups. Tap a group to see its forms, or search at the top."
        : "Every form you can fill in. Pick a group, or type in the search box. A form that opens on another site is marked with an arrow.",
  });

  add({
    id: "pin",
    route: "/forms",
    target: at("pin"),
    placement: "left",
    // No forms in the catalog yet: no pins, and nothing to wait for.
    waitMs: 2500,
    title: "Pin the ones you use",
    body: `${tap} the pin on a form to keep it at the top of Home${touch ? " and in the dock" : " and the sidebar"}, on every device you sign in on.`,
  });

  if (!touch || device === "tablet") {
    add({
      id: "attention",
      route: "/forms",
      target: at("home-attention"),
      title: "Needs your attention",
      body: roster
        ? "Residents due for a review, and anything a form flags for you, show up here. When it's empty, you're caught up."
        : "Anything a form flags for you shows up here. When it's empty, you're caught up.",
    });
  }

  add({
    id: "open-calendar",
    target: at(touch ? "dock-calendar" : "nav-calendar"),
    action: "click",
    title: "Open the Calendar",
    body: `${tap} **Calendar**.`,
  });
  add({
    id: "calendar",
    route: "/calendar",
    target: at(calendarEdit ? "calendar-header" : "calendar-views"),
    title: "The calendar",
    body:
      `${user.allSites ? "Events across Lantern, for every site or for chosen ones" : "Events for every site, and for yours"}. Switch between ${touch && device === "phone" ? "Month, Day and List" : "Month, Week, Day and List"}` +
      `${touch ? "" : "; ← and → move through the weeks"}. **Outlook** puts them in your own Outlook calendar.` +
      (calendarEdit ? `\n\nYou can add events${can("calendar.manage") ? "" : " for your sites"}: **New event**, or ${tap.toLowerCase()} a day.` : ""),
  });

  if (roster) {
    add({
      id: "open-roster",
      target: at(touch ? "dock-roster" : "nav-roster"),
      action: "click",
      title: "Open the Roster",
      body: `${tap} **Roster**.`,
    });
    add({
      id: "roster",
      route: "/roster",
      target: at("section-tabs"),
      title: "The roster",
      body: noSites
        ? "Residents at your sites. You aren't assigned to a site yet, so it's empty for now: ask your Site Manager, and your residents will show up here."
        : `Residents at ${user.allSites ? "every site" : "your sites"}. **Review** lists people nobody has seen in a while: ${tap.toLowerCase()} **Keep** for anyone still here.` +
          `${can("roster.edit") ? " Add, update or remove residents under **Residents**." : ""} **Attendance** and **Activity** have their own tabs.`,
    });
  }

  if (!touch) {
    add({
      id: "notifications",
      target: at("nav-notifications"),
      placement: "right",
      title: "Notifications",
      body: "The bell tells you when something needs you: a request to approve, an entry to look at. Choose on your Profile what also comes by email.",
    });
    add({
      id: "profile",
      target: at("nav-profile"),
      placement: "right",
      title: "Your profile",
      body: `Choose the page you land on${roster ? ", your default site" : ""}, light or dark, and how notifications reach you. **Take the tour** is there too.`,
    });
    const admin = ADMIN_AREA.some(can);
    if (admin && isSiteSettingsOnly(can)) {
      // A Site Manager's corner of Admin, named Site settings in the sidebar.
      add({
        id: "admin",
        target: at("nav-admin"),
        placement: "right",
        title: "Site settings",
        body: "When someone asks to work at one of your sites, approve them here, and change what the people at your sites can do.",
      });
    } else if (admin) {
      const areas = [
        can("forms.manage") && "the form builder and the Forms catalog",
        can("apps.develop") && "code forms",
        (can("users.manage") || can("users.manageSite")) && "people and roles",
        can("sites.manage") && "sites",
        (can("settings.manage") || can("sites.manageRules")) && "settings",
        can("integrations.manage") && "API keys and integrations",
        can("devlog.view") && "the dev log",
      ].filter((a): a is string => Boolean(a));
      add({
        id: "admin",
        target: at("nav-admin"),
        placement: "right",
        title: "Admin",
        body: `Where you manage ${list(areas.slice(0, 4))}${areas.length > 4 ? ", and more" : ""}. Admin works on a computer only.`,
      });
    }
  } else {
    add({
      id: "account",
      target: at("dock-account"),
      placement: "top",
      title: "You, notifications and settings",
      body: "Tap your picture for notifications, your profile and settings, and to sign out.",
    });
    add({
      id: "offline",
      title: "Works without Wi-Fi",
      body: "No signal? Keep going. Forms you fill in are kept on this device and upload by themselves when the connection is back.\n\nTo refresh a screen, pull it down from the top.",
    });
  }

  add({
    id: "done",
    route: "/forms",
    title: "You're all set",
    body: "Open a form from Home to get started. The first time you open a form that has a tutorial, it shows you how that form works.\n\nTake this tour again any time from your **Profile**.",
  });

  return { key: siteTourKey(device), version: SITE_TOUR_VERSION, title: "Welcome tour", steps, record: opts.record, waitMs: 5000 };
}
