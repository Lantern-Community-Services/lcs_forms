// GENERATED from backend/src/apps/sdk.d.ts by `npm run sync:engine` (backend). Do not edit here.
/**
 * Lantern code forms — the SDK.
 *
 * A code form is a small project: pages (React, run in a sandboxed frame in
 * the browser), optional server code (run in a sandbox on the server), styles
 * and a manifest (form.json). These are the modules its code can import.
 * Nothing else is importable: pages reach data only through @lcs/sdk, always
 * as the person using the form and within their permissions.
 *
 *   react, react/jsx-runtime      React 19
 *   @lcs/sdk                      data, the person, navigation, offline queue
 *   @lcs/ui                       the app's own components (identical look)
 *   @lcs/charts                   the app's chart components
 *   lucide-react                  icons
 *   @lcs/server                   (server/*.ts only) hooks, actions, the database
 *
 * Styling: Tailwind classes with the app's tokens (bg-surface, text-ink,
 * text-muted, border-hairline, bg-navy, rounded-card, …) work in any page, plus
 * styles.css. Dark mode and the person's theme follow the app automatically.
 */

declare module "@lcs/sdk" {
  export interface User {
    id: string;
    name: string;
    email: string;
    roleKey: string;
    roleName: string;
    permissions: string[];
    /** Null = every site (admins); otherwise the site ids they're assigned. */
    siteIds: string[] | null;
  }

  export interface AppContext {
    user: User;
    form: { id: string; slug: string; title: string; version: number; draft: boolean };
    /** The page being shown (its id from form.json) and its URL parameters. */
    page: string;
    params: Record<string, string>;
    /** Pages this person can open, in tab order. */
    pages: { id: string; label: string }[];
    online: boolean;
    /** "YYYY-MM-DD" in New York, where Lantern's sites are. */
    today: string;
    /** What the form is being used on — the real window, not the frame. */
    device: Device;
  }

  /**
   * phone: a touch device with a short side under 600px, or any window under 768px.
   * tablet: any other touch device (iPads). desktop: everything else.
   * Inside a page, Tailwind's sm: md: lg: xl: and portrait: / landscape: follow this
   * window (not the frame), exactly as on the app's own screens, and there are
   * phone: tablet: desktop: variants too. form.json "views" can give a page a whole
   * different file per kind of device.
   */
  export interface Device {
    kind: "phone" | "tablet" | "desktop";
    orientation: "portrait" | "landscape";
    width: number;
    height: number;
    touch: boolean;
    /** Breakpoints the window is at or past: ["sm", "md", "lg"]. */
    breakpoints: string[];
  }

  /** The device, as a React hook (re-renders on rotate and resize). */
  export function useDevice(): Device;

  /** The context, as a React hook (re-renders on navigation / going offline). */
  export function useApp(): AppContext;

  export const app: {
    context(): Promise<AppContext>;
    /** Switch to another page of this form, with URL parameters. */
    navigate(page: string, params?: Record<string, string>): void;
    /** Change this page's URL parameters without a reload (filters, selection). */
    setParams(params: Record<string, string>): void;
    toast(message: string, tone?: "success" | "error"): void;
    /** Hand the person a file to save. Content is text, or base64 with `base64: true`. */
    download(filename: string, content: string, opts?: { mime?: string; base64?: boolean }): void;
    print(): void;
    /** Open another part of the Lantern app (e.g. "/tenants/<id>") in the main window. */
    openApp(path: string): void;
  };

  export interface Site {
    id: string;
    code: string;
    name: string;
    siteType: string;
    latitude: number | null;
    longitude: number | null;
    geofenceMeters: number | null;
  }

  export interface Resident {
    id: string;
    siteId: string;
    name: string;
    firstName: string;
    lastName: string;
    preferredName: string | null;
    unit: string | null;
  }

  export const roster: {
    /** Sites this person can use. */
    sites(): Promise<Site[]>;
    /** Active residents at a site (code). */
    residents(siteCode: string): Promise<Resident[]>;
  };

