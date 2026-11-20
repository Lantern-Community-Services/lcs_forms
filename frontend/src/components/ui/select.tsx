import { forwardRef, type SelectHTMLAttributes } from "react";
import { ChevronDown } from "lucide-react";
import { cn } from "@/lib/utils";

export interface SelectOption {
  value: string;
  label: string;
}

interface SelectProps extends SelectHTMLAttributes<HTMLSelectElement> {
  options?: SelectOption[];
  placeholder?: string;
}

/** Styled native select — accessible, good for GL/property/dept pickers. */
export const Select = forwardRef<HTMLSelectElement, SelectProps>(
  ({ className, options, placeholder, children, ...props }, ref) => (
    <div className="relative">
      <select
        ref={ref}
        className={cn(
          "w-full min-h-9 appearance-none rounded-input border border-fieldline bg-surface pl-3 pr-8 py-1.5 text-body text-ink touch:min-h-11",
          "focus-visible:outline focus-visible:outline-2 focus-visible:outline-navy focus-visible:border-navy",
          "disabled:opacity-60 disabled:bg-subtle",
          className
        )}
        {...props}
      >
        {placeholder !== undefined && <option value="">{placeholder}</option>}
        {options?.map((o) => (
          <option key={o.value} value={o.value}>
            {o.label}
          </option>
        ))}
        {children}
      </select>
      <ChevronDown className="pointer-events-none absolute right-2.5 top-1/2 -translate-y-1/2 h-4 w-4 text-muted" />
    </div>
  )
);
Select.displayName = "Select";
