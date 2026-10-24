import { useState } from "react";
import { ChevronDown, Plus, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { SearchInput } from "@/components/ui/input";
import type { JobTitle, StaffGroup } from "@/lib/groups";
import { cn } from "@/lib/utils";

/**
 * The pickers for who a form or a catalog category is open to: staff groups
 * (with the positions in each), positions (job titles) and named people. Used
 * by Forms catalog and by the form builder's Settings.
 */

/** Two or three choices as one row of buttons. */
export function Segmented<T extends string>({ value, options, onChange }: { value: T; options: [T, string][]; onChange: (v: T) => void }) {
  return (
    <div className="inline-flex rounded-input border border-hairline p-0.5" role="radiogroup">
      {options.map(([k, label]) => (
        <button
          key={k}
          type="button"
          role="radio"
          aria-checked={value === k}
          onClick={() => onChange(k)}
          className={cn("rounded-[5px] px-3 py-1.5 text-[13px] font-semibold", value === k ? "bg-navy text-white" : "text-muted hover:text-ink")}
        >
          {label}
        </button>
      ))}
    </div>
  );
}

/**
 * The groups a form can be limited to, each with the positions in it, so
 * it's clear who a tick takes in.
 */
export function GroupChecklist({ groups, titles, value, onChange }: { groups: StaffGroup[]; titles: JobTitle[]; value: string[]; onChange: (groupIds: string[]) => void }) {
  return (
    <ul className="max-h-[300px] divide-y divide-hairline overflow-y-auto rounded-input border border-hairline">
      {groups.map((g) => {
        const positions = titles.filter((t) => t.groupIds.includes(g.id)).map((t) => t.title);
        const on = value.includes(g.id);
        return (
          <li key={g.id}>
            <label className="flex cursor-pointer items-start gap-2.5 px-3 py-2.5 hover:bg-rowhover">
              <input type="checkbox" checked={on} onChange={() => onChange(on ? value.filter((v) => v !== g.id) : [...value, g.id])} className="mt-[3px]" />
              <span className="min-w-0 flex-1">
                <span className="block text-[13.5px] font-semibold text-ink">
                  {g.name}
                  <span className="ml-1.5 font-normal text-muted">
                    {g.members.length} {g.members.length === 1 ? "person" : "people"}
                  </span>
                </span>
                <span className="mt-0.5 block text-[12px] leading-snug text-muted">
                  {positions.length ? positions.join(" · ") : "No positions join it; people are added by hand."}
                </span>
              </span>
            </label>
          </li>
        );
      })}
    </ul>
  );
}

/**
 * Positions a form is open to: exact job titles (any case), on top of its
 * groups. Opens into Lantern's positions sorted under the groups they're in,
 * with a filter; a title nobody has yet can be typed in.
 */
export function PositionsDropdown({ groups, titles, value, onChange }: { groups: StaffGroup[]; titles: JobTitle[]; value: string[]; onChange: (titles: string[]) => void }) {
  const [open, setOpen] = useState(false);
  const [q, setQ] = useState("");
  const picked = new Set(value.map((v) => v.toLowerCase()));
  const toggle = (t: string) => (picked.has(t.toLowerCase()) ? onChange(value.filter((v) => v.toLowerCase() !== t.toLowerCase())) : onChange([...value, t]));
  const people = new Map(titles.map((t) => [t.title.toLowerCase(), t.people]));

  const words = q.trim().toLowerCase().split(/\s+/).filter(Boolean);
  const shown = titles.filter((t) => words.every((w) => t.title.toLowerCase().includes(w)));
  const sections = [
    ...groups.map((g) => ({ key: g.id, name: g.name, items: shown.filter((t) => t.groupIds.includes(g.id)) })),
    { key: "none", name: "Not in a group", items: shown.filter((t) => !t.groupIds.some((id) => groups.some((g) => g.id === id))) },
  ].filter((x) => x.items.length);
  const typed = q.trim();
  const canAddTyped = typed.length >= 2 && !picked.has(typed.toLowerCase()) && !titles.some((t) => t.title.toLowerCase() === typed.toLowerCase());

  return (
    <div className="mt-3">
      <button
        type="button"
        onClick={() => setOpen(!open)}
        aria-expanded={open}
        className="flex min-h-[40px] w-full items-center gap-2 rounded-input border border-hairline bg-surface px-3 text-left hover:border-strongline"
      >
        <span className="text-[13.5px] font-semibold text-ink">Positions</span>
        <span className="min-w-0 flex-1 truncate text-[13px] text-muted">
          {value.length ? `${value.length} picked` : "Any position (pick to limit it to job titles)"}
        </span>
        <ChevronDown className={cn("h-4 w-4 shrink-0 text-muted transition-transform", open && "rotate-180")} />
      </button>

      {value.length > 0 && (
        <div className="mt-2 flex flex-wrap gap-1.5">
          {value.map((t) => (
            <span key={t} className="flex items-center gap-1 rounded-pill bg-subtle py-0.5 pl-2.5 pr-1 text-[12.5px] font-semibold text-ink">
              {t}
              <span className="font-normal text-muted">· {people.get(t.toLowerCase()) ?? 0}</span>
              <button type="button" onClick={() => toggle(t)} aria-label={`Remove ${t}`} className="flex h-5 w-5 items-center justify-center rounded-full hover:bg-surface">
                <X className="h-3 w-3" />
              </button>
            </span>
          ))}
        </div>
      )}

      {open && (
        <div className="mt-2 overflow-hidden rounded-input border border-hairline bg-surface">
          <div className="border-b border-hairline p-2">
            <SearchInput
              value={q}
              onChange={(e) => setQ(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") {
                  e.preventDefault();
                  if (canAddTyped) {
                    toggle(typed);
                    setQ("");
                  }
                }
              }}
              placeholder="Filter positions"
              aria-label="Filter positions"
              autoFocus
            />
          </div>
          <div className="max-h-[380px] overflow-y-auto">
            {sections.map((sec) => (
              <section key={sec.key}>
                <p className="sticky top-0 z-[1] border-b border-hairline bg-subtle px-3 py-1.5 text-micro font-bold uppercase tracking-wide text-muted">
                  {sec.name} <span className="font-semibold normal-case tracking-normal">· {sec.items.length}</span>
                </p>
                <ul className="grid gap-x-4 px-3 py-1.5 sm:grid-cols-2">
                  {sec.items.map((t) => (
                    <li key={t.title}>
                      <label className="flex min-h-[34px] cursor-pointer items-start gap-2 py-1 text-[13px] text-ink">
                        <input type="checkbox" checked={picked.has(t.title.toLowerCase())} onChange={() => toggle(t.title)} className="mt-[3px]" />
                        <span className="min-w-0 flex-1 leading-snug">
                          {t.title}
                          {t.people > 0 && <span className="ml-1 text-muted">· {t.people}</span>}
                        </span>
                      </label>
                    </li>
                  ))}
                </ul>
              </section>
            ))}
            {!sections.length && !canAddTyped && <p className="px-3 py-3 text-[13px] text-muted">No positions match.</p>}
            {canAddTyped && (
              <button
                type="button"
                onClick={() => {
                  toggle(typed);
                  setQ("");
                }}
                className="flex w-full items-center gap-2 border-t border-hairline px-3 py-2.5 text-left hover:bg-rowhover"
              >
                <Plus className="h-4 w-4 text-muted" />
                <span className="min-w-0 flex-1 text-[13px] text-ink">Add “{typed}” as a position</span>
                <span className="text-micro text-muted">not on the list</span>
              </button>
            )}
          </div>
          <div className="flex items-center justify-between gap-2 border-t border-hairline px-3 py-2">
            <span className="text-micro text-muted">The number is how many people have that title now.</span>
            <span className="flex gap-1.5">
              {value.length > 0 && (
                <Button type="button" size="sm" variant="ghost" onClick={() => onChange([])}>
                  Clear
                </Button>
              )}
              <Button type="button" size="sm" variant="secondary" onClick={() => setOpen(false)}>
                Done
              </Button>
            </span>
          </div>
        </div>
      )}
    </div>
  );
}

