import { useEffect, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Button } from "@/components/ui/button";
import { CheckboxList } from "@/components/ui/checkbox";
import { Switch } from "@/components/ui/switch";
import { useToast } from "@/components/ui/toast";
import { GroupChecklist, PeoplePicker, PositionsDropdown, Segmented } from "@/components/AccessPickers";
import { api } from "@/lib/api";
import { useJobTitles, useStaffGroups } from "@/lib/groups";
import { useRoles, useUsers } from "@/lib/queries";
import { cn, errorMessage, relativeTime } from "@/lib/utils";

/**
 * A form's "Who sees entries" (backend services/staffGroups.ts entryReach),
 * for both kinds of form, in each one's editor. Saved straight away, not with
 * Publish. A form saved before this setting shows its old readers until
 * someone reviews it.
 */

export type EntryMode = "own" | "site" | "everyone";

export interface EntryAccess {
  mode: EntryMode;
  seeAll: { groupIds: string[]; titles: string[]; userIds: string[]; roles: string[] };
  notified: boolean;
}

interface EntryAccessView {
  form: { id: string; slug: string; title: string; kind: string };
  access: EntryAccess | null;
  legacyReaders: string[];
  updatedByName: string | null;
  updatedAt: string | null;
}

const EMPTY = { groupIds: [], titles: [], userIds: [], roles: [] };

export const entryAccessKey = (formId: string) => ["forms", "entry-access", formId];

export function WhoSeesEntries({ formId, className }: { formId: string; className?: string }) {
  const qc = useQueryClient();
  const toast = useToast();
  const { data } = useQuery({ queryKey: entryAccessKey(formId), queryFn: () => api.get<EntryAccessView>(`/forms/built/${formId}/entry-access`) });
  const { data: groups } = useStaffGroups();
  const { data: titles } = useJobTitles();
  const { data: people } = useUsers();
  const { data: allRoles } = useRoles();
  const roles = (allRoles ?? []).filter((r) => r.key !== "admin").map((r) => ({ value: r.key, label: r.name }));
  const roleName = (k: string) => allRoles?.find((r) => r.key === k)?.name ?? k;
  const [draft, setDraft] = useState<EntryAccess | null>(null);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    if (data) setDraft(data.access);
  }, [data]);
  if (!data) return null;

  const legacy = !data.access;
  const changed = JSON.stringify(draft) !== JSON.stringify(data.access);

  async function save() {
    if (!draft) return;
    setBusy(true);
    try {
      await api.put(`/forms/built/${formId}/entry-access`, draft);
      await qc.invalidateQueries({ queryKey: entryAccessKey(formId) });
      await qc.invalidateQueries({ queryKey: ["forms", "entry-access-review"] });
      toast("Saved: it applies to this form's entries now.");
    } catch (e) {
      toast(errorMessage(e, "Couldn't save who sees entries."), "error");
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className={cn("space-y-3", className)}>
      {legacy && !draft && (
        <div className="rounded-input bg-status-amberBg px-3 py-2.5 text-[12.5px] leading-snug text-status-amberText">
          <p>
            This form still uses its old rule: <b>{data.legacyReaders.filter((k) => allRoles?.some((r) => r.key === k)).map(roleName).join(", ") || "only Admins"}</b> see every entry, and everyone else sees only their own.
            Review it to choose who sees what.
          </p>
          <Button
            type="button"
            size="sm"
            variant="secondary"
            className="mt-2"
            onClick={() => setDraft({ mode: "own", seeAll: { ...EMPTY, roles: data.legacyReaders.filter((r) => roles.some((x) => x.value === r)) }, notified: true })}
          >
            Review who sees entries
          </Button>
        </div>
      )}
      {draft && (
        <>
          <div>
            <p className="mb-1.5 text-[12.5px] font-semibold text-ink">Everyone who can open the form sees</p>
            <Segmented
              value={draft.mode}
              options={[["own", "Only their own"], ["site", "Their sites' entries"], ["everyone", "Every entry"]]}
              onChange={(mode) => setDraft({ ...draft, mode })}
            />
            <p className="mt-1.5 text-[12px] text-muted">
              {draft.mode === "own"
                ? "Each person sees the entries they filed, and nobody else's."
                : draft.mode === "site"
                  ? "Each person sees the entries for the sites they work at, and their own."
                  : "Everyone who can open the form sees every entry (people who work at some sites, only theirs)."}
            </p>
          </div>
          <div className="space-y-2">
            <p className="text-[12.5px] font-semibold text-ink">These people see every entry</p>
            {groups?.length ? <GroupChecklist groups={groups} titles={titles ?? []} value={draft.seeAll.groupIds} onChange={(groupIds) => setDraft({ ...draft, seeAll: { ...draft.seeAll, groupIds } })} /> : null}
            <PositionsDropdown groups={groups ?? []} titles={titles ?? []} value={draft.seeAll.titles} onChange={(t) => setDraft({ ...draft, seeAll: { ...draft.seeAll, titles: t } })} />
            <PeoplePicker people={people ?? []} value={draft.seeAll.userIds} onChange={(userIds) => setDraft({ ...draft, seeAll: { ...draft.seeAll, userIds } })} />
            <div>
              <p className="mb-1 text-[12px] text-muted">Roles</p>
              <CheckboxList options={roles} value={draft.seeAll.roles} onChange={(r) => setDraft({ ...draft, seeAll: { ...draft.seeAll, roles: r } })} />
            </div>
          </div>
          <label className="flex items-start gap-2 text-[13px] text-ink">
            <Switch checked={draft.notified} onCheckedChange={(notified) => setDraft({ ...draft, notified })} className="mt-0.5" />
            <span>
              People this form notifies can open the entries they're told about
              <span className="block text-[12px] text-muted">So the links in its emails and follow-ups work for the people they go to.</span>
            </span>
          </label>
          <p className="text-[12px] text-muted">Admins always see every entry. Only people who see every entry can export or void them.</p>
        </>
      )}
      {(changed || (draft && legacy)) && (
        <div className="flex items-center justify-end gap-2">
          <Button type="button" variant="secondary" size="sm" onClick={() => setDraft(data.access)} disabled={busy}>Undo</Button>
          <Button type="button" size="sm" onClick={() => void save()} disabled={busy || !draft}>{busy ? "Saving…" : "Save who sees entries"}</Button>
        </div>
      )}
      {!legacy && !changed && data.updatedAt && <p className="text-[12px] text-muted">Changed {relativeTime(data.updatedAt)}{data.updatedByName ? ` by ${data.updatedByName}` : ""}.</p>}
    </section>
  );
}
