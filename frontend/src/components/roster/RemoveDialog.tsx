import { useEffect, useState } from "react";
import { ResponsiveDialog } from "@/components/ui/responsive-dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { useArchiveReasons } from "@/lib/queries";
import { cn } from "@/lib/utils";
import type { Tenant } from "@/lib/types";

/**
 * The confirmation every removal goes through — from a swipe, the roster or a
 * resident's page. A reason is required (it is what the audit trail and the
 * downstream systems act on), a note is optional, and nothing is deleted:
 * removal archives, and Undo / Restore bring the person straight back.
 *
 * Bottom sheet on a phone so the Remove button sits under the thumb; a dialog
 * on desktop.
 */
export function RemoveDialog({
  tenant,
  onCancel,
  onConfirm,
  busy,
}: {
  tenant: Tenant | null;
  onCancel: () => void;
  onConfirm: (reason: string, note: string) => void;
  busy?: boolean;
}) {
  const { data: reasons } = useArchiveReasons();
  const [reason, setReason] = useState("Moved out");
  const [note, setNote] = useState("");

  useEffect(() => {
    if (tenant) {
      setReason("Moved out");
      setNote("");
    }
  }, [tenant]);

  const title = tenant ? `Remove ${tenant.displayName}?` : "Remove";
  const where = tenant ? [tenant.unit && `Unit ${tenant.unit}`, tenant.site?.name].filter(Boolean).join(" · ") : "";

  const body = (
    <>
      <p className="text-[13px] text-muted">
        {where ? `${where}. ` : ""}They'll come off the active roster and out of every form's resident list. You can undo this.
      </p>
      <p className="kicker mb-2 mt-4">Reason</p>
      <div className="flex flex-wrap gap-2" role="radiogroup" aria-label="Reason">
        {(reasons ?? ["Moved out", "Transferred", "Other"]).map((r) => (
          <button
            key={r}
            type="button"
            role="radio"
            aria-checked={reason === r}
            onClick={() => setReason(r)}
            className={cn(
              "min-h-[40px] rounded-pill border px-3.5 text-[13.5px] font-semibold transition-colors",
              reason === r ? "border-navy bg-navsel text-accent dark:text-white" : "border-hairline text-ink hover:bg-rowhover"
            )}
          >
            {r}
          </button>
        ))}
      </div>
      <Input
        className="mt-3 min-h-[44px]"
        placeholder={reason === "Other" ? "What happened? (required)" : "Note (optional) — e.g. moved to Laurel Hall"}
        value={note}
        onChange={(e) => setNote(e.target.value)}
        maxLength={500}
      />
    </>
  );

  const valid = reason !== "Other" || note.trim().length > 0;
  const actions = (
    <>
      <Button variant="secondary" onClick={onCancel} className="min-h-[48px] flex-1 md:h-9 md:min-h-0 md:flex-none">
        Cancel
      </Button>
      <Button
        variant="danger"
        disabled={!valid || busy}
        onClick={() => onConfirm(reason, note.trim())}
        className="min-h-[48px] flex-1 md:h-9 md:min-h-0 md:flex-none"
      >
        {busy ? "Removing…" : "Remove from roster"}
      </Button>
    </>
  );

  return (
    <ResponsiveDialog open={Boolean(tenant)} onOpenChange={(o) => !o && onCancel()} title={title} footer={actions}>
      {body}
    </ResponsiveDialog>
  );
}
