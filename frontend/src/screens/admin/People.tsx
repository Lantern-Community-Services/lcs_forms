import { useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { UserPlus } from "lucide-react";
import { Page, PageHeader } from "@/components/shell/AppShell";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Field } from "@/components/ui/label";
import { Select } from "@/components/ui/select";
import { Avatar } from "@/components/ui/avatar";
import { ToneBadge } from "@/components/ui/badge";
import { CheckboxList } from "@/components/ui/checkbox";
import { Chip } from "@/components/ui/chip";
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

type Draft = {
  id?: string;
  name: string;
  email: string;
  roleKey: string;
  status: UserStatus;
  /** Only the sites this editor can see; the server keeps the rest. */
  siteIds: string[];
  /** Sites the person holds that this editor doesn't manage. */
  otherSites: number;
  canEditRole: boolean;
};

/**
 * Who can use the roster, with what role, at which sites. Access requests
 * (someone signed in who isn't set up yet) float to the top.
 *
 * An Admin sees everyone. A Site Admin sees the people at their sites (and new
 * sign-ins not placed anywhere yet), can hand out only the site roles, and can
 * only tick their own sites — the server enforces the same.
 */
export function AdminPeople() {
  const { can } = useAuth();
  const everyone = can("users.manage");
  const { data: users, isLoading } = useUsers();
  const { data: roles } = useRoles();
  // Everyone but an Admin gets exactly their assigned sites back.
  const { data: sites } = useSites(true);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [filter, setFilter] = useState<"current" | "all">("current");
  const qc = useQueryClient();
  const toast = useToast();

  const shown = (users ?? [])
    .filter((u) => filter === "all" || u.status !== "deactivated")
    .sort((a, b) => Number(b.status === "requested") - Number(a.status === "requested"));

  async function save() {
    if (!draft) return;
    try {
      if (draft.id) await api.patch(`/users/${draft.id}`, { roleKey: draft.roleKey, status: draft.status, siteIds: draft.siteIds });
      else await api.post("/users", { name: draft.name, email: draft.email, roleKey: draft.roleKey, siteIds: draft.siteIds });
      toast(draft.id ? "Saved." : `Invited ${draft.name}. They'll be active on first sign-in.`);
      setDraft(null);
      await qc.invalidateQueries({ queryKey: ["admin", "users"] });
    } catch (e) {
      toast(errorMessage(e, "Could not save."), "error");
    }
  }

  const edit = (u: ManagedUser) => {
    const mine = new Set((sites ?? []).map((s) => s.id));
    setDraft({
      id: u.id, name: u.name, email: u.email, roleKey: u.roleKey, status: u.status,
      siteIds: u.sites.filter((s) => mine.has(s.id)).map((s) => s.id),
      otherSites: u.sites.filter((s) => !mine.has(s.id)).length,
      canEditRole: u.canEditRole,
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
          ? "Invite Lantern and partner staff. Partner staff can sign in with Google Workspace once their domain or address is admitted."
          : "People at your sites, and new sign-ins waiting to be placed. You can give out the site roles for your own sites."}
        actions={
          <Button onClick={() => setDraft({ name: "", email: "", roleKey: "site_staff", status: "invited", siteIds: [], otherSites: 0, canEditRole: true })}>
            <UserPlus className="h-4 w-4" /> Invite
          </Button>
        }
      />
      <div className="mb-3 flex gap-2">
        {(["current", "all"] as const).map((f) => (
          <Chip key={f} active={filter === f} onClick={() => setFilter(f)}>
            {f === "current" ? "Current" : "Including deactivated"}
          </Chip>
        ))}
      </div>
      {isLoading ? <LoadingState /> : (
        <Card>
          <ul>
            {shown.map((u) => (
              <li key={u.id}>
                <button onClick={() => edit(u)} className="flex w-full items-center gap-3 border-b border-hairline px-4 py-3 text-left hover:bg-rowhover">
                  <Avatar name={u.name} color={u.avatarColor} size={34} />
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-[13.5px] font-semibold text-ink">{u.name}</span>
                    <span className="block truncate text-micro text-muted">
                      {u.email}{u.identityProvider && u.identityProvider !== "microsoft" ? ` · via ${u.identityProvider === "google.com" ? "Google" : u.identityProvider}` : ""} · {u.role.allSites ? "all sites" : u.sites.length ? u.sites.map((s) => s.name).join(", ") : "no sites assigned"}
                    </span>
                  </span>
                  <span className="hidden text-micro text-muted md:block">{u.lastSignInAt ? `signed in ${relativeTime(u.lastSignInAt)}` : "never signed in"}</span>
                  <span className="hidden text-[13px] text-ink sm:block">{u.role.name}</span>
                  <ToneBadge tone={STATUS_TONE[u.status]}>{u.status === "requested" ? "Wants access" : u.status}</ToneBadge>
                </button>
              </li>
            ))}
          </ul>
        </Card>
      )}

      <Dialog open={Boolean(draft)} onOpenChange={(o) => !o && setDraft(null)}>
        <DialogContent aria-describedby={undefined}>
          <DialogHeader title={draft?.id ? draft.name : "Invite someone"} subtitle={draft?.id ? draft.email : "They sign in with Microsoft or, for partner orgs, Google Workspace."} />
          {draft && (
            <DialogBody className="grid gap-3">
              {!draft.id && (
                <div className="grid grid-cols-2 gap-3">
                  <Field label="Name"><Input value={draft.name} onChange={(e) => setDraft({ ...draft, name: e.target.value })} /></Field>
                  <Field label="Work email"><Input type="email" value={draft.email} onChange={(e) => setDraft({ ...draft, email: e.target.value })} /></Field>
                </div>
              )}
              {!draft.canEditRole && (
                <p className="rounded-input bg-subtle px-3 py-2 text-[13px] text-muted">
                  {draft.name} also works at a site you don't manage, so only an Admin can change their role or status. You can still change which of your sites they're on.
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
                      options={[
                        { value: "active", label: draft.status === "requested" ? "Approve (active)" : "Active" },
                        ...(draft.status === "requested" ? [{ value: "requested", label: "Waiting for approval" }] : []),
                        { value: "invited", label: "Invited" },
                        { value: "denied", label: "Denied" },
                        { value: "deactivated", label: "Deactivated" },
                      ]} />
                  </Field>
                )}
              </div>
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
            <Button onClick={save} disabled={!draft?.id && (!draft?.name || !draft?.email)}>{draft?.id ? "Save" : "Invite"}</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </Page>
  );
}
