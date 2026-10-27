import { useMemo, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { ClipboardList, RotateCcw, Search, UserPlus } from "lucide-react";
import { Link } from "react-router-dom";
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
import { GROUPS_KEY, groupsApi, useStaffGroups } from "@/lib/groups";
import { errorMessage, relativeTime } from "@/lib/utils";
import { useSearchParam } from "@/lib/useSearchParam";
import type { ManagedUser, UserStatus } from "@/lib/types";

const STATUS_TONE: Record<UserStatus, "green" | "blue" | "amber" | "red" | "neutral"> = {
  active: "green", invited: "blue", requested: "amber", denied: "red", deactivated: "neutral",
};

const STATUS_LABEL: Record<UserStatus, string> = {
  active: "Active", invited: "Pending", requested: "Wants access", denied: "Denied", deactivated: "Deactivated",
};

/**
 * People sit in four lists. Pending is accounts an admin made ahead of time:
 * just an email until that person's first Microsoft sign-in fills in their
 * name and job title. Requests is people who signed in, chose where they work
 * and which sites they want to see, and are waiting for those sites' managers
 * (or an Admin) — plus anyone already in who asked for a site this viewer
 * decides. Deactivated holds denied requests too.
 */
type Tab = "active" | "pending" | "requests" | "deactivated";
const TABS: { key: Tab; label: string }[] = [
  { key: "active", label: "Active" },
  { key: "pending", label: "Pending" },
  { key: "requests", label: "Requests" },
  { key: "deactivated", label: "Deactivated" },
];
const TAB_OF: Record<UserStatus, Tab> = {
  active: "active", invited: "pending", requested: "requests", denied: "deactivated", deactivated: "deactivated",
};
const tabOf = (status: UserStatus): Tab => TAB_OF[status];
/** In Requests: a request, or someone already in who's waiting on a site this viewer decides. */
const waitingOnMe = (u: ManagedUser) => u.status === "requested" || (u.status === "active" && u.canApproveSiteIds.length > 0);
const inTab = (u: ManagedUser, t: Tab) => (t === "requests" ? waitingOnMe(u) : tabOf(u.status) === t);

const EMPTY_STATE: Record<Tab, string> = {
  active: "Nobody has signed in yet.",
  pending: "No pending accounts. Add someone by email to set up their role before they sign in.",
  requests: "No one is waiting for access.",
  deactivated: "Nobody has been deactivated.",
};

/** Roles whose own permissions already include roster management: the switch would add nothing. */
const MANAGES_ROSTER = ["admin", "site_manager"];

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
  /** "Can manage the roster": add, edit, keep and remove residents. A Site Manager or Admin changes it. */
  rosterEditor: boolean;
  /** A pending account (never signed in) this viewer may delete. */
  canDelete: boolean;
  /**
   * A Super Admin (User.globalAdmin): an Admin who also makes, changes and
   * removes Admins. Read-only here: Super Admins are set only on the server
   * (SUPER_ADMINS), and the API refuses any change to one.
   */
  superAdmin: boolean;
  /** The editor is looking at their own account: role and status are someone else's call. */
  isSelf: boolean;
};

/** The role picker's value for a Super Admin, shown but never offered. */
const SUPER = "super_admin";
const SUPER_DESCRIPTION = "Everything an Admin can do, plus making, changing and removing Admins.";

/**
 * The status picker offers the moves that make sense from where the person is.
 * It never offers active-before-sign-in: a pending account becomes active only
 * when its owner signs in, which is what brings in their name and title.
 * Reactivating someone who never signed in puts them back to pending.
 */
