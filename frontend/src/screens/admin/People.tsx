import { useMemo, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { Search, UserPlus } from "lucide-react";
import { Page, PageHeader } from "@/components/shell/AppShell";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Field } from "@/components/ui/label";
import { Select } from "@/components/ui/select";
import { Avatar } from "@/components/ui/avatar";
import { Tag, ToneBadge } from "@/components/ui/badge";
import { CheckboxList } from "@/components/ui/checkbox";
import { Chip } from "@/components/ui/chip";
import { Switch } from "@/components/ui/switch";
import { Dialog, DialogBody, DialogContent, DialogFooter, DialogHeader } from "@/components/ui/dialog";
import { LoadingState } from "@/components/ui/misc";
import { useToast } from "@/components/ui/toast";
import { api } from "@/lib/api";
import { useAuth } from "@/lib/auth";
import { useRoles, useSites, useUsers } from "@/lib/queries";
import { errorMessage, relativeTime } from "@/lib/utils";
import type { ManagedUser, UserStatus } from "@/lib/types";

const STATUS_TONE: Record<UserStatus, "green" | "blue" | "amber" | "red" | "neutral"> = {
  active: "green", invited: "blue", requested: "amber", denied: "red", deactivated: "neutral",
};

const STATUS_LABEL: Record<UserStatus, string> = {
  active: "Active", invited: "Pending", requested: "Wants access", denied: "Denied", deactivated: "Deactivated",
};

/**
 * People sit in three lists. Pending is everyone not in yet: accounts an admin
 * made ahead of time (just an email until that person's first Microsoft
 * sign-in fills in their name and job title), and sign-ins asking for access,
 * which float to the top. Deactivated holds denied requests too.
 */
type Tab = "active" | "pending" | "deactivated";
const TABS: { key: Tab; label: string }[] = [
  { key: "active", label: "Active" },
  { key: "pending", label: "Pending" },
  { key: "deactivated", label: "Deactivated" },
];
const tabOf = (status: UserStatus): Tab =>
  status === "active" ? "active" : status === "invited" || status === "requested" ? "pending" : "deactivated";

const EMPTY_STATE: Record<Tab, string> = {
  active: "Nobody has signed in yet.",
  pending: "No pending accounts. Add someone by email to set up their role before they sign in.",
  deactivated: "Nobody has been deactivated.",
};

/** A pending account's name is its email until the first sign-in brings the real one. */
const hasName = (u: { name: string; email: string }) => u.name.trim().toLowerCase() !== u.email.toLowerCase();

const looksLikeEmail = (v: string) => /^\S+@\S+\.\S+$/.test(v.trim());

type Draft = {
  id?: string;
  name: string;
  email: string;
  /** Job title from Microsoft. Shown, never edited here. */
  title?: string | null;
  roleKey: string;
  status: UserStatus;
  /** Signed in at least once: reactivating them makes them active again, not pending. */
  hasSignedIn: boolean;
  /** Only the sites this editor can see; the server keeps the rest. */
  siteIds: string[];
  /** Sites the person holds that this editor doesn't manage. */
  otherSites: number;
  canEditRole: boolean;
  /** "Can edit the calendar": events for their own sites. Only an Admin changes it. */
  calendarEditor: boolean;
  /** A Global Admin: also makes, changes and removes Admins. Only a Global Admin changes it. */
  globalAdmin: boolean;
};

/**
 * The status picker offers the moves that make sense from where the person is.
 * It never offers active-before-sign-in: a pending account becomes active only
 * when its owner signs in, which is what brings in their name and title.
 * Reactivating someone who never signed in puts them back to pending.
 */
function statusChoices(d: Draft): { value: UserStatus; label: string }[] {
  switch (d.status) {
    case "active":
      return [{ value: "active", label: "Active" }, { value: "deactivated", label: "Deactivated" }];
    case "invited":
      return [{ value: "invited", label: "Pending (not signed in yet)" }, { value: "deactivated", label: "Deactivated" }];
    case "requested":
      return [
        { value: "requested", label: "Waiting for approval" },
        { value: "active", label: "Approve (active)" },
        { value: "denied", label: "Deny" },
      ];
    case "denied":
    case "deactivated":
      return [
        { value: d.status, label: STATUS_LABEL[d.status] },
        d.hasSignedIn ? { value: "active", label: "Reactivate (active)" } : { value: "invited", label: "Reactivate (pending)" },
      ];
  }
}

