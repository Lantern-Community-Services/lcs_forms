import { useMemo, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { Plus, Trash2, Undo2, UserPlus, UsersRound, X } from "lucide-react";
import { Page, PageHeader } from "@/components/shell/AppShell";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input, SearchInput, Textarea } from "@/components/ui/input";
import { Field } from "@/components/ui/label";
import { Tag } from "@/components/ui/badge";
import { Avatar } from "@/components/ui/avatar";
import { Dialog, DialogBody, DialogContent, DialogFooter, DialogHeader } from "@/components/ui/dialog";
import { EmptyState, LoadingState } from "@/components/ui/misc";
import { useToast } from "@/components/ui/toast";
import { GROUPS_KEY, groupsApi, parseRules, rulesPhrase, titleMatches, useJobTitles, useStaffGroups, type JobTitle, type StaffGroup } from "@/lib/groups";
import { useUsers } from "@/lib/queries";
import { cn, errorMessage } from "@/lib/utils";

/**
 * People & roles → Groups: the teams forms can be limited to (Forms catalog →
 * a form → Who can see it). A role says what someone can do; a group says
 * which team they're on. People join a group from their job title (its
 * rules), or by hand; an admin can also take someone out.
 */
export function AdminGroups() {
  const { data: groups, isLoading } = useStaffGroups();
  const { data: titles } = useJobTitles();
  const [editing, setEditing] = useState<StaffGroup | "new" | null>(null);
  const open = editing === "new" ? null : groups?.find((g) => g.id === editing?.id) ?? null;

  return (
    <Page className="max-w-[1000px]">
      <PageHeader
        title="Groups"
        subtitle="Teams that forms can be limited to. People join a group from their job title, or you add them by hand."
        actions={
          <Button onClick={() => setEditing("new")}>
            <Plus className="h-4 w-4" /> Add a group
          </Button>
        }
      />
      {isLoading ? (
        <LoadingState />
      ) : !groups?.length ? (
        <EmptyState title="No groups yet" hint="Add one, then limit forms to it in Forms catalog." />
      ) : (
        <ul className="grid gap-3 md:grid-cols-2">
          {groups.map((g) => (
            <li key={g.id} className="flex">
              <button type="button" onClick={() => setEditing(g)} className="w-full text-left">
                <Card className="flex h-full flex-col gap-2 p-4 transition-colors hover:border-strongline hover:bg-rowhover">
                  <div className="flex items-center gap-2.5">
                    <span className="flex h-9 w-9 items-center justify-center rounded-[9px] bg-navsel text-accent dark:text-white">
                      <UsersRound className="h-[18px] w-[18px]" />
                    </span>
                    <span className="min-w-0 flex-1">
                      <span className="block text-[15px] font-bold text-ink">{g.name}</span>
                      <span className="block text-[12.5px] text-muted">
                        {g.members.length} {g.members.length === 1 ? "person" : "people"}
                        {g.members.some((m) => m.via === "added") && ` · ${g.members.filter((m) => m.via === "added").length} added by hand`}
                      </span>
                    </span>
                  </div>
                  {g.description && <p className="text-[13px] leading-snug text-muted">{g.description}</p>}
                  <PositionList titles={(titles ?? []).filter((t) => t.groupIds.includes(g.id))} className="mt-auto" />
                </Card>
              </button>
            </li>
          ))}
        </ul>
      )}
      {editing && <GroupDialog group={editing === "new" ? null : open} titles={titles ?? []} onClose={() => setEditing(null)} />}
    </Page>
  );
}

/** The positions in a group, as small pills; or a note that nobody joins from their title. */
function PositionList({ titles, className }: { titles: JobTitle[]; className?: string }) {
  if (!titles.length) return <p className={cn("text-[12px] leading-snug text-muted", className)}>No positions join it: people are added by hand.</p>;
  return (
    <div className={className}>
      <p className="mb-1 text-micro font-bold uppercase tracking-wide text-muted">Positions · {titles.length}</p>
      <ul className="flex flex-wrap gap-1">
        {titles.map((t) => (
          <li key={t.title} className="rounded-pill bg-subtle px-2 py-0.5 text-[12px] text-ink">
            {t.title}
            {t.people > 0 && <span className="ml-1 text-muted">· {t.people}</span>}
          </li>
        ))}
      </ul>
    </div>
  );
}