/** Named people a form is open to, on top of its groups: chips, and a search to add more. */
export function PeoplePicker({ people, value, onChange }: {
  people: { id: string; name: string; email: string; title?: string | null; status: string }[];
  value: string[];
  onChange: (ids: string[]) => void;
}) {
  const [q, setQ] = useState("");
  const byId = new Map(people.map((p) => [p.id, p]));
  const words = q.trim().toLowerCase().split(/\s+/).filter(Boolean);
  const matches = words.length
    ? people
        .filter((p) => (p.status === "active" || p.status === "invited") && !value.includes(p.id))
        .filter((p) => words.every((w) => `${p.name} ${p.email} ${p.title ?? ""}`.toLowerCase().includes(w)))
        .slice(0, 5)
    : [];
  return (
    <div className="mt-2 rounded-input border border-hairline p-2">
      {value.length > 0 && (
        <div className="mb-2 flex flex-wrap gap-1.5">
          {value.map((id) => (
            <span key={id} className="flex items-center gap-1 rounded-pill bg-navsel py-0.5 pl-2.5 pr-1 text-[12.5px] font-semibold text-ink">
              {byId.get(id)?.name ?? "Someone who's gone"}
              <button type="button" onClick={() => onChange(value.filter((v) => v !== id))} aria-label={`Remove ${byId.get(id)?.name ?? "them"}`} className="flex h-5 w-5 items-center justify-center rounded-full hover:bg-surface">
                <X className="h-3 w-3" />
              </button>
            </span>
          ))}
        </div>
      )}
      <SearchInput value={q} onChange={(e) => setQ(e.target.value)} placeholder="Add a person by name, email or title" aria-label="Add a person" />
      {matches.length > 0 && (
        <ul className="mt-1">
          {matches.map((p) => (
            <li key={p.id}>
              <button
                type="button"
                onClick={() => {
                  onChange([...value, p.id]);
                  setQ("");
                }}
                className="flex w-full items-center gap-2 rounded-input px-2 py-1.5 text-left hover:bg-rowhover"
              >
                <span className="min-w-0 flex-1 truncate text-[13px] font-semibold text-ink">{p.name}</span>
                <span className="truncate text-micro text-muted">{p.title || p.email}</span>
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