  export interface Entry<T = Record<string, unknown>> {
    id: string;
    data: T;
    site: { id: string; code: string; name: string } | null;
    tenantId: string | null;
    occurredAt: string;
    createdAt: string;
    createdById: string | null;
    createdByName: string;
    status: "active" | "voided";
    overrideReason: string | null;
    voidReason: string | null;
    voidedByName: string | null;
    voidedAt: string | null;
    source: string;
    clientId: string | null;
  }

  export interface EntryQuery {
    /** Site code(s). Omit for every site this person can see. */
    site?: string | string[];
    tenantId?: string;
    /** "YYYY-MM-DD" (New York day, inclusive) or an ISO time. */
    from?: string;
    to?: string;
    status?: "active" | "voided" | "all";
    /** Matches anywhere in the entry's data or who made it. */
    search?: string;
    /** Only entries this person made (allowed even without read access). */
    mine?: boolean;
    /** Only these top-level data fields (leave out big ones like signatures in lists). */
    fields?: string[];
    order?: "newest" | "oldest";
    limit?: number;
    offset?: number;
  }

  export interface NewEntry<T> {
    data: T;
    /** Site code. */
    site?: string;
    /** Roster id of the resident it's about (logs roster activity). */
    tenantId?: string;
    /** When it happened, ISO. Defaults to now; clamped to now. */
    occurredAt?: string;
    /** Your id for this entry, so a retry never saves twice. Made for you if omitted. */
    clientId?: string;
    /** A reason, when the server's rules said this needs an override. */
    override?: string;
  }

  export type CreateResult<T> =
    | { status: "saved"; entry: Entry<T> }
    /** offline: kept on the device; uploads when the connection is back. */
    | { status: "queued"; clientId: string }
    /** The server's rules (server/index.ts beforeCreate) want a reason: resend with `override`. */
    | { status: "needs_override"; problems: string[] }
    | { status: "invalid"; errors: Record<string, string>; message: string };

  export const entries: {
    list<T = Record<string, unknown>>(query?: EntryQuery): Promise<{ items: Entry<T>[]; total: number }>;
    get<T = Record<string, unknown>>(id: string): Promise<Entry<T>>;
    /**
     * Save an entry. With `offline: true` it's queued on the device first and
     * uploaded in the background — safe to call with no signal. If the server
     * then wants an override, `offlineOverride` is used as the reason.
     */
    create<T = Record<string, unknown>>(entry: NewEntry<T>, opts?: { offline?: boolean; offlineOverride?: string }): Promise<CreateResult<T>>;
    /** Void with a reason (roles in form.json entries.void, or your own entry within the undo window). */
    void(id: string, reason: string): Promise<void>;
    restore(id: string): Promise<void>;
  };

  export interface Doc<T = Record<string, unknown>> {
    id: string;
    data: T;
    updatedAt: string;
    updatedByName: string | null;
  }

  /** The form's own data: lists and settings (who can read/write each is in form.json). */
  export const collections: {
    list<T = Record<string, unknown>>(name: string): Promise<Doc<T>[]>;
    get<T = Record<string, unknown>>(name: string, id: string): Promise<Doc<T> | null>;
    /** Create (id omitted) or replace a document. */
    put<T = Record<string, unknown>>(name: string, id: string | null, data: T): Promise<Doc<T>>;
    remove(name: string, id: string): Promise<void>;
  };

  /** Call a server action (server/index.ts `actions`). */
  export const actions: {
    call<T = unknown>(name: string, args?: unknown): Promise<T>;
  };

  /**
   * Small values kept on this device for this person and this form — the last
   * site used, a remembered choice. (The sandboxed page has no storage of its own.)
   */
  export const local: {
    get(key: string): Promise<string | null>;
    set(key: string, value: string): Promise<void>;
    remove(key: string): Promise<void>;
  };

  export const device: {
    /** The device's position (asked for by the app on the form's behalf), or null if unavailable. */
    location(opts?: { timeoutMs?: number }): Promise<{ latitude: number; longitude: number; accuracy: number } | null>;
  };

