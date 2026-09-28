import * as CheckboxPrimitive from "@radix-ui/react-checkbox";
import { Check } from "lucide-react";
import { forwardRef } from "react";
import { cn } from "@/lib/utils";
import type { SelectOption } from "./select";

export const Checkbox = forwardRef<
  React.ElementRef<typeof CheckboxPrimitive.Root>,
  React.ComponentPropsWithoutRef<typeof CheckboxPrimitive.Root>
>(({ className, ...props }, ref) => (
  <CheckboxPrimitive.Root
    ref={ref}
    className={cn(
      "peer h-4 w-4 shrink-0 rounded-[4px] border border-strongline bg-surface",
      "focus-visible:outline focus-visible:outline-2 focus-visible:outline-navy",
      "data-[state=checked]:bg-navy data-[state=checked]:border-navy data-[state=checked]:text-white",
      className
    )}
    {...props}
  >
    <CheckboxPrimitive.Indicator className="flex items-center justify-center">
      <Check className="h-3 w-3" strokeWidth={3} />
    </CheckboxPrimitive.Indicator>
  </CheckboxPrimitive.Root>
));
Checkbox.displayName = "Checkbox";

/**
 * Tick any of a set — the roles that may see a form, a person's sites. `value`
 * holds the ticked options' values, in the order they were ticked. Two
 * columns from `sm`; give it a max height to scroll a long list.
 */
export function CheckboxList({ options, value, onChange, className }: {
  options: SelectOption[];
  value: string[];
  onChange: (next: string[]) => void;
  className?: string;
}) {
  return (
    <div className={cn("grid grid-cols-1 gap-1 rounded-input border border-hairline p-2 sm:grid-cols-2", className)}>
      {options.map((o) => (
        <label key={o.value} className="flex min-h-[32px] items-center gap-2 text-[13px] text-ink">
          <input
            type="checkbox"
            checked={value.includes(o.value)}
            onChange={(e) => onChange(e.target.checked ? [...value, o.value] : value.filter((v) => v !== o.value))}
          />
          {o.label}
        </label>
      ))}
    </div>
  );
}