function GroupDialog({ group, titles, onClose }: { group: StaffGroup | null; titles: JobTitle[]; onClose: () => void }) {
  const qc = useQueryClient();
  const toast = useToast();
  const { data: users } = useUsers();
  const [name, setName] = useState(group?.name ?? "");
  const [description, setDescription] = useState(group?.description ?? "");
  const [rules, setRules] = useState((group?.rules ?? []).join("\n"));
  const [busy, setBusy] = useState(false);
  const [q, setQ] = useState("");

  const refresh = () => Promise.all([qc.invalidateQueries({ queryKey: GROUPS_KEY }), qc.invalidateQueries({ queryKey: ["admin", "users"] })]);

  async function save() {
    setBusy(true);
    try {
      const body = { name: name.trim(), description: description.trim(), rules: parseRules(rules) };
      if (group) await groupsApi.update(group.id, body);
      else await groupsApi.create(body);
      await refresh();
      toast(group ? "Group saved." : `Added “${body.name}”.`);
      onClose();
    } catch (e) {
      toast(errorMessage(e, "Couldn't save the group."), "error");
    } finally {
      setBusy(false);
    }
  }

  async function remove() {
    if (!group || !window.confirm(`Delete “${group.name}”? Forms limited to it lose it; a form left with nobody becomes open to everyone.`)) return;
    setBusy(true);
    try {
      const out = await groupsApi.remove(group.id);
      await refresh();
      toast(out.forms ? `Deleted. ${out.forms} form${out.forms === 1 ? " was" : "s were"} limited to it.` : "Group deleted.");
      onClose();
    } catch (e) {
      toast(errorMessage(e, "Couldn't delete the group."), "error");
    } finally {
      setBusy(false);
    }
  }

  async function setPerson(userId: string, include: boolean | null, done: string) {
    if (!group) return;
    try {
      await groupsApi.setPerson(group.id, userId, include);
      await refresh();
      toast(done);
    } catch (e) {
      toast(errorMessage(e, "Couldn't change that."), "error");
    }
  }

  const memberIds = useMemo(() => new Set(group?.members.map((m) => m.id)), [group]);
  const candidates = useMemo(() => {
    const words = q.trim().toLowerCase().split(/\s+/).filter(Boolean);
    if (!words.length) return [];
    return (users ?? [])
      .filter((u) => u.status === "active" || u.status === "invited")
      .filter((u) => !memberIds.has(u.id))
      .filter((u) => words.every((w) => `${u.name} ${u.email} ${u.title ?? ""}`.toLowerCase().includes(w)))
      .slice(0, 6);
  }, [users, q, memberIds]);

  const preview = parseRules(rules);

  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent aria-describedby={undefined} className="max-w-[640px]">
        <DialogHeader title={group ? group.name : "Add a group"} subtitle={group ? `${group.members.length} ${group.members.length === 1 ? "person" : "people"}` : undefined} />
        <form
          onSubmit={(e) => {
            e.preventDefault();
            void save();
          }}
        >
          <DialogBody className="grid max-h-[70vh] gap-4 overflow-y-auto">
            <Field label="Name">
              <Input value={name} onChange={(e) => setName(e.target.value)} maxLength={80} required autoFocus={!group} placeholder="e.g. HR" />
            </Field>
            <Field label="Description" hint="Optional. Shown to admins when they pick who can see a form.">
              <Input value={description} onChange={(e) => setDescription(e.target.value)} maxLength={255} />
            </Field>
            <Field
              label="Job titles that join this group"
              hint="One per line. A person whose job title (from Microsoft) contains any of these is in the group. Start a line with ^ to mean “starts with”."
            >
              <Textarea value={rules} onChange={(e) => setRules(e.target.value)} rows={4} placeholder={"human resources\nemployee relations\nonboarding"} />
            </Field>
            {preview.length > 0 && (
              <div className="-mt-2 grid gap-2">
                <p className="text-[12px] text-muted">Matches job titles with {rulesPhrase(preview)}.</p>
                <PositionList titles={titles.filter((t) => titleMatches(t.title, preview))} />
              </div>
            )}

            {group && (
              <div className="rounded-input border border-hairline">
                <div className="flex items-center justify-between gap-2 px-3 py-2.5">
                  <span className="text-[13.5px] font-semibold text-ink">People in it</span>
                  <span className="text-micro text-muted">Changes to people save straight away.</span>
                </div>
                <div className="border-t border-hairline px-3 py-2.5">
                  <SearchInput value={q} onChange={(e) => setQ(e.target.value)} placeholder="Add someone by name, email or title" aria-label="Find someone to add" />
                  {candidates.length > 0 && (
                    <ul className="mt-2">
                      {candidates.map((u) => (
                        <li key={u.id} className="flex items-center gap-2.5 py-1">
                          <Avatar name={u.name} color={u.avatarColor} />
                          <span className="min-w-0 flex-1">
                            <span className="block truncate text-[13px] font-semibold text-ink">{u.name}</span>
                            <span className="block truncate text-micro text-muted">{u.title || u.email}</span>
                          </span>
                          <Button
                            type="button"
                            size="sm"
                            variant="secondary"
                            onClick={() => {
                              setQ("");
                              void setPerson(u.id, group.removed.some((r) => r.id === u.id) ? null : true, `Added ${u.name}.`);
                            }}
                          >
                            <UserPlus className="h-3.5 w-3.5" /> Add
                          </Button>
                        </li>
                      ))}
                    </ul>
                  )}
                </div>
                {group.members.length === 0 ? (
                  <p className="border-t border-hairline px-3 py-2.5 text-[13px] text-muted">Nobody yet.</p>
                ) : (
                  <ul className="max-h-[260px] overflow-y-auto">
                    {group.members.map((m) => (
                      <li key={m.id} className="flex items-center gap-2.5 border-t border-hairline px-3 py-2">
                        <span className="min-w-0 flex-1">
                          <span className="block truncate text-[13px] font-semibold text-ink">{m.name}</span>
                          <span className="block truncate text-micro text-muted">{m.title || m.email}</span>
                        </span>
                        <Tag tone={m.via === "added" ? "accent" : "neutral"}>{m.via === "added" ? "Added by hand" : "From job title"}</Tag>
                        <Button
                          type="button"
                          size="sm"
                          variant="ghost"
                          aria-label={`Take ${m.name} out`}
                          title="Take them out of this group"
                          onClick={() => void setPerson(m.id, m.via === "added" ? null : false, `${m.name} is out of ${group.name}.`)}
                        >
                          <X className="h-4 w-4" />
                        </Button>
                      </li>
                    ))}
                  </ul>
                )}
                {group.removed.length > 0 && (
                  <>
                    <div className="border-t border-hairline bg-subtle px-3 py-2 text-micro font-bold uppercase tracking-wide text-muted">Taken out (their title matches)</div>
                    <ul>
                      {group.removed.map((m) => (
                        <li key={m.id} className="flex items-center gap-2.5 border-t border-hairline px-3 py-2">
                          <span className="min-w-0 flex-1">
                            <span className="block truncate text-[13px] text-muted">{m.name}</span>
                            <span className="block truncate text-micro text-muted">{m.title}</span>
                          </span>
                          <Button type="button" size="sm" variant="ghost" onClick={() => void setPerson(m.id, null, `${m.name} is back in ${group.name}.`)}>
                            <Undo2 className="h-3.5 w-3.5" /> Put back
                          </Button>
                        </li>
                      ))}
                    </ul>
                  </>
                )}
              </div>
            )}
          </DialogBody>
          <DialogFooter>
            {group && (
              <Button type="button" variant="outlineDanger" onClick={() => void remove()} disabled={busy} className="mr-auto">
                <Trash2 className="h-4 w-4" /> Delete
              </Button>
            )}
            <Button type="button" variant="secondary" onClick={onClose}>Cancel</Button>
            <Button type="submit" disabled={busy || !name.trim()}>{group ? "Save" : "Add group"}</Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