  export interface QueueStatus {
    pending: number;
    /** clientIds still waiting on this device. */
    pendingIds: string[];
    /** Entries the server refused; they stay until someone looks. */
    failed: { clientId: string; error: string; entry: NewEntry<unknown> }[];
    online: boolean;
    syncing: boolean;
    lastSyncedAt: string | null;
  }

  /** The device's offline queue for this form. */
  export const queue: {
    status(): Promise<QueueStatus>;
    /** Called now and whenever the queue changes. Returns an unsubscribe. */
    subscribe(fn: (s: QueueStatus) => void): () => void;
    retry(): Promise<void>;
    discard(clientId: string): Promise<void>;
  };

  /** A tiny data hook: runs fn, re-runs when `deps` change or refresh() is called. */
  export function useData<T>(fn: () => Promise<T>, deps?: unknown[]): { data: T | undefined; error: Error | null; loading: boolean; refresh: () => void };

  /** Date helpers in New York time. */
  export const dates: {
    today(): string;
    addDays(day: string, n: number): string;
    /** "YYYY-MM-DD" New York day of an ISO time. */
    dayOf(iso: string): string;
    /** "HH:MM" New York time of an ISO time. */
    timeOf(iso: string): string;
    format(iso: string, style?: "date" | "datetime" | "time" | "relative"): string;
  };
}

declare module "@lcs/ui" {
  import type * as React from "react";
  type Props<T = HTMLElement> = React.HTMLAttributes<T> & { className?: string; children?: React.ReactNode };

  export const Button: React.ForwardRefExoticComponent<React.ButtonHTMLAttributes<HTMLButtonElement> & { variant?: "primary" | "secondary" | "ghost" | "danger" | "outlineDanger" | "success"; size?: "sm" | "md" | "lg" | "icon" } & React.RefAttributes<HTMLButtonElement>>;
  export function Card(props: Props<HTMLDivElement>): React.JSX.Element;
  export const Input: React.ForwardRefExoticComponent<React.InputHTMLAttributes<HTMLInputElement> & React.RefAttributes<HTMLInputElement>>;
  export function Textarea(props: React.TextareaHTMLAttributes<HTMLTextAreaElement>): React.JSX.Element;
  export function SearchInput(props: React.InputHTMLAttributes<HTMLInputElement> & { wrapperClassName?: string }): React.JSX.Element;
  export function Select(props: React.SelectHTMLAttributes<HTMLSelectElement> & { options?: { value: string; label: string }[]; placeholder?: string }): React.JSX.Element;
  export function Field(props: { label?: React.ReactNode; hint?: string; className?: string; children: React.ReactNode }): React.JSX.Element;
  export function Label(props: React.LabelHTMLAttributes<HTMLLabelElement>): React.JSX.Element;
  export function Checkbox(props: { checked?: boolean; onCheckedChange?: (v: boolean) => void; disabled?: boolean; className?: string }): React.JSX.Element;
  export function Switch(props: { checked?: boolean; onCheckedChange?: (v: boolean) => void; disabled?: boolean; className?: string }): React.JSX.Element;
  export function Chip(props: { active: boolean; onClick: () => void; className?: string; children: React.ReactNode }): React.JSX.Element;
  export function ToneBadge(props: { tone: "amber" | "blue" | "green" | "red" | "violet" | "neutral"; dot?: boolean; className?: string; children: React.ReactNode }): React.JSX.Element;
  export function Badge(props: { className?: string; style?: React.CSSProperties; children: React.ReactNode }): React.JSX.Element;
  export function Avatar(props: { name: string; color?: string | null; size?: number; className?: string }): React.JSX.Element;
  export function Spinner(props: { className?: string }): React.JSX.Element;
  export function LoadingState(props: { label?: string }): React.JSX.Element;
  export function EmptyState(props: { title: string; hint?: string; icon?: React.ReactNode }): React.JSX.Element;
  /** Standard page container and header, as on every screen of the app. */
  export function Page(props: { className?: string; children: React.ReactNode }): React.JSX.Element;
  export function PageHeader(props: { title: string; subtitle?: string; actions?: React.ReactNode }): React.JSX.Element;
  /** A modal. open/onOpenChange controlled. */
  export function Modal(props: { open: boolean; onOpenChange: (open: boolean) => void; title: string; subtitle?: string; footer?: React.ReactNode; children?: React.ReactNode; wide?: boolean }): React.JSX.Element;
  /** A bottom sheet on phones, a side sheet on wider screens. */
  export function Sheet(props: { open: boolean; onOpenChange: (open: boolean) => void; title: string; footer?: React.ReactNode; children?: React.ReactNode }): React.JSX.Element;
  export function DropdownMenu(props: { trigger: React.ReactNode; items: ({ label: string; onSelect: () => void; danger?: boolean } | "separator")[]; align?: "start" | "end" }): React.JSX.Element;
  export interface SignaturePadHandle { clear(): void; toDataURL(): string | null; isEmpty(): boolean }
  export const SignaturePad: React.ForwardRefExoticComponent<{ className?: string; onChangeEmpty?: (empty: boolean) => void } & React.RefAttributes<SignaturePadHandle>>;
  /** A row of preset date ranges plus from/to, New York days. */
  export function DateRangeBar(props: { from: string; to: string; preset?: string | null; onChange: (r: { from: string; to: string }) => void; className?: string }): React.JSX.Element;
  export const DATE_PRESETS: { key: string; label: string }[];
  /** "today" | "7d" | "30d" | "month" | "lastMonth" | "90d" */
  export function presetRange(preset: string, today?: string): { from: string; to: string };
  export function cn(...classes: unknown[]): string;
  /** "Inez Ortiz" → "IO". */
  export function initials(name: string): string;
  /** A stable avatar color for an id (the roster's colors). */
  export function tintFor(id: string): string;
  /** Answered for the device's window, not the frame: (min-width: Npx), (max-width: Npx), (orientation: portrait). */
  export function useMediaQuery(query: string): boolean;
  /** Distance in metres between two points, and sites sorted nearest-first. */
  export function distanceMeters(a: { latitude: number; longitude: number }, b: { latitude: number; longitude: number }): number;
  export function formatDistance(m: number): string;
}

