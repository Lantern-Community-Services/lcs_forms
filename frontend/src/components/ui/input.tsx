import { forwardRef, type InputHTMLAttributes, type TextareaHTMLAttributes } from "react";
import { Search } from "lucide-react";
import { cn } from "@/lib/utils";

export const Input = forwardRef<HTMLInputElement, InputHTMLAttributes<HTMLInputElement>>(
  ({ className, ...props }, ref) => (
    <input
      ref={ref}
      className={cn(
        "w-full min-h-9 rounded-input border border-hairline bg-surface px-3 py-1.5 text-[14px] text-ink placeholder:text-muted",
        "focus-visible:outline focus-visible:outline-2 focus-visible:outline-navy focus-visible:border-navy",
        "disabled:opacity-60 disabled:bg-subtle",
        className
      )}
      {...props}
    />
  )
);
Input.displayName = "Input";

export const Textarea = forwardRef<HTMLTextAreaElement, TextareaHTMLAttributes<HTMLTextAreaElement>>(
  ({ className, ...props }, ref) => (
    <textarea
      ref={ref}
      className={cn(
        "w-full min-h-[90px] rounded-input border border-hairline bg-surface px-3 py-2 text-[14px] text-ink placeholder:text-muted resize-y",
        "focus-visible:outline focus-visible:outline-2 focus-visible:outline-navy focus-visible:border-navy",
        className
      )}
      {...props}
    />
  )
);
Textarea.displayName = "Textarea";

/**
 * A list's search box: magnifier inside, the phone keyboard's key reading
 * "Search", and thumb height on a phone. `wrapperClassName` sizes the box in
 * its row; `className` reaches the input itself.
 */
export const SearchInput = forwardRef<HTMLInputElement, InputHTMLAttributes<HTMLInputElement> & { wrapperClassName?: string }>(
  ({ className, wrapperClassName, ...props }, ref) => (
    <div className={cn("relative", wrapperClassName)}>
      <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted" />
      <Input ref={ref} type="search" enterKeyHint="search" className={cn("min-h-[44px] pl-9 md:min-h-9", className)} {...props} />
    </div>
  )
);
SearchInput.displayName = "SearchInput";
