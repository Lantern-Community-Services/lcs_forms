import type { PermissionKey } from "@/lib/types";

/**
 * The help (/help): a guide for each role and an article for each feature,
 * written with the site so it changes when a feature does. Each piece says
 * who it's for (any of `needs`, or everyone signed in), so people only see
 * help for what they can use. "Go there" buttons only show for screens the
 * reader can open. Page "?" icons (components/PageHelp.tsx) link here by id.
 *
 * Keep it plain: what it's for, where it is, what to do, and what to know.
 * No resident details in examples.
 */

export type HelpArea = "start" | "forms" | "roster" | "calendar" | "admin";

export const AREAS: { id: HelpArea; title: string }[] = [
  { id: "start", title: "Getting started" },
  { id: "forms", title: "Forms and entries" },
  { id: "roster", title: "Roster and attendance" },
  { id: "calendar", title: "Calendar" },
  { id: "admin", title: "Admin" },
];

export interface HelpLinkTo {
  label: string;
  to: string;
  /** Only shown to people with any of these. */
  needs?: PermissionKey[];
}

export interface HelpArticle {
  id: string;
  area: HelpArea;
  title: string;
  /** One line: what it's for. */
  summary: string;
  /** Who it's for: anyone with one of these (empty: everyone signed in). */
  needs?: PermissionKey[];
  /** Screens it's about, as buttons. */
  where: HelpLinkTo[];
  sections: { heading: string; points: string[] }[];
  /** "Show me": runs the welcome tour. */
  showMe?: boolean;
  /** Extra words for search. */
  words?: string;
}