declare module "@lcs/charts" {
  import type * as React from "react";
  /** A stacked series: key into DailyBars parts, its name, and a palette slot (0-7, null = "Other" gray). */
  export interface Series { key: string; name: string; slot: number | null }
  /** CSS color of chart palette slot 0-7 (colorblind-checked, light and dark), or "Other" gray for null. */
  export function slotColor(slot: number | null): string;
  export const SITE_TYPE: { supportive: { label: string; color: string }; shelter: { label: string; color: string }; other: { label: string; color: string } };
  export function siteTypeOf(siteType: string): { label: string; color: string };
  export function Legend(props: { items: { label: string; color: string }[]; className?: string }): React.JSX.Element;
  /** Stacked bars per day. parts: { [series.key]: count }; `meals` is the bar's total. */
  export function DailyBars(props: { data: { day: string; meals: number; entries: number; parts: Record<string, number> }[]; series: Series[] }): React.JSX.Element;
  /** Horizontal bars, biggest first as given. `lead` goes before the name (e.g. an Avatar). */
  export function RankedBars(props: { rows: { name: string; value: number; note?: string; color?: string; lead?: React.ReactNode }[]; unit: string; limit?: number }): React.JSX.Element;
  /** 7 rows (Sunday first, to Saturday) × 24 hours of counts. ctx.time.partsOf's weekday counts from Monday: use heat[(weekday + 1) % 7]. */
  export function HeatGrid(props: { heat: number[][] }): React.JSX.Element;
  export function StatTile(props: { label: string; value: string; hint?: string; icon?: React.ReactNode; accent?: string }): React.JSX.Element;
}

declare module "@lcs/server" {
  export interface ServerUser {
    id: string;
    name: string;
    email: string;
    roleKey: string;
    permissions: string[];
    siteIds: string[] | null;
  }

  export interface ServerSite { id: string; code: string; name: string; siteType: string }
  export interface ServerResident { id: string; siteId: string; name: string; unit: string | null; status: string }

