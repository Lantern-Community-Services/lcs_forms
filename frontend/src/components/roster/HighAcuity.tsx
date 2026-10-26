import { Checkbox } from "@/components/ui/checkbox";
import { HelpTip } from "@/components/ui/help-tip";
import { cn } from "@/lib/utils";

export const HIGH_ACUITY_HELP =
  "High Acuity means this tenant has elevated needs and requires more attention than usual, such as more frequent check-ins, closer case management or extra support from staff. Check the box to flag them on the tenant list; uncheck it to clear the flag.";

/** The High Acuity checkbox, with its "?" explanation. Used when adding someone and on their page. */
export function HighAcuityToggle({ checked, onChange, disabled, className }: {
  checked: boolean;
  onChange: (next: boolean) => void;
  disabled?: boolean;
  className?: string;
}) {
  return (
    <div className={cn("flex min-h-[44px] items-center gap-2.5 md:min-h-9", className)}>
      <label className="flex cursor-pointer items-center gap-2.5 text-[13.5px] font-semibold text-ink">
        <Checkbox checked={checked} onCheckedChange={(v) => onChange(v === true)} disabled={disabled} className="h-5 w-5" />
        High Acuity
      </label>
      <HelpTip label="What does High Acuity mean?">{HIGH_ACUITY_HELP}</HelpTip>
    </div>
  );
}

/** The flag on a roster row. */
export function HighAcuityFlag({ className }: { className?: string }) {
  return (
    <span
      title="High Acuity"
      className={cn("shrink-0 rounded-pill bg-status-redBg px-1.5 py-px text-[10.5px] font-bold uppercase tracking-[0.03em] text-status-redText", className)}
    >
      High Acuity
    </span>
  );
}
