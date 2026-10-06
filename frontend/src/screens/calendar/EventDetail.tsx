import { useEffect, useState } from "react";
import { AlignLeft, Building2, MapPin, Pencil, Repeat, Tag as TagIcon, Trash2 } from "lucide-react";
import { ResponsiveDialog } from "@/components/ui/responsive-dialog";
import { Button } from "@/components/ui/button";
import { relativeDayName, whenText } from "@/lib/calendar";
import type { CalendarOccurrence, CalendarScope } from "@/lib/types";
import { cn } from "@/lib/utils";
import { colorOf, type ColorOf } from "./colors";

/**
 * One occurrence: when, how it repeats, who it's for, where, and the notes.
 * Edit and Delete show when the server says this person may change it (an
 * Admin, or a calendar editor at all of its sites); for a repeating event both
 * ask which of its occurrences they mean first.
 */
export function EventDetail({
  occ, today, colors, onClose, onEdit, onDelete,
}: {
  occ: CalendarOccurrence | null;
  today: string;
  colors: ColorOf;
  onClose: () => void;
  onEdit: (o: CalendarOccurrence) => void;
  onDelete: (o: CalendarOccurrence) => void;
}) {
  const color = occ ? colorOf(colors, occ.categoryId) : null;
  const relative = occ ? relativeDayName(occ.startDate, today) : null;
  return (
    <ResponsiveDialog
      open={Boolean(occ)}
      onOpenChange={(open) => !open && onClose()}
      title={occ?.title ?? ""}
      footer={
        occ?.canEdit ? (
          <>
            <Button variant="outlineDanger" onClick={() => onDelete(occ)} className="min-h-[44px] flex-1 md:min-h-0 md:flex-none">
              <Trash2 className="h-4 w-4" /> Delete
            </Button>
            <Button onClick={() => onEdit(occ)} className="min-h-[44px] flex-1 md:min-h-0 md:flex-none">
              <Pencil className="h-4 w-4" /> Edit
            </Button>
          </>
        ) : undefined
      }
    >
      {occ && color && (
        <div className="space-y-3.5 pb-1 text-[14px] text-ink">
          <div className="flex items-start gap-3">
            <span className="mt-1 h-3.5 w-3.5 shrink-0 rounded-[4px]" style={{ background: color.solid }} />
            <div>
              <p className="font-semibold">{whenText(occ)}</p>
              {relative && <p className="text-[12.5px] text-muted">{relative}</p>}
            </div>
          </div>
          {occ.repeats && (
            <Row icon={<Repeat className="h-4 w-4" />}>
              {occ.repeatText}
              {occ.changed && <span className="mt-0.5 block text-[12.5px] text-muted">This one was changed on its own.</span>}
            </Row>
          )}
          <Row icon={<Building2 className="h-4 w-4" />}>{occ.allSites ? "Every site" : occ.sites.map((s) => s.name).join(", ")}</Row>
          {color.name && <Row icon={<TagIcon className="h-4 w-4" />}>{color.name}</Row>}
          {occ.location && <Row icon={<MapPin className="h-4 w-4" />}>{occ.location}</Row>}
          {occ.description && (
            <Row icon={<AlignLeft className="h-4 w-4" />}>
              <span className="whitespace-pre-wrap break-words">{occ.description}</span>
            </Row>
          )}
        </div>
      )}
    </ResponsiveDialog>
  );
}

function Row({ icon, children }: { icon: React.ReactNode; children: React.ReactNode }) {
  return (
    <div className="flex items-start gap-3">
      <span className="mt-0.5 shrink-0 text-muted">{icon}</span>
      <div className="min-w-0 flex-1">{children}</div>
    </div>
  );
}

const SCOPES: { value: CalendarScope; label: string; hint: string }[] = [
  { value: "this", label: "This event", hint: "Only this day. The rest of the series stays as it is." },
  { value: "following", label: "This and following events", hint: "From this day on. Earlier ones stay as they are." },
  { value: "all", label: "All events", hint: "Every day in the series, past and future." },
];

/** Which occurrences of a repeating event an edit or a delete is for. */
export function ScopeDialog({
  action, onClose, onPick,
}: {
  /** Open while set. */
  action: "edit" | "delete" | null;
  onClose: () => void;
  onPick: (scope: CalendarScope) => void;
}) {
  const [scope, setScope] = useState<CalendarScope>("this");
  // Each time it opens, it starts on the narrowest choice.
  useEffect(() => {
    if (action) setScope("this");
  }, [action]);
  return (
    <ResponsiveDialog
      open={action !== null}
      onOpenChange={(open) => !open && onClose()}
      title={action === "delete" ? "Delete a repeating event" : "Edit a repeating event"}
      dialogClassName="w-[min(440px,calc(100vw-2rem))]"
      footer={
        <>
          <Button variant="secondary" onClick={onClose} className="min-h-[44px] flex-1 md:min-h-0 md:flex-none">Cancel</Button>
          <Button variant={action === "delete" ? "danger" : "primary"} onClick={() => onPick(scope)} className="min-h-[44px] flex-1 md:min-h-0 md:flex-none">
            {action === "delete" ? "Delete" : "Continue"}
          </Button>
        </>
      }
    >
      <div role="radiogroup" className="space-y-2">
        {SCOPES.map((s) => (
          <button
            key={s.value}
            type="button"
            role="radio"
            aria-checked={scope === s.value}
            onClick={() => setScope(s.value)}
            className={cn(
              "flex w-full items-start gap-3 rounded-input border px-3 py-2.5 text-left transition-colors",
              scope === s.value ? "border-navy bg-navsel/60 dark:border-white/60" : "border-hairline hover:bg-rowhover"
            )}
          >
            <span className={cn("mt-0.5 flex h-4 w-4 shrink-0 items-center justify-center rounded-full border-2", scope === s.value ? "border-navy dark:border-white" : "border-strongline")}>
              {scope === s.value && <span className="h-2 w-2 rounded-full bg-navy dark:bg-white" />}
            </span>
            <span>
              <span className="block text-[14px] font-semibold text-ink">{s.label}</span>
              <span className="block text-[12.5px] text-muted">{s.hint}</span>
            </span>
          </button>
        ))}
      </div>
    </ResponsiveDialog>
  );
}
