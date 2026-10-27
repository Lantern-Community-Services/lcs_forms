import { useMemo, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { SearchInput } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { LoadingState } from "@/components/ui/misc";
import { useToast } from "@/components/ui/toast";
import { GROUPS_KEY, groupsApi, personFormsKey, useCatalogFormOptions, usePersonForms, useStaffGroups, type StaffGroup } from "@/lib/groups";
import { errorMessage } from "@/lib/utils";

/**
 * Giving forms to groups and to one person (backend services/staffGroups.ts).
 * Once any of someone's groups has forms, those are the only forms they see;
 * one person can then be given more, or have some hidden, whatever their
 * groups say. Someone whose groups have no forms sees every form open to them.
 * Admins and the see-everything groups always see every form.
 */

/** Rows by catalog category, in the catalog's order, matching every word typed. */
function byCategory<T extends { title: string; category: string }>(rows: T[], q: string): [string, T[]][] {
  const words = q.trim().toLowerCase().split(/\s+/).filter(Boolean);
  const out = new Map<string, T[]>();
  for (const r of rows) {
    if (!words.every((w) => `${r.title} ${r.category}`.toLowerCase().includes(w))) continue;
    out.set(r.category, [...(out.get(r.category) ?? []), r]);
  }
  return [...out];
}

/** People & roles → Groups → a group → Forms: the forms its members see. Saves with its own button. */
export function GroupFormsSection({ group }: { group: StaffGroup }) {
  const qc = useQueryClient();
  const toast = useToast();
  const [editing, setEditing] = useState<string[] | null>(null);
  const [q, setQ] = useState("");
  const [busy, setBusy] = useState(false);
  const { data: options, isLoading } = useCatalogFormOptions();
  const titleOf = useMemo(() => new Map((options ?? []).map((o) => [o.key, o.title])), [options]);
  const given = group.forms;

  async function save() {
    if (!editing) return;
    setBusy(true);
    try {
      await groupsApi.setForms(group.id, editing);
      await Promise.all([qc.invalidateQueries({ queryKey: GROUPS_KEY }), qc.invalidateQueries({ queryKey: ["admin", "groups", "person-forms"] })]);
      toast(editing.length ? `${group.name} now sees ${editing.length} form${editing.length === 1 ? "" : "s"}.` : `${group.name} sees every form open to them again.`);
      setEditing(null);
      setQ("");
    } catch (e) {
      toast(errorMessage(e, "Couldn't save the forms."), "error");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="rounded-input border border-hairline">
      <div className="flex items-start gap-2 px-3 py-2.5">
        <span className="min-w-0 flex-1">
          <span className="block text-[13.5px] font-semibold text-ink">Forms</span>
          <span className="block text-micro text-muted">
            {given.length
              ? `Its members see only these ${given.length} form${given.length === 1 ? "" : "s"}, and any given to their other groups or to them.`
              : "None given: its members see every form open to them. Give it forms and they'll see only those."}
          </span>
        </span>
        {!editing && (
          <Button type="button" size="sm" variant="secondary" onClick={() => setEditing(given)}>
            {given.length ? "Change" : "Give forms"}
          </Button>
        )}
      </div>
      {!editing ? (
        given.length > 0 && (
          <ul className="flex flex-wrap gap-1 border-t border-hairline px-3 py-2.5">
            {given.map((k) => (
              <li key={k} className="rounded-pill bg-subtle px-2 py-0.5 text-[12px] text-ink">
                {titleOf.get(k) ?? "A form no longer on the catalog"}
              </li>
            ))}
          </ul>
        )
      ) : isLoading ? (
        <LoadingState />
      ) : (
        <div className="border-t border-hairline px-3 py-2.5">
          <SearchInput value={q} onChange={(e) => setQ(e.target.value)} placeholder="Find a form" aria-label="Find a form" />
          <div className="mt-2 max-h-[300px] overflow-y-auto">
            {byCategory(options ?? [], q).map(([category, rows]) => (
              <div key={category} className="mb-1.5">
                <p className="py-1 text-micro font-bold uppercase tracking-wide text-muted">{category}</p>
                {rows.map((o) => (
                  <label key={o.key} className="flex min-h-[32px] cursor-pointer items-center gap-2 rounded-[6px] px-1 text-[13px] text-ink hover:bg-rowhover">
                    <input
                      type="checkbox"
                      checked={editing.includes(o.key)}
                      onChange={(e) => setEditing(e.target.checked ? [...editing, o.key] : editing.filter((k) => k !== o.key))}
                    />
                    <span className="min-w-0 flex-1 truncate">{o.title}</span>
                    {!o.active && <span className="text-micro text-muted">hidden from catalog</span>}
                  </label>
                ))}
              </div>
            ))}
          </div>
          <div className="mt-2 flex items-center gap-2">
            <span className="mr-auto text-micro text-muted">{editing.length} chosen</span>
            <Button type="button" size="sm" variant="secondary" onClick={() => setEditing(null)} disabled={busy}>
              Cancel
            </Button>
            <Button type="button" size="sm" onClick={() => void save()} disabled={busy}>
              Save forms
            </Button>
          </div>
        </div>
      )}
    </div>
  );
}

/**
 * People & roles → a person → Forms: what they see, and why, with their own
 * changes over their groups. Ticking a form their groups don't give them gives
 * it to them; unticking one they'd see hides it. Saves straight away. Admins only.
 */
export function PersonForms({ userId, name }: { userId: string; name: string }) {
  const qc = useQueryClient();
  const toast = useToast();
  const { data, isLoading } = usePersonForms(userId);
  const { data: groups } = useStaffGroups();
  const [q, setQ] = useState("");
  const [busy, setBusy] = useState(false);
  const first = name.split(" ")[0];
  const groupName = useMemo(() => new Map((groups ?? []).map((g) => [g.id, g.name])), [groups]);

  if (isLoading || !data) return null;

  if (data.seesAll) {
    return (
      <div className="rounded-input border border-hairline px-3 py-2.5">
        <span className="block text-[13.5px] font-semibold text-ink">Forms</span>
        <span className="block text-micro text-muted">{first} sees every form, like Admins, whatever is given to their groups.</span>
      </div>
    );
  }

  const changed = data.forms.filter((f) => f.own !== null).length;

  async function toggle(key: string, on: boolean, title: string) {
    const f = data!.forms.find((x) => x.key === key)!;
    // Back to what their groups say when that matches; otherwise their own change.
    const own = on === f.fromGroups ? null : on;
    const added = data!.forms.filter((x) => (x.key === key ? own === true : x.own === true)).map((x) => x.key);
    const hidden = data!.forms.filter((x) => (x.key === key ? own === false : x.own === false)).map((x) => x.key);
    setBusy(true);
    try {
      await groupsApi.setPersonForms(userId, added, hidden);
      await qc.invalidateQueries({ queryKey: personFormsKey(userId) });
      toast(on ? `${first} sees “${title}”.` : `“${title}” is hidden from ${first}.`);
    } catch (e) {
      toast(errorMessage(e, "Couldn't change that."), "error");
    } finally {
      setBusy(false);
    }
  }

  async function resetAll() {
    setBusy(true);
    try {
      await groupsApi.setPersonForms(userId, [], []);
      await qc.invalidateQueries({ queryKey: personFormsKey(userId) });
      toast(`${first} sees what their groups give them.`);
    } catch (e) {
      toast(errorMessage(e, "Couldn't change that."), "error");
    } finally {
      setBusy(false);
    }
  }

  function why(f: PersonFormRow): string | null {
    if (f.own === true) return "given to them";
    if (f.own === false) return "hidden from them";
    if (f.groups.length) return `from ${f.groups.map((g) => groupName.get(g) ?? "a group").join(", ")}`;
    if (f.fromGroups) return data!.limited ? "names them" : null;
    return data!.limited ? null : "limited to others";
  }

  return (
    <div className="rounded-input border border-hairline">
      <div className="flex items-start gap-2 px-3 py-2.5">
        <span className="min-w-0 flex-1">
          <span className="block text-[13.5px] font-semibold text-ink">Forms</span>
          <span className="block text-micro text-muted">
            {data.limited
              ? `Their groups have forms, so ${first} sees only those. Tick more to give them, or untick to hide one.`
              : `Their groups have no forms, so ${first} sees every form open to them. Untick to hide one, or tick a limited one to give it.`}{" "}
            Saves straight away.
          </span>
        </span>
        {changed > 0 && (
          <Button type="button" size="sm" variant="ghost" onClick={() => void resetAll()} disabled={busy} title="Remove every form given to or hidden from them">
            Reset {changed}
          </Button>
        )}
      </div>
      <div className="border-t border-hairline px-3 py-2.5">
        <SearchInput value={q} onChange={(e) => setQ(e.target.value)} placeholder="Find a form" aria-label="Find a form" />
        <div className="mt-2 max-h-[300px] overflow-y-auto">
          {byCategory(data.forms, q).map(([category, rows]) => (
            <div key={category} className="mb-1.5">
              <p className="py-1 text-micro font-bold uppercase tracking-wide text-muted">{category}</p>
              {rows.map((f) => {
                const on = f.own ?? f.fromGroups;
                const note = f.roleOk ? why(f) : "for other roles";
                return (
                  <label key={f.key} className="flex min-h-[32px] cursor-pointer items-center gap-2 rounded-[6px] px-1 text-[13px] text-ink hover:bg-rowhover">
                    <input type="checkbox" checked={on && f.roleOk} disabled={busy || !f.roleOk} onChange={(e) => void toggle(f.key, e.target.checked, f.title)} />
                    <span className={on && f.roleOk ? "min-w-0 flex-1 truncate" : "min-w-0 flex-1 truncate text-muted"}>{f.title}</span>
                    {note && <span className={f.own !== null ? "text-micro font-semibold text-accent dark:text-white" : "text-micro text-muted"}>{note}</span>}
                  </label>
                );
              })}
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

type PersonFormRow = NonNullable<ReturnType<typeof usePersonForms>["data"]>["forms"][number];
