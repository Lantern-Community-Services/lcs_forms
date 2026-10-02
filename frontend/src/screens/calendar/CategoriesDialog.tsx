import { useEffect, useState } from "react";
import { ArrowDown, ArrowUp, Check, Plus, Trash2 } from "lucide-react";
import { ResponsiveDialog } from "@/components/ui/responsive-dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { useToast } from "@/components/ui/toast";
import { calendarApi, useCalendarCategories, useCalendarMutation } from "@/lib/queries";
import { categoryColor } from "@/lib/calendar";
import type { CalendarCategory } from "@/lib/types";
import { cn, errorMessage } from "@/lib/utils";

const SLOTS = [0, 1, 2, 3, 4, 5, 6, 7];

/**
 * The kinds of events and their colors. Colors come from the app's chart
 * palette, which is checked to stay apart for people with color blindness, so
 * there are eight to pick from rather than any color at all. Changes save as
 * they're made.
 */
export function CategoriesDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const toast = useToast();
  const { data: categories } = useCalendarCategories();
  const list = categories ?? [];
  const [name, setName] = useState("");
  const [slot, setSlot] = useState(0);
  const onError = (e: unknown) => toast(errorMessage(e, "Couldn't save. Try again."), "error");

  const create = useCalendarMutation((body: { name: string; colorSlot: number }) => calendarApi.createCategory(body));
  const update = useCalendarMutation(({ id, ...body }: { id: string; name?: string; colorSlot?: number }) => calendarApi.updateCategory(id, body));
  const remove = useCalendarMutation((id: string) => calendarApi.removeCategory(id));
  const reorder = useCalendarMutation((ids: string[]) => calendarApi.reorderCategories(ids));

  // A new category starts on the first color nobody has yet.
  useEffect(() => {
    if (!open) return;
    const used = new Set(list.map((c) => c.colorSlot));
    setSlot(SLOTS.find((s) => !used.has(s)) ?? 0);
  }, [open, list.length]); // eslint-disable-line react-hooks/exhaustive-deps

  const move = (i: number, dir: -1 | 1) => {
    const ids = list.map((c) => c.id);
    const j = i + dir;
    if (j < 0 || j >= ids.length) return;
    [ids[i], ids[j]] = [ids[j], ids[i]];
    reorder.mutate(ids, { onError });
  };

  const add = () => {
    const trimmed = name.trim();
    if (!trimmed) return;
    create.mutate({ name: trimmed, colorSlot: slot }, { onSuccess: () => setName(""), onError });
  };

  const del = (c: CalendarCategory) => {
    const used = c.eventCount > 0 ? ` ${c.eventCount} ${c.eventCount === 1 ? "event keeps" : "events keep"} their place on the calendar, with no category.` : "";
    if (!window.confirm(`Delete the category “${c.name}”?${used}`)) return;
    remove.mutate(c.id, { onError });
  };

  return (
    <ResponsiveDialog
      open={open}
      onOpenChange={(o) => !o && onClose()}
      title="Event categories"
      dialogClassName="w-[min(560px,calc(100vw-2rem))]"
      dialogBodyClassName="max-h-[min(70vh,640px)] overflow-y-auto scroll-thin"
      footer={<Button onClick={onClose} className="min-h-[48px] flex-1 md:min-h-0 md:flex-none">Done</Button>}
    >
      <div className="space-y-4">
        <ul className="divide-y divide-hairline overflow-hidden rounded-card border border-hairline">
          {list.map((c, i) => (
            <li key={c.id} className="space-y-2 px-3 py-2.5">
              <div className="flex items-center gap-2">
                <NameInput category={c} onSave={(n) => update.mutate({ id: c.id, name: n }, { onError })} />
                <span className="shrink-0 text-micro tabular text-muted">{c.eventCount} {c.eventCount === 1 ? "event" : "events"}</span>
                <IconButton label="Move up" disabled={i === 0} onClick={() => move(i, -1)}><ArrowUp className="h-4 w-4" /></IconButton>
                <IconButton label="Move down" disabled={i === list.length - 1} onClick={() => move(i, 1)}><ArrowDown className="h-4 w-4" /></IconButton>
                <IconButton label={`Delete ${c.name}`} onClick={() => del(c)} danger><Trash2 className="h-4 w-4" /></IconButton>
              </div>
              <Swatches value={c.colorSlot} onChange={(colorSlot) => update.mutate({ id: c.id, colorSlot }, { onError })} />
            </li>
          ))}
          {list.length === 0 && <li className="px-3 py-4 text-center text-[13px] text-muted">No categories. Events can still go on the calendar without one.</li>}
        </ul>

        <div className="space-y-2 rounded-card border border-dashed border-hairline p-3">
          <p className="text-[12px] font-semibold text-muted">Add a category</p>
          <div className="flex gap-2">
            <Input value={name} onChange={(e) => setName(e.target.value)} onKeyDown={(e) => e.key === "Enter" && add()} placeholder="e.g. Fire drill" maxLength={60} className="min-h-[44px] md:min-h-9" />
            <Button onClick={add} disabled={!name.trim() || create.isPending} className="min-h-[44px] shrink-0 md:min-h-9">
              <Plus className="h-4 w-4" /> Add
            </Button>
          </div>
          <Swatches value={slot} onChange={setSlot} />
        </div>
      </div>
    </ResponsiveDialog>
  );
}

function NameInput({ category, onSave }: { category: CalendarCategory; onSave: (name: string) => void }) {
  const [value, setValue] = useState(category.name);
  useEffect(() => setValue(category.name), [category.name]);
  const commit = () => {
    const trimmed = value.trim();
    if (!trimmed) return setValue(category.name);
    if (trimmed !== category.name) onSave(trimmed);
  };
  return (
    <Input
      value={value}
      onChange={(e) => setValue(e.target.value)}
      onBlur={commit}
      onKeyDown={(e) => e.key === "Enter" && (e.currentTarget as HTMLInputElement).blur()}
      aria-label="Category name"
      maxLength={60}
      className="min-h-[40px] min-w-0 flex-1 font-semibold md:min-h-9"
    />
  );
}

function Swatches({ value, onChange }: { value: number; onChange: (slot: number) => void }) {
  return (
    <div role="radiogroup" aria-label="Color" className="flex flex-wrap gap-1.5">
      {SLOTS.map((s) => (
        <button
          key={s}
          type="button"
          role="radio"
          aria-checked={value === s}
          aria-label={`Color ${s + 1}`}
          onClick={() => onChange(s)}
          className={cn("flex h-8 w-8 items-center justify-center rounded-full ring-offset-2 ring-offset-surface transition-shadow", value === s && "ring-2 ring-navy dark:ring-white")}
          style={{ background: categoryColor(s) }}
        >
          {value === s && <Check className="h-4 w-4 text-white" strokeWidth={3} />}
        </button>
      ))}
    </div>
  );
}

function IconButton({ label, onClick, disabled, danger, children }: { label: string; onClick: () => void; disabled?: boolean; danger?: boolean; children: React.ReactNode }) {
  return (
    <button
      type="button"
      title={label}
      aria-label={label}
      disabled={disabled}
      onClick={onClick}
      className={cn("flex h-9 w-9 shrink-0 items-center justify-center rounded-input text-muted hover:bg-rowhover disabled:opacity-30", danger ? "hover:text-status-redText" : "hover:text-ink")}
    >
      {children}
    </button>
  );
}