  export interface ServerEntry<T = Record<string, unknown>> {
    id: string;
    data: T;
    siteId: string | null;
    tenantId: string | null;
    occurredAt: string;
    createdAt: string;
    createdById: string | null;
    createdByName: string;
    status: "active" | "voided";
    overrideReason: string | null;
  }

  export interface ServerEntryQuery {
    siteId?: string;
    tenantId?: string;
    /** "YYYY-MM-DD" (New York day, inclusive) or ISO time. */
    from?: string;
    to?: string;
    status?: "active" | "voided" | "all";
    /** Top-level data fields that must equal these values. */
    where?: Record<string, string | number | boolean | null>;
    /** Return only these top-level data fields — keep replies small (skip signatures, photos). */
    fields?: string[];
    order?: "newest" | "oldest";
    /** Default 500. Max 5,000, or 20,000 when `fields` is given. Check the count if you need to know it was cut short. */
    limit?: number;
  }

  export interface EntriesApi {
    find<T = Record<string, unknown>>(q?: ServerEntryQuery): ServerEntry<T>[];
    count(q?: ServerEntryQuery): number;
    get<T = Record<string, unknown>>(id: string): ServerEntry<T> | null;
  }

  export interface Ctx {
    /** Who's using the form (null when called by an API key or the MCP server). */
    user: ServerUser | null;
    /** ISO time now, and today's New York day. */
    now: string;
    today: string;
    /** Is this the draft (preview) or the published form? */
    draft: boolean;
    db: {
      /** This form's entries — all of them, regardless of who's asking. */
      entries: EntriesApi;
      collections: {
        list<T = Record<string, unknown>>(name: string): { id: string; data: T }[];
        get<T = Record<string, unknown>>(name: string, id: string): { id: string; data: T } | null;
        put<T = Record<string, unknown>>(name: string, id: string | null, data: T): { id: string; data: T };
        remove(name: string, id: string): void;
      };
      /** Another form's entries (listed in form.json "reads"), only if this person may read them. */
      form(slug: string): { entries: EntriesApi };
    };
    roster: {
      site(idOrCode: string): ServerSite | null;
      sites(): ServerSite[];
      resident(id: string): ServerResident | null;
      residents(siteIdOrCode: string): ServerResident[];
    };
    time: {
      /** New York "YYYY-MM-DD" of an ISO time. */
      dayOf(iso: string): string;
      /** ISO time of midnight starting a New York day. */
      startOfDay(day: string): string;
      addDays(day: string, n: number): string;
      minutesBetween(aIso: string, bIso: string): number;
      /** New York day, hour (0-23) and weekday (0 = Monday) of an ISO time. */
      partsOf(iso: string): { day: string; hour: number; weekday: number };
    };
    /** Goes to the editor's console (and the server log). */
    log(...args: unknown[]): void;
  }

  export interface IncomingEntry<T = Record<string, unknown>> {
    data: T;
    site: ServerSite | null;
    resident: ServerResident | null;
    occurredAt: string;
    clientId: string | null;
    /** A reason, when the person was asked for one and gave it. */
    override: string | null;
  }

  export interface BeforeCreateResult<T> {
    /** Refuse: field → message (422). */
    errors?: Record<string, string | undefined>;
    /** Allowed only with a reason: the person is shown these and asked why. */
    needsOverride?: string[];
    /** Replace the data that gets saved (e.g. add computed fields). */
    data?: T;
  }

  export interface ServerDefinition {
    /** Runs before every entry is saved. The server's word is final. */
    beforeCreate?(entry: IncomingEntry<any>, ctx: Ctx): BeforeCreateResult<any> | void | Promise<BeforeCreateResult<any> | void>;
    /** Runs after an entry is saved (notifications, follow-up records). */
    afterCreate?(entry: ServerEntry<any>, ctx: Ctx): void | Promise<void>;
    /** Endpoints your pages call with actions.call(name, args). Return JSON. */
    actions?: Record<string, (args: any, ctx: Ctx) => unknown>;
  }

  /** server/index.ts: `export default defineServer({ … })` */
  export function defineServer(def: ServerDefinition): ServerDefinition;

  /** Throw to refuse with a message the person sees (status 400). */
  export class UserError extends Error {}
}