export const ARTICLES: HelpArticle[] = [
  // ── Getting started ────────────────────────────────────────────────────
  {
    id: "getting-around",
    area: "start",
    title: "Getting around Lantern Forms",
    summary: "Home, the menu, search, notifications and your profile.",
    where: [
      { label: "Home", to: "/home" },
      { label: "Profile & settings", to: "/profile" },
    ],
    showMe: true,
    words: "start begin menu sidebar dock navigation search tour home",
    sections: [
      {
        heading: "Where things are",
        points: [
          "On a computer, everything is in the menu on the left. On a phone or iPad it's the bar at the bottom: More holds the rest.",
          "Home shows what needs you today. Forms lists every form you can fill in.",
          "Search (top of the menu, or Ctrl K) finds screens and forms, and residents if you can see the roster.",
          "The bell is your notifications. Your name, at the bottom, is your profile and settings.",
        ],
      },
      {
        heading: "What you see depends on you",
        points: [
          "You only see the sites you've been approved for, and the forms that are open to you. Admins see everything.",
          "If something you need is missing, ask your Site Manager or an Admin to give you access.",
        ],
      },
      {
        heading: "The tour",
        points: ["“Show me” below walks you around the screen you're on. You can run it again any time from Profile → Take the tour."],
      },
    ],
  },
  {
    id: "your-notifications",
    area: "start",
    title: "Your notifications",
    summary: "What the bell tells you, urgent ones, and choosing what's emailed to you.",
    where: [
      { label: "Notifications", to: "/notifications" },
      { label: "Choose what you're told", to: "/profile#notifications" },
    ],
    words: "bell alerts email urgent daily summary digest",
    sections: [
      {
        heading: "The bell",
        points: [
          "Forms tell you about entries you need to know about, follow-ups waiting on you, and changes to your access.",
          "Opening one marks it read and takes you to what it's about.",
          "Urgent ones are red and stay at the top until you've read them. They're emailed straight away.",
        ],
      },
      {
        heading: "Choosing what reaches you",
        points: [
          "Profile → Notifications: for each kind, in the app and/or by email, and email as it happens, once each morning, or never.",
          "You can also choose form by form, or turn a form off.",
          "“Send me a test” checks it reaches you.",
        ],
      },
      {
        heading: "What's in an email",
        points: ["Emails say what happened and what to do. Answers only go to Lantern addresses, and resident details never go in an email: sign in to see them."],
      },
    ],
  },

  // ── Forms ──────────────────────────────────────────────────────────────
  {
    id: "filling-forms",
    area: "forms",
    title: "Filling in a form",
    summary: "Finding a form, filling it in, offline, and handing a device to a resident.",
    where: [{ label: "Forms", to: "/forms" }],
    words: "fill submit form catalog pin offline draft lock hide nav bar dock resident tutorial show me how",
    sections: [
      {
        heading: "Finding it",
        points: [
          "Forms lists every form open to you, by category. Search finds one by name.",
          "Pin the ones you use most: they show in the menu.",
        ],
      },
      {
        heading: "Filling it in",
        points: [
          "Required questions have a *. If something's missing, the form tells you before it sends.",
          "Your answers are kept on the device as you go, so a reload or a dropped connection doesn't lose them.",
          "No connection? Submit anyway: it's saved on the device and sends itself when you're back online.",
          "Some forms have “Show me how”, a walk through the form.",
        ],
      },
      {
        heading: "Handing a device to a resident",
        points: ["Use “Hide nav bar” on the form first (“Hide dock” on a phone or iPad): only the form stays open, none of your screens."],
      },
    ],
  },
  {
    id: "entries",
    area: "forms",
    title: "Entries",
    summary: "Finding what was filed, who sees what, and exporting.",
    where: [{ label: "Forms", to: "/forms" }],
    words: "entries submissions responses export spreadsheet void star",
    sections: [
      {
        heading: "Where they are",
        points: [
          "On a form, “Your entries” (or “Entries”) lists what's been filed. Each one opens on its own page.",
          "Search, filter by date, star the ones to come back to, and export to a spreadsheet.",
        ],
      },
      {
        heading: "Who sees which entries",
        points: [
          "By default you see your own entries, the ones you're told about, and any that came through your share link.",
          "Some forms let you see every entry at your sites, or every entry. The form says which (“Your entries” or “Entries”).",
          "Admins, and the IT group, see every entry.",
        ],
      },
      {
        heading: "Mistakes",
        points: ["An entry filed by mistake can be voided by an Admin, with a reason. It's kept, marked void, so nothing is lost."],
      },
    ],
  },
  {
    id: "follow-ups",
    area: "forms",
    title: "Follow-ups",
    summary: "Entries that stay open until someone marks them done.",
    where: [{ label: "Notifications", to: "/notifications" }],
    words: "follow up done open reminder task request hr it",
    sections: [
      {
        heading: "How they work",
        points: [
          "On some forms (HR requests, say), each entry stays open until the people it's for mark it done, saying what they did.",
          "If it's for you, you're told, and reminded until it's done. Open the entry and use “Mark as done”.",
          "Whoever filed it is told when it's done, with your note.",
        ],
      },
      {
        heading: "Finding them",
        points: ["On a form's entries, filter by Open to see what's still waiting. Open ones have an amber badge."],
      },
    ],
  },
  {
    id: "share-links",
    area: "forms",
    title: "Sharing a form by link or QR code",
    summary: "Your own link and QR code for forms people outside Lantern fill in.",
    where: [{ label: "Forms", to: "/forms" }],
    words: "share link qr code external public art submissions refresh expire",
    sections: [
      {
        heading: "Your link",
        points: [
          "Some forms (like art submissions) are filled in by people outside Lantern. On those, “Share it” gives you your own link and QR code.",
          "Send the link, or show the QR code on your phone or print it. Anyone with it can fill the form in without an account.",
          "What they send comes to Lantern, and you can see every entry that came through your link.",
        ],
      },
      {
        heading: "Keeping it safe",
        points: [
          "Your link ends after the time you picked (90 days unless you choose otherwise).",
          "Shared it somewhere you shouldn't have? Refresh it: you get a new link and QR code, and the old ones stop working straight away.",
          "If you leave Lantern or lose access to the form, your link stops working.",
        ],
      },
    ],
  },

  // ── Roster ─────────────────────────────────────────────────────────────
  {
    id: "roster",
    area: "roster",
    title: "The roster",
    summary: "Residents at your sites, the review queue and activity.",
    needs: ["roster.view"],
    where: [
      { label: "Residents", to: "/roster", needs: ["roster.view"] },
      { label: "Review", to: "/roster/review", needs: ["roster.view"] },
      { label: "Activity", to: "/roster/activity", needs: ["roster.view"] },
    ],
    words: "residents tenants roster review queue activity overview acuity",
    sections: [
      {
        heading: "What it is",
        points: [
          "The residents at the sites you're approved for. Search by name or unit, and open someone to see their details and history.",
          "Overview shows the numbers across your sites.",
        ],
      },
      {
        heading: "Review",
        points: [
          "Review lists residents nobody has recorded anything for in a while, so the roster stays right.",
          "If you manage the roster, mark each one still here (Keep) or no longer here (Remove). A removed resident can be restored.",
        ],
      },
      {
        heading: "Managing it",
        points: [
          "Site Managers manage the roster: adding and changing residents, Review, attendance and restoring. A Site Manager or Admin can give anyone else that too.",
          "Activity shows what's been recorded, newest first.",
        ],
      },
    ],
  },
  {
    id: "attendance",
    area: "roster",
    title: "Attendance",
    summary: "Taking attendance for a group or event.",
    needs: ["roster.view"],
    where: [{ label: "Attendance", to: "/roster/attendance", needs: ["roster.view"] }],
    words: "attendance roll call group event sign in",
    sections: [
      {
        heading: "Taking it",
        points: [
          "Attendance lists the sessions taken at your sites. People who manage the roster take new ones: pick the residents who came, then save.",
        ],
      },
    ],
  },

  // ── Calendar ───────────────────────────────────────────────────────────
  {
    id: "calendar",
    area: "calendar",
    title: "The calendar",
    summary: "Events for every site or for yours.",
    where: [{ label: "Calendar", to: "/calendar" }],
    words: "calendar events schedule outlook",
    sections: [
      {
        heading: "What you see",
        points: ["Events for every site, and for the sites you work at. Open one for its details."],
      },
      {
        heading: "Adding events",
        points: [
          "Admins add events for any site. Anyone an Admin lets edit the calendar adds events for their own sites.",
          "Need something added? Ask an Admin.",
          "Events can go to your Outlook calendar: on the Calendar, “Add to my Outlook”.",
        ],
      },
    ],
  },

  // ── Admin ──────────────────────────────────────────────────────────────
  {
    id: "admin-forms",
    area: "admin",
    title: "Building forms",
    summary: "The form builder, publishing, and the Forms catalog.",
    needs: ["forms.manage"],
    where: [
      { label: "Form builder", to: "/admin/builder", needs: ["forms.manage"] },
      { label: "Forms catalog", to: "/admin/forms", needs: ["forms.manage"] },
      { label: "AI form builder", to: "/admin/ai", needs: ["forms.manage"] },
    ],
    words: "builder build form publish draft version catalog category card ai",
    sections: [
      {
        heading: "The form builder",
        points: [
          "Build: add questions, rules and pages. The preview beside it shows the form on a phone, iPad or computer.",
          "Settings: who can fill it in, who sees its entries, limits and dates. Notifications: who's told (see Notifications).",
          "Changes are a draft until you Publish. Versions keeps every published version, and you can go back to one.",
        ],
      },
      {
        heading: "Who can fill it in",
        points: [
          "Anyone signed in, some roles, public (anyone with the address), or anyone with a share link (each employee has their own link and QR code).",
          "Public and share-link forms can't use Site or Resident questions.",
        ],
      },
      {
        heading: "The Forms catalog",
        points: [
          "What staff see on the Forms screen: categories, and a card for each form. Edit on a form built here opens its editor; other cards have their own page.",
          "A category or form can be limited to some groups, positions or people.",
        ],
      },
    ],
  },
  {
    id: "admin-code-forms",
    area: "admin",
    title: "Code forms",
    summary: "Forms with their own screens, rules and dashboards.",
    needs: ["apps.develop"],
    where: [{ label: "Code forms", to: "/admin/apps", needs: ["apps.develop", "forms.manage"] }],
    words: "code forms apps developer react server dashboard",
    sections: [
      {
        heading: "What they are",
        points: [
          "A code form is a small project: its own pages, server code and form.json, for what a basic form can't do (custom screens, offline work, dashboards).",
          "The editor shows the pages beside a live preview. Publish when it's ready; everyone gets it on their next visit.",
          "Its Settings sets its card, who sees its entries, and links to its Notifications.",
        ],
      },
    ],
  },
  {
    id: "admin-notifications",
    area: "admin",
    title: "Notifications and email",
    summary: "Who each form tells, email templates, the site's own emails and every email sent.",
    needs: ["forms.manage"],
    where: [
      { label: "Notifications", to: "/admin/notifications", needs: ["forms.manage"] },
      { label: "Templates", to: "/admin/notifications/templates", needs: ["forms.manage"] },
      { label: "Sent emails", to: "/admin/notifications/sent", needs: ["forms.manage"] },
    ],
    words: "routing routes notify email template system emails look sent follow-up weekly report",
    sections: [
      {
        heading: "Who a form tells",
        points: [
          "Each form's routes say who's told about what: named people, a role, a group, a position, whoever filed it, or whoever shared the link. Optionally only at some sites or when answers match.",
          "It's in Admin → Notifications → Forms, and on the form's own Notifications tab: the same thing.",
          "A route can be urgent, and chooses which answers go in the email (Lantern addresses only).",
        ],
      },
      {
        heading: "Templates",
        points: [
          "A route or weekly report picks a template for its wording, or keeps its own. Changing a template changes every email that uses it.",
          "Super Admins make and change templates, the site's own emails (System emails) and how emails look (Look). Admins pick from them.",
        ],
      },
      {
        heading: "Follow-up and weekly reports",
        points: [
          "Follow-up keeps entries open until marked done, with reminders.",
          "A weekly report emails the past week's entries on a day and time.",
          "Sent emails lists every email the site sent, and whether it went.",
        ],
      },
    ],
  },
  {
    id: "admin-people",
    area: "admin",
    title: "People, roles and access",
    summary: "Approving people, roles, sites, groups and switches.",
    needs: ["users.manage", "users.manageSite"],
    where: [
      { label: "People & roles", to: "/admin/people", needs: ["users.manage", "users.manageSite"] },
      { label: "Groups", to: "/admin/groups", needs: ["users.manage"] },
    ],
    words: "people users roles approve request access sites groups positions switches admin super admin",
    sections: [
      {
        heading: "Letting people in",
        points: [
          "Someone new signs in with their Lantern account and presses Request access. Admins are told, and the request shows in People & roles: approve it with their role and sites, or decline it.",
          "Only Admins let new people in, choosing their role and sites. Site Managers look after the people at their own sites, and approve them for more of those sites (Site settings).",
        ],
      },
      {
        heading: "Roles",
        points: [
          "Site Staff: fills in and reads forms, looks up residents, at their sites. Site Manager: also manages the roster and the people at their sites.",
          "Main Office Staff: like Site Staff, at the sites they're approved for. Developer: builds code forms.",
          "Admin: everything, every site. Super Admin: an Admin who also makes Admins, reads person records and owns email templates.",
          "Switches add to a role for one person: “Can manage the roster” and “Can edit the calendar”.",
        ],
      },
      {
        heading: "Groups and positions",
        points: [
          "Groups (HR, IT…) gather people by job title or by hand. Forms, categories and routes can be limited to groups or positions.",
          "Members of the IT group see every form and entry.",
        ],
      },
    ],
  },
  {
    id: "admin-records",
    area: "admin",
    title: "A person's records",
    summary: "Everything one person filed, was told and did.",
    needs: ["people.records"],
    where: [{ label: "People & roles", to: "/admin/people", needs: ["people.records"] }],
    words: "records person history audit super admin",
    sections: [
      {
        heading: "What's there",
        points: [
          "In People & roles, Records on a person: the entries they filed, follow-ups they did and ones waiting on them, their notifications and emails, what they changed, and which forms they can open.",
          "Super Admins only. It changes nothing.",
        ],
      },
    ],
  },
  {
    id: "admin-sites",
    area: "admin",
    title: "Sites and settings",
    summary: "Sites, roster rules, sign-in access and the tenant import.",
    needs: ["sites.manage", "settings.manage", "sites.manageRules"],
    where: [
      { label: "Sites", to: "/admin/sites", needs: ["sites.manage"] },
      { label: "Roster rules", to: "/admin/settings", needs: ["settings.manage", "sites.manageRules"] },
      { label: "Sign-in access", to: "/admin/sign-in", needs: ["settings.manage"] },
    ],
    words: "sites settings roster rules review hours sign in domains import tenants",
    sections: [
      {
        heading: "What's here",
        points: [
          "Sites: add and change sites, and turn them off.",
          "Roster rules: how long before a resident shows in Review, for everyone or per site.",
          "Sign-in access: which other email domains may sign in, and whether the welcome tour starts by itself.",
          "Import tenant list: bring in a property-management export.",
        ],
      },
    ],
  },
  {
    id: "admin-integrations",
    area: "admin",
    title: "Integrations and the AI assistant",
    summary: "API keys, Claude (MCP), webhooks and WordPress.",
    needs: ["integrations.manage"],
    where: [
      { label: "API keys", to: "/admin/api-keys", needs: ["integrations.manage"] },
      { label: "Webhooks", to: "/admin/webhooks", needs: ["integrations.manage"] },
    ],
    words: "api keys mcp claude ai webhook wordpress power automate integration",
    sections: [
      {
        heading: "What's here",
        points: [
          "API keys let another system, or Claude through the MCP, work with the site. A key only does what its scopes allow, and never more than the person who made it can.",
          "Treat a key like a password: never paste it in a chat or a file. Revoke one you think has been seen.",
          "Webhooks send events to another system as they happen.",
        ],
      },
    ],
  },
];