function statusChoices(d: Draft): { value: UserStatus; label: string }[] {
  if (d.superAdmin) return [{ value: d.status, label: STATUS_LABEL[d.status] }];
  switch (d.status) {
    case "active":
      return [{ value: "active", label: "Active" }, { value: "deactivated", label: "Deactivated" }];
    case "invited":
      return [{ value: "invited", label: "Pending (not signed in yet)" }, { value: "deactivated", label: "Deactivated" }];
    case "requested":
      // Approving happens per site, in the request dialog.
      return [
        { value: "requested", label: "Waiting for approval" },
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
 * Who can use the site, with what role, at which sites, in four tabs: Active,
 * Pending, Requests and Deactivated (see TABS). Name and job title always come from
 * Microsoft at sign-in; an admin only ever types an email.
 *
 * An Admin sees everyone. A Site Manager (this screen is their "Site settings")
 * sees the people at their sites and the requests for them, approves or
 * declines only their own sites, can hand out only the site roles, and can
 * only tick their own sites — the server enforces the same. The "Can edit the
 * calendar" switch is an Admin's alone; "Can manage the roster" is theirs too.
 */
export function AdminPeople() {
  const { can, user: me } = useAuth();
  const everyone = can("users.manage");
  // Admins are a Super Admin's to make, change or remove; the server refuses anyone else.
  const managesAdmins = can("admins.manage");
  const { data: users, isLoading } = useUsers();
  const { data: roles } = useRoles();
  // Everyone but an Admin gets exactly their assigned sites back.
  const { data: sites } = useSites(true);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [request, setRequest] = useState<ManagedUser | null>(null);
  // In the address, so a notification about a request can open the Requests tab.
  const [tabParam, setTabParam] = useSearchParam("tab");
  const tab: Tab = TABS.some((t) => t.key === tabParam) ? (tabParam as Tab) : "active";
  const setTab = (t: Tab) => setTabParam(t === "active" ? null : t);
  const [search, setSearch] = useState("");
  const qc = useQueryClient();
  const toast = useToast();

  const counts = useMemo(() => {
    const out: Record<Tab, number> = { active: 0, pending: 0, requests: 0, deactivated: 0 };
    for (const u of users ?? []) for (const t of TABS) if (inTab(u, t.key)) out[t.key]++;
    return out;
  }, [users]);

  const needle = search.trim().toLowerCase();
  const shown = (users ?? [])
    .filter((u) => inTab(u, tab))
    .filter((u) => !needle || [u.name, u.email, u.title ?? ""].some((v) => v.toLowerCase().includes(needle)))
    .sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: "base" }));

  async function save() {
    if (!draft) return;
    try {
      // Only an Admin may send the calendar switch; the server refuses it from anyone else.
      const calendar = everyone ? { calendarEditor: draft.calendarEditor } : {};
      // The roster switch goes only when this editor may change the person.
      const roster = draft.canEditRole && !draft.isSelf ? { rosterEditor: draft.rosterEditor } : {};
      if (draft.id) await api.patch(`/users/${draft.id}`, { roleKey: draft.roleKey, status: draft.status, siteIds: draft.siteIds, ...calendar, ...roster });
      else await api.post("/users", { email: draft.email.trim(), roleKey: draft.roleKey, siteIds: draft.siteIds, ...calendar });
      toast(draft.id ? "Saved." : `Added ${draft.email.trim()}. Their name and title fill in when they first sign in.`);
      // A new account lands in Pending; show it there.
      if (!draft.id) setTab("pending");
      setDraft(null);
      await qc.invalidateQueries({ queryKey: ["admin", "users"] });
    } catch (e) {
      toast(errorMessage(e, "Could not save."), "error");
    }
  }

  async function remove() {
    if (!draft?.id) return;
    if (!window.confirm(`Delete the pending account for ${draft.email}? It can't be undone. If they sign in later, they'll make a new request.`)) return;
    try {
      await api.delete(`/users/${draft.id}`);
      toast(`Deleted ${draft.email}.`);
      setDraft(null);
      await qc.invalidateQueries({ queryKey: ["admin", "users"] });
    } catch (e) {
      toast(errorMessage(e, "Could not delete."), "error");
    }
  }

  const edit = (u: ManagedUser) => {
    // Requests open the request dialog: they're approved per site, not edited.
    if (tab === "requests" && waitingOnMe(u)) return setRequest(u);
    const mine = new Set((sites ?? []).map((s) => s.id));
    setDraft({
      id: u.id, name: hasName(u) ? u.name : u.email, email: u.email, title: u.title, roleKey: u.roleKey, status: u.status,
      hasSignedIn: Boolean(u.lastSignInAt),
      siteIds: u.sites.filter((s) => mine.has(s.id)).map((s) => s.id),
      otherSites: u.sites.filter((s) => !mine.has(s.id)).length,
      canEditRole: u.canEditRole && (u.roleKey !== "admin" || managesAdmins),
      calendarEditor: Boolean(u.calendarEditor),
      rosterEditor: Boolean(u.rosterEditor),
      canDelete: u.canDelete,
      superAdmin: Boolean(u.globalAdmin),
      isSelf: u.id === me?.id,
    });
  };
  const role = roles?.find((r) => r.key === draft?.roleKey);
  // The person's current role stays listed even if this editor can't give it out.
  // A Super Admin's only option is their own: nobody picks it here.
  const roleOptions = draft?.superAdmin
    ? [{ value: SUPER, label: "Super Admin" }]
    : (roles ?? []).filter((r) => r.assignable || r.key === draft?.roleKey).map((r) => ({ value: r.key, label: r.name }));
  const locked = draft ? draft.superAdmin || !draft.canEditRole || draft.isSelf : true;

  return (
    <Page>
      <PageHeader
        title="People & roles"
        subtitle={everyone
          ? "New people choose where they work and which sites they want to see when they first sign in; approve them in Requests. You can also add someone by work email ahead of time."
          : "People at your sites, and requests to see them. Approve or decline requests for your own sites; the rest wait for their own site's manager."}
        actions={
          <Button onClick={() => setDraft({ name: "", email: "", roleKey: "site_staff", status: "invited", hasSignedIn: false, siteIds: [], otherSites: 0, canEditRole: true, calendarEditor: false, rosterEditor: false, canDelete: false, superAdmin: false, isSelf: false })}>
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
              {t.key === "requests" && counts.requests > 0 && tab !== "requests" && (
                <span className="inline-block h-1.5 w-1.5 rounded-pill bg-status-amberDot" title={`${counts.requests} waiting for approval`} />
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
              const asking = u.requestedSites.length ? `asking for ${u.requestedSites.map((s) => s.name).join(", ")}` : "";
              const has = u.role.allSites ? "all sites" : u.sites.length ? u.sites.map((s) => s.name).join(", ") : u.status === "requested" ? "" : "no sites assigned";
              const where = [has, asking || (u.status === "requested" ? "still choosing their sites" : "")].filter(Boolean).join(" · ");
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
                      {u.lastSignInAt ? `signed in ${relativeTime(u.lastSignInAt)}` : u.status === "invited" ? `added ${relativeTime(u.createdAt)}` : u.status === "requested" ? `asked ${relativeTime(u.createdAt)}` : "never signed in"}
                    </span>
                    {u.calendarEditor && u.roleKey !== "admin" && <Tag tone="accent" title="Can edit the calendar">Calendar</Tag>}
                    {u.rosterEditor && !MANAGES_ROSTER.includes(u.roleKey) && <Tag tone="accent" title="Can manage the roster">Roster</Tag>}
                    <span className="hidden text-[13px] text-ink sm:block">{u.role.name}</span>
                    {/* Only Deactivated mixes statuses (denied and deactivated); the other tabs say it already. */}
                    {tab === "deactivated" && <ToneBadge tone={STATUS_TONE[u.status]}>{STATUS_LABEL[u.status]}</ToneBadge>}
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
              {draft.superAdmin ? (
                <p className="rounded-input bg-subtle px-3 py-2 text-[13px] text-muted">
                  {draft.isSelf ? "You're" : `${draft.name} is`} a Super Admin. Super Admins are set on the server, so nobody can change or remove one here.
                </p>
              ) : draft.isSelf ? (
                <p className="rounded-input bg-subtle px-3 py-2 text-[13px] text-muted">
                  This is you. You can't change your own role or status.
                </p>
              ) : !draft.canEditRole && (
                <p className="rounded-input bg-subtle px-3 py-2 text-[13px] text-muted">
                  {draft.roleKey === "admin"
                    ? `Only a Super Admin can change ${draft.name}'s role or status.`
                    : `${draft.name} also works at a site you don't manage, so only an Admin can change their role or status. You can still change which of your sites they're on.`}
                </p>
              )}
              <div className="grid grid-cols-2 gap-3">
                <Field label="Role" hint={draft.superAdmin ? SUPER_DESCRIPTION : role?.description}>
                  <Select value={draft.superAdmin ? SUPER : draft.roleKey} disabled={locked}
                    onChange={(e) => setDraft({ ...draft, roleKey: e.target.value })}
                    options={roleOptions} />
                </Field>
                {draft.id && (
                  <Field label="Status">
                    <Select value={draft.status} disabled={locked} onChange={(e) => setDraft({ ...draft, status: e.target.value as UserStatus })}
                      options={statusChoices(draft)} />
                  </Field>
                )}
              </div>
              {/* A Super Admin's dialog is read-only: the role and status say it all. */}
              {draft.superAdmin ? null : draft.roleKey === "admin" ? (
                <p className="rounded-input bg-subtle px-3 py-2 text-[13px] text-muted">
                  Admins can always edit the calendar and its categories.
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
              {!draft.superAdmin && !MANAGES_ROSTER.includes(draft.roleKey) && (
                <label className={`flex items-start justify-between gap-3 rounded-input border border-hairline px-3 py-2.5 ${locked ? "opacity-70" : "cursor-pointer"}`}>
                  <span>
                    <span className="block text-[13.5px] font-semibold text-ink">Can manage the roster</span>
                    <span className="block text-micro text-muted">
                      Add and edit residents, confirm or remove them in the review queue, and take attendance at their sites. Without it they can only look.
                    </span>
                  </span>
                  <Switch checked={draft.rosterEditor} disabled={locked} onCheckedChange={(rosterEditor) => setDraft({ ...draft, rosterEditor })} className="mt-0.5" />
                </label>
              )}
              {draft.superAdmin ? null : role?.allSites ? (
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
                  hint={`They'll only see these sites — their rosters, form entries and calendar.${draft.otherSites ? ` They're also on ${draft.otherSites} site${draft.otherSites === 1 ? "" : "s"} you don't manage; those stay as they are.` : ""}`}
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
              {/* Super Admins are changed only on the server, tutorials included: theirs reset from their own Profile. */}
              {draft.id && can("users.manage") && <PersonGroups person={users?.find((u) => u.id === draft.id)} />}
              {draft.id && !draft.superAdmin && <PersonTutorials userId={draft.id} name={draft.name} isSelf={draft.isSelf} />}
            </DialogBody>
          )}
          <DialogFooter>
            {draft?.id && can("people.records") && (
              <Link to={`/admin/people/${draft.id}/records`} className="mr-auto">
                <Button variant="secondary"><ClipboardList className="h-4 w-4" /> Records</Button>
              </Link>
            )}
            {draft?.superAdmin ? (
              <Button variant="secondary" onClick={() => setDraft(null)}>Close</Button>
            ) : (
              <>
                {draft?.id && draft.canDelete && (
                  <Button variant="outlineDanger" className="mr-auto" onClick={remove}>Delete</Button>
                )}
                <Button variant="secondary" onClick={() => setDraft(null)}>Cancel</Button>
                <Button onClick={save} disabled={!draft?.id && !looksLikeEmail(draft?.email ?? "")}>{draft?.id ? "Save" : "Add"}</Button>
              </>
            )}
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <RequestDialog person={request} onClose={() => setRequest(null)} />
    </Page>
  );
}

/**
 * One request: where they work, the sites they asked for, and the ones this
 * viewer decides (their own sites; every site, for an Admin). Approving lets
 * them in with the chosen role; sites run by other managers stay waiting for
 * them. Declining the last site, or deleting, removes the request.
 */
function RequestDialog({ person, onClose }: { person: ManagedUser | null; onClose: () => void }) {
  const { data: roles } = useRoles();
  const qc = useQueryClient();
  const toast = useToast();
  const [picked, setPicked] = useState<string[]>([]);
  const [roleKey, setRoleKey] = useState("site_staff");
  const [busy, setBusy] = useState(false);
  const [openFor, setOpenFor] = useState<string | null>(null);
  // Fresh choices each time a different request opens.
  if (person && openFor !== person.id) {
    setOpenFor(person.id);
    setPicked(person.canApproveSiteIds);
    setRoleKey(person.roleKey);
  }
  if (!person && openFor) setOpenFor(null);

  const firstApproval = person?.status === "requested";
  const mineToDecide = (person?.requestedSites ?? []).filter((s) => person!.canApproveSiteIds.includes(s.id));
  const othersWaiting = (person?.requestedSites ?? []).filter((s) => !person!.canApproveSiteIds.includes(s.id));
  const roleOptions = (roles ?? []).filter((r) => r.assignable && r.key !== "admin").map((r) => ({ value: r.key, label: r.name }));
  const role = roles?.find((r) => r.key === roleKey);

  async function act(kind: "approve" | "decline" | "delete") {
    if (!person) return;
    if (kind === "delete" && !window.confirm(`Delete ${person.name}'s request? If they sign in again they'll start a new one.`)) return;
    setBusy(true);
    try {
      if (kind === "approve") {
        await api.post(`/users/${person.id}/approve`, { siteIds: picked, ...(firstApproval ? { roleKey } : {}) });
        toast(`Approved ${person.name} for ${mineToDecide.filter((s) => picked.includes(s.id)).map((s) => s.name).join(", ")}.`);
      } else if (kind === "decline") {
        const out = await api.post<{ removed: boolean }>(`/users/${person.id}/decline`, { siteIds: picked });
        toast(out.removed ? `Declined. ${person.name}'s request had nothing left, so it was removed.` : "Declined those sites.");
      } else {
        await api.delete(`/users/${person.id}`);
        toast(`Deleted ${person.name}'s request.`);
      }
      onClose();
      await qc.invalidateQueries({ queryKey: ["admin", "users"] });
    } catch (e) {
      toast(errorMessage(e, "Could not save."), "error");
    } finally {
      setBusy(false);
    }
  }

  return (
    <Dialog open={Boolean(person)} onOpenChange={(o) => !o && onClose()}>
      <DialogContent aria-describedby={undefined}>
        <DialogHeader
          title={person?.name ?? ""}
          subtitle={[person?.title, person?.email].filter(Boolean).join(" · ") || undefined}
        />
        {person && (
          <DialogBody className="grid gap-3">
            <div className="grid gap-1 text-[13px]">
              <p><span className="text-muted">Works at: </span><span className="text-ink">{person.locationNames.length ? person.locationNames.join(", ") : "not said"}</span></p>
              {person.sites.length > 0 && (
                <p><span className="text-muted">Already has: </span><span className="text-ink">{person.sites.map((s) => s.name).join(", ")}</span></p>
              )}
              <p className="text-micro text-muted">Asked {relativeTime(person.createdAt)}</p>
            </div>
            {person.requestedSites.length === 0 ? (
              <p className="rounded-input bg-subtle px-3 py-2 text-[13px] text-muted">
                They signed in but haven't chosen their sites yet. They'll be asked again next time they sign in.
              </p>
            ) : (
              <Field label={`Sites they want to see (${mineToDecide.length} for you to decide)`} hint="Tick the ones to approve or decline.">
                {mineToDecide.length > 0 ? (
                  <CheckboxList options={mineToDecide.map((s) => ({ value: s.id, label: s.name }))} value={picked} onChange={setPicked} />
                ) : (
                  <p className="text-[13px] text-muted">None of these are your sites.</p>
                )}
                {othersWaiting.length > 0 && (
                  <p className="mt-2 text-micro text-muted">
                    Waiting for their own site's manager: {othersWaiting.map((s) => s.name).join(", ")}
                  </p>
                )}
              </Field>
            )}
            {firstApproval && mineToDecide.length > 0 && (
              <Field label="Role" hint={role?.description}>
                <Select value={roleKey} onChange={(e) => setRoleKey(e.target.value)} options={roleOptions} />
              </Field>
            )}
          </DialogBody>
        )}
        <DialogFooter>
          {person?.canDelete && (
            <Button variant="outlineDanger" className="mr-auto" disabled={busy} onClick={() => act("delete")}>Delete request</Button>
          )}
          <Button variant="secondary" disabled={busy || picked.length === 0} onClick={() => act("decline")}>Decline</Button>
          <Button disabled={busy || picked.length === 0} onClick={() => act("approve")}>Approve</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

interface PersonTutorial {
  key: string;
  name: string;
  kind: "site" | "form";
  status: "completed" | "skipped";
  version: number;
  step: number | null;
  steps: number | null;
  updatedAt: string;
}

/**
 * The guided tutorials this person has finished or skipped (lib/tour): the
 * welcome tour on each kind of device, and each form's tutorial. Resetting one
 * shows it to them again — the welcome tour the next time they reach their home
 * screen, a form's the next time they open the form. It happens straight away,
 * not with the dialog's Save.
 */
/**
 * Which staff groups someone is in (People & roles → Groups), changeable
 * here: ticking adds them by hand, unticking takes them out even when their
 * job title matches. Saves straight away. Admins only.
 */
function PersonGroups({ person }: { person: ManagedUser | undefined }) {
  const qc = useQueryClient();
  const toast = useToast();
  const { data: groups } = useStaffGroups();
  const [busy, setBusy] = useState<string | null>(null);
  if (!person || !groups?.length) return null;
  const first = person.name.split(" ")[0];

  async function toggle(groupId: string, name: string, on: boolean) {
    const byTitle = person!.groupsByTitle.includes(groupId);
    // On: their title already puts them in → just clear a removal; else add by hand. Off: the reverse.
    const include = on ? (byTitle ? null : true) : byTitle ? false : null;
    setBusy(groupId);
    try {
      await groupsApi.setPerson(groupId, person!.id, include);
      await Promise.all([qc.invalidateQueries({ queryKey: ["admin", "users"] }), qc.invalidateQueries({ queryKey: GROUPS_KEY })]);
      toast(on ? `${first} is in ${name}.` : `${first} is out of ${name}.`);
    } catch (e) {
      toast(errorMessage(e, "Couldn't change that."), "error");
    } finally {
      setBusy(null);
    }
  }

  return (
    <div className="rounded-input border border-hairline">
      <div className="px-3 py-2.5">
        <span className="block text-[13.5px] font-semibold text-ink">Groups</span>
        <span className="block text-micro text-muted">
          Decide which limited forms {first} sees.{person.title ? ` Their job title: ${person.title}.` : ""} Saves straight away.
        </span>
      </div>
      <ul className="grid gap-px border-t border-hairline sm:grid-cols-2">
        {groups.map((g) => {
          const on = person.groupIds.includes(g.id);
          const byTitle = person.groupsByTitle.includes(g.id);
          const note = on ? (byTitle ? "from job title" : "added by hand") : byTitle ? "taken out" : null;
          return (
            <li key={g.id}>
              <label className="flex min-h-[36px] cursor-pointer items-center gap-2 px-3 py-1 text-[13px] text-ink hover:bg-rowhover">
                <input type="checkbox" checked={on} disabled={busy !== null} onChange={(e) => void toggle(g.id, g.name, e.target.checked)} />
                <span className="min-w-0 flex-1 truncate">{g.name}</span>
                {note && <span className="text-micro text-muted">{note}</span>}
              </label>
            </li>
          );
        })}
      </ul>
    </div>
  );
}

function PersonTutorials({ userId, name, isSelf }: { userId: string; name: string; isSelf: boolean }) {
  const qc = useQueryClient();
  const toast = useToast();
  const key = ["admin", "users", userId, "tutorials"];
  const { data, isLoading } = useQuery({ queryKey: key, queryFn: () => api.get<PersonTutorial[]>(`/users/${userId}/tutorials`) });
  const [busy, setBusy] = useState<string | null>(null);
  const first = name.split(" ")[0];

  async function reset(one?: PersonTutorial) {
    setBusy(one?.key ?? "all");
    try {
      const out = await api.delete<{ reset: number; tutorials: PersonTutorial[] }>(`/users/${userId}/tutorials${one ? `?key=${encodeURIComponent(one.key)}` : ""}`);
      qc.setQueryData(key, out.tutorials);
      // Your own: this device forgets them too, so they start here without a reload.
      if (isSelf) await qc.invalidateQueries({ queryKey: ["tutorials"] });
      toast(
        one
          ? `${one.kind === "site" ? "The welcome tour" : `“${one.name}”`} will show ${isSelf ? "you" : first} again.`
          : `All of ${isSelf ? "your" : `${first}'s`} tutorials will run again.`
      );
    } catch (e) {
      toast(errorMessage(e, "Couldn't reset that. Try again."), "error");
    } finally {
      setBusy(null);
    }
  }

  const describe = (t: PersonTutorial) =>
    t.status === "completed"
      ? `Finished ${relativeTime(t.updatedAt)}`
      : `Skipped ${t.step !== null && t.steps ? `at step ${t.step + 1} of ${t.steps} ` : ""}${relativeTime(t.updatedAt)}`;

  return (
    <div className="rounded-input border border-hairline">
      <div className="flex items-center justify-between gap-3 px-3 py-2.5">
        <span>
          <span className="block text-[13.5px] font-semibold text-ink">Tutorials</span>
          <span className="block text-micro text-muted">Reset one to show it to {isSelf ? "you" : first} again.</span>
        </span>
        {(data?.length ?? 0) > 1 && (
          <Button size="sm" variant="secondary" onClick={() => void reset()} disabled={busy !== null}>
            <RotateCcw className="h-3.5 w-3.5" /> Reset all
          </Button>
        )}
      </div>
      {isLoading ? (
        <p className="border-t border-hairline px-3 py-2.5 text-[13px] text-muted">Loading…</p>
      ) : !data?.length ? (
        <p className="border-t border-hairline px-3 py-2.5 text-[13px] text-muted">
          {isSelf ? "You haven't" : `${first} hasn't`} finished or skipped any yet. The welcome tour starts the next time {isSelf ? "you reach your" : "they reach their"} home screen.
        </p>
      ) : (
        <ul>
          {data.map((t) => (
            <li key={t.key} className="flex items-center gap-3 border-t border-hairline px-3 py-2">
              <span className="min-w-0 flex-1">
                <span className="block truncate text-[13px] font-semibold text-ink">{t.name}</span>
                <span className="block text-micro text-muted">{describe(t)}</span>
              </span>
              <Button size="sm" variant="ghost" onClick={() => void reset(t)} disabled={busy !== null} aria-label={`Reset ${t.name}`}>
                Reset
              </Button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