/**
 * Who can use the site, with what role, at which sites, in three tabs: Active,
 * Pending and Deactivated (see TABS). Name and job title always come from
 * Microsoft at sign-in; an admin only ever types an email.
 *
 * An Admin sees everyone. A Site Admin sees the people at their sites (and new
 * sign-ins not placed anywhere yet), can hand out only the site roles, and can
 * only tick their own sites — the server enforces the same. The "Can edit the
 * calendar" switch is an Admin's alone: a Site Admin sees it but can't change it.
 */
export function AdminPeople() {
  const { can } = useAuth();
  const everyone = can("users.manage");
  // Admins are a Global Admin's to make, change or remove; the server refuses anyone else.
  const managesAdmins = can("admins.manage");
  const { data: users, isLoading } = useUsers();
  const { data: roles } = useRoles();
  // Everyone but an Admin gets exactly their assigned sites back.
  const { data: sites } = useSites(true);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [tab, setTab] = useState<Tab>("active");
  const [search, setSearch] = useState("");
  const qc = useQueryClient();
  const toast = useToast();

  const counts = useMemo(() => {
    const out: Record<Tab, number> = { active: 0, pending: 0, deactivated: 0 };
    for (const u of users ?? []) out[tabOf(u.status)]++;
    return out;
  }, [users]);
  const requests = (users ?? []).filter((u) => u.status === "requested").length;

  const needle = search.trim().toLowerCase();
  const shown = (users ?? [])
    .filter((u) => tabOf(u.status) === tab)
    .filter((u) => !needle || [u.name, u.email, u.title ?? ""].some((v) => v.toLowerCase().includes(needle)))
    .sort((a, b) =>
      Number(b.status === "requested") - Number(a.status === "requested") ||
      a.name.localeCompare(b.name, undefined, { sensitivity: "base" })
    );

  async function save() {
    if (!draft) return;
    try {
      // Only an Admin may send the calendar switch; the server refuses it from anyone else.
      const calendar = everyone ? { calendarEditor: draft.calendarEditor } : {};
      const global = managesAdmins ? { globalAdmin: draft.roleKey === "admin" && draft.globalAdmin } : {};
      if (draft.id) await api.patch(`/users/${draft.id}`, { roleKey: draft.roleKey, status: draft.status, siteIds: draft.siteIds, ...calendar, ...global });
      else await api.post("/users", { email: draft.email.trim(), roleKey: draft.roleKey, siteIds: draft.siteIds, ...calendar, ...global });
      toast(draft.id ? "Saved." : `Added ${draft.email.trim()}. Their name and title fill in when they first sign in.`);
      // A new account lands in Pending; show it there.
      if (!draft.id) setTab("pending");
      setDraft(null);
      await qc.invalidateQueries({ queryKey: ["admin", "users"] });
    } catch (e) {
      toast(errorMessage(e, "Could not save."), "error");
    }
  }

  const edit = (u: ManagedUser) => {
    const mine = new Set((sites ?? []).map((s) => s.id));
    setDraft({
      id: u.id, name: hasName(u) ? u.name : u.email, email: u.email, title: u.title, roleKey: u.roleKey, status: u.status,
      hasSignedIn: Boolean(u.lastSignInAt),
      siteIds: u.sites.filter((s) => mine.has(s.id)).map((s) => s.id),
      otherSites: u.sites.filter((s) => !mine.has(s.id)).length,
      canEditRole: u.canEditRole && (u.roleKey !== "admin" || managesAdmins),
      calendarEditor: Boolean(u.calendarEditor),
      globalAdmin: Boolean(u.globalAdmin),
    });
  };
  const role = roles?.find((r) => r.key === draft?.roleKey);
  // The person's current role stays listed even if this editor can't give it out.
  const roleOptions = (roles ?? []).filter((r) => r.assignable || r.key === draft?.roleKey);

  return (
    <Page>
      <PageHeader
        title="People & roles"
        subtitle={everyone
          ? "Add people by work email before they sign in, so their role and sites are ready on day one. Partner staff can sign in with Google Workspace once their domain or address is admitted."
          : "People at your sites, and pending accounts waiting to be placed. You can give out the site roles for your own sites."}
        actions={
          <Button onClick={() => setDraft({ name: "", email: "", roleKey: "site_staff", status: "invited", hasSignedIn: false, siteIds: [], otherSites: 0, canEditRole: true, calendarEditor: false, globalAdmin: false })}>
            <UserPlus className="h-4 w-4" /> Add person
          </Button>
        }
      />
      <div className="mb-3 flex flex-wrap items-center gap-2">
        <div className="chiprow flex gap-2">
          {TABS.map((t) => (
            <Chip key={t.key} active={tab === t.key} onClick={() => setTab(t.key)}>
              {t.label}
              <span className="opacity-70">{counts[t.key]}</span>
              {t.key === "pending" && requests > 0 && tab !== "pending" && (
                <span className="inline-block h-1.5 w-1.5 rounded-pill bg-status-amberDot" title={`${requests} waiting for approval`} />
              )}
            </Chip>
          ))}
        </div>
        <div className="relative w-full sm:ml-auto sm:w-[240px]">
          <Search className="pointer-events-none absolute left-2.5 top-1/2 h-4 w-4 -translate-y-1/2 text-muted" />
          <Input value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Search name, email, title" className="pl-8" />
        </div>
      </div>
      {isLoading ? <LoadingState /> : (
        <Card>
          <ul>
            {shown.map((u) => {
              const named = hasName(u);
              const where = u.role.allSites ? "all sites" : u.sites.length ? u.sites.map((s) => s.name).join(", ") : "no sites assigned";
              const via = u.identityProvider && u.identityProvider !== "microsoft" ? ` · via ${u.identityProvider === "google.com" ? "Google" : u.identityProvider}` : "";
              return (
                <li key={u.id}>
                  <button onClick={() => edit(u)} className="flex w-full items-center gap-3 border-b border-hairline px-4 py-3 text-left hover:bg-rowhover">
                    <Avatar name={named ? u.name : u.email} color={u.avatarColor} size={34} />
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-[13.5px] font-semibold text-ink">
                        {named ? u.name : u.email}
                        {named && u.title && <span className="font-normal text-muted"> · {u.title}</span>}
                      </span>
                      <span className="block truncate text-micro text-muted">
                        {named ? `${u.email}${via} · ` : ""}{where}
                      </span>
                    </span>
                    <span className="hidden text-micro text-muted md:block">
                      {u.lastSignInAt ? `signed in ${relativeTime(u.lastSignInAt)}` : u.status === "invited" ? `added ${relativeTime(u.createdAt)}` : "never signed in"}
                    </span>
                    {u.calendarEditor && u.roleKey !== "admin" && <Tag tone="accent" title="Can edit the calendar">Calendar</Tag>}
                    <span className="hidden text-[13px] text-ink sm:block">{u.role.name}</span>
                    {/* The Active tab says it already; the other two mix statuses. */}
                    {tab !== "active" && <ToneBadge tone={STATUS_TONE[u.status]}>{STATUS_LABEL[u.status]}</ToneBadge>}
                  </button>
                </li>
              );
            })}
            {shown.length === 0 && (
              <li className="px-4 py-8 text-center text-[13px] text-muted">{needle ? "Nobody matches that search." : EMPTY_STATE[tab]}</li>
            )}
          </ul>
        </Card>
      )}

      <Dialog open={Boolean(draft)} onOpenChange={(o) => !o && setDraft(null)}>
        <DialogContent aria-describedby={undefined}>
          <DialogHeader
            title={draft?.id ? draft.name : "Add a person"}
            subtitle={draft?.id
              ? [draft.title, draft.name !== draft.email ? draft.email : null].filter(Boolean).join(" · ") || undefined
              : "They sign in with Microsoft or, for partner orgs, Google Workspace."}
          />
          {draft && (
            <DialogBody className="grid gap-3">
              {!draft.id && (
                <Field label="Work email" hint="Their name and job title come from Microsoft when they first sign in. Until then they're pending, but you can already give them a role and sites, and pick them as an approver.">
                  <Input type="email" autoFocus value={draft.email} onChange={(e) => setDraft({ ...draft, email: e.target.value })} placeholder="name@lanterncommunity.org" />
                </Field>
              )}
              {draft.id && draft.status === "invited" && (
                <p className="rounded-input bg-subtle px-3 py-2 text-[13px] text-muted">
                  Hasn't signed in yet. Their first sign-in fills in their name and job title from Microsoft and makes the account active.
                </p>
              )}
              {!draft.canEditRole && (
                <p className="rounded-input bg-subtle px-3 py-2 text-[13px] text-muted">
                  {draft.roleKey === "admin"
                    ? `Only a Global Admin can change ${draft.name}'s role or status.`
                    : `${draft.name} also works at a site you don't manage, so only an Admin can change their role or status. You can still change which of your sites they're on.`}
                </p>
              )}
              <div className="grid grid-cols-2 gap-3">
                <Field label="Role" hint={role?.description}>
                  <Select value={draft.roleKey} disabled={!draft.canEditRole} onChange={(e) => setDraft({ ...draft, roleKey: e.target.value })}
                    options={roleOptions.map((r) => ({ value: r.key, label: r.name }))} />
                </Field>
                {draft.id && (
                  <Field label="Status">
                    <Select value={draft.status} disabled={!draft.canEditRole} onChange={(e) => setDraft({ ...draft, status: e.target.value as UserStatus })}
                      options={statusChoices(draft)} />
                  </Field>
                )}
              </div>
              {draft.roleKey === "admin" && managesAdmins && (
                <label className="flex cursor-pointer items-start justify-between gap-3 rounded-input border border-hairline px-3 py-2.5">
                  <span>
                    <span className="block text-[13.5px] font-semibold text-ink">Global Admin</span>
                    <span className="block text-micro text-muted">Can also make people Admins, and change or remove Admins.</span>
                  </span>
                  <Switch checked={draft.globalAdmin} onCheckedChange={(globalAdmin) => setDraft({ ...draft, globalAdmin })} className="mt-0.5" />
                </label>
              )}
              {draft.roleKey === "admin" ? (
                <p className="rounded-input bg-subtle px-3 py-2 text-[13px] text-muted">
                  {draft.globalAdmin && !managesAdmins ? "A Global Admin. " : ""}Admins can always edit the calendar and its categories.
                </p>
              ) : everyone ? (
                <label className="flex cursor-pointer items-start justify-between gap-3 rounded-input border border-hairline px-3 py-2.5">
                  <span>
                    <span className="block text-[13.5px] font-semibold text-ink">Can edit the calendar</span>
                    <span className="block text-micro text-muted">
                      Add, change and remove events for {role?.allSites ? "any site, one site at a time" : "their own sites"}. Events for every site and the categories stay with Admins.
                    </span>
                  </span>
                  <Switch checked={draft.calendarEditor} onCheckedChange={(calendarEditor) => setDraft({ ...draft, calendarEditor })} className="mt-0.5" />
                </label>
              ) : draft.calendarEditor ? (
                <p className="rounded-input bg-subtle px-3 py-2 text-[13px] text-muted">Can edit the calendar at their sites. Only an Admin can change that.</p>
              ) : null}
              {role?.allSites ? (
                <p className="rounded-input bg-subtle px-3 py-2 text-[13px] text-muted">{role.name} sees every site.</p>
              ) : (
                <Field
                  label={
                    <span className="flex items-center justify-between">
                      <span>Assigned sites ({draft.siteIds.length})</span>
                      <span className="flex gap-3">
                        <button type="button" className="text-accent dark:text-white" onClick={() => setDraft({ ...draft, siteIds: (sites ?? []).map((s) => s.id) })}>Select all</button>
                        <button type="button" className="text-accent dark:text-white" onClick={() => setDraft({ ...draft, siteIds: [] })}>Clear</button>
                      </span>
                    </span>
                  }
                  hint={`They'll only see — and only be able to change — the rosters of these sites.${draft.otherSites ? ` They're also on ${draft.otherSites} site${draft.otherSites === 1 ? "" : "s"} you don't manage; those stay as they are.` : ""}`}
                >
                  {draft.siteIds.length === 0 && draft.otherSites === 0 && (
                    <p className="mb-2 rounded-input bg-status-amberBg px-3 py-2 text-[12.5px] text-status-amberText">
                      No sites assigned — this person won't see any rosters.
                    </p>
                  )}
                  <CheckboxList
                    options={(sites ?? []).map((s) => ({ value: s.id, label: s.name }))}
                    value={draft.siteIds}
                    onChange={(siteIds) => setDraft({ ...draft, siteIds })}
                    className="max-h-[220px] overflow-y-auto"
                  />
                </Field>
              )}
            </DialogBody>
          )}
          <DialogFooter>
            <Button variant="secondary" onClick={() => setDraft(null)}>Cancel</Button>
            <Button onClick={save} disabled={!draft?.id && !looksLikeEmail(draft?.email ?? "")}>{draft?.id ? "Save" : "Add"}</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </Page>
  );
}