export type RoleGuideKey = "site_staff" | "site_manager" | "main_office" | "developer" | "admin" | "super_admin";

export interface RoleGuide {
  key: RoleGuideKey;
  name: string;
  intro: string;
  can: string[];
  startHere: HelpLinkTo[];
  /** Articles to read first, in order. */
  read: string[];
}

export const ROLE_GUIDES: RoleGuide[] = [
  {
    key: "site_staff",
    name: "Site Staff",
    intro: "You fill in forms and look up residents at your sites.",
    can: [
      "Fill in the forms open to you, even offline.",
      "See your own entries, and the ones you're told about.",
      "Look up residents at your sites.",
      "Share forms meant for people outside Lantern, with your own link and QR code.",
      "Mark follow-ups done when they're for you.",
    ],
    startHere: [
      { label: "Forms", to: "/forms" },
      { label: "Roster", to: "/roster", needs: ["roster.view"] },
      { label: "Notifications", to: "/notifications" },
    ],
    read: ["getting-around", "filling-forms", "entries", "your-notifications", "roster"],
  },
  {
    key: "site_manager",
    name: "Site Manager",
    intro: "Everything Site Staff do, plus managing the roster and the people at your sites.",
    can: [
      "Everything Site Staff can.",
      "Manage the roster: add and change residents, work through Review, take attendance, restore removed residents.",
      "Look after the people at your sites, and approve them for more of your sites (Site settings). Only Admins let new people in.",
    ],
    startHere: [
      { label: "Roster", to: "/roster", needs: ["roster.view"] },
      { label: "Review", to: "/roster/review", needs: ["roster.view"] },
      { label: "Site settings", to: "/admin/people", needs: ["users.manageSite", "users.manage"] },
    ],
    read: ["roster", "attendance", "admin-people", "filling-forms", "entries"],
  },
  {
    key: "main_office",
    name: "Main Office Staff",
    intro: "You fill in and read forms, and look up residents, at the sites you're approved for.",
    can: ["Fill in the forms open to you.", "See your own entries, and the ones you're told about.", "Look up residents at your sites.", "Mark follow-ups done when they're for you."],
    startHere: [
      { label: "Forms", to: "/forms" },
      { label: "Notifications", to: "/notifications" },
    ],
    read: ["getting-around", "filling-forms", "entries", "follow-ups", "your-notifications"],
  },
  {
    key: "developer",
    name: "Developer",
    intro: "You build code forms and read their entries. You see rosters only at the sites you're assigned.",
    can: ["Build and publish code forms.", "Read entries.", "Look up residents at your assigned sites, to test with real data."],
    startHere: [{ label: "Code forms", to: "/admin/apps", needs: ["apps.develop"] }],
    read: ["admin-code-forms", "entries", "getting-around"],
  },
  {
    key: "admin",
    name: "Admin",
    intro: "You run the site: forms, notifications, people, sites and settings, on every site.",
    can: [
      "Build forms and decide who can fill them in and who sees their entries.",
      "Set who each form tells, follow-ups and weekly reports.",
      "Let people in, give roles and sites, and manage groups.",
      "Manage sites, roster rules, sign-in access and integrations.",
      "See every entry, and void one filed by mistake.",
    ],
    startHere: [
      { label: "Admin", to: "/admin", needs: ["forms.manage"] },
      { label: "Form builder", to: "/admin/builder", needs: ["forms.manage"] },
      { label: "Notifications", to: "/admin/notifications", needs: ["forms.manage"] },
      { label: "People & roles", to: "/admin/people", needs: ["users.manage"] },
    ],
    read: ["admin-forms", "admin-notifications", "admin-people", "admin-sites", "admin-integrations"],
  },
  {
    key: "super_admin",
    name: "Super Admin",
    intro: "An Admin who also makes Admins, reads a person's records, and owns the organization's email templates.",
    can: [
      "Everything an Admin can.",
      "Make someone an Admin, or change or remove one.",
      "Read a person's records: what they filed, were told and did.",
      "Make and change email templates, the site's own emails and how emails look.",
      "Choose which groups see every form and entry (IT by default).",
    ],
    startHere: [
      { label: "Templates", to: "/admin/notifications/templates", needs: ["email.templates", "forms.manage"] },
      { label: "People & roles", to: "/admin/people", needs: ["users.manage"] },
      { label: "Groups", to: "/admin/groups", needs: ["users.manage"] },
    ],
    read: ["admin-notifications", "admin-records", "admin-people", "admin-forms", "admin-integrations"],
  },
];

/** The guide for this person: Super Admin if they are one, else their role's. */
export function guideFor(user: { roleKey: string; globalAdmin?: boolean } | null | undefined): RoleGuide {
  const key: RoleGuideKey = user?.globalAdmin ? "super_admin" : ((ROLE_GUIDES.find((g) => g.key === user?.roleKey)?.key ?? "site_staff") as RoleGuideKey);
  return ROLE_GUIDES.find((g) => g.key === key)!;
}

export const articleById = (id: string) => ARTICLES.find((a) => a.id === id);

/** Whether this person may read it / go there. */
export const allowed = (needs: PermissionKey[] | undefined, can: (p: PermissionKey) => boolean) => !needs?.length || needs.some(can);
