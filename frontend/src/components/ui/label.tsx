import { forwardRef, useId, useLayoutEffect, useRef, useState, type LabelHTMLAttributes } from "react";
import { cn } from "@/lib/utils";

export const Label = forwardRef<HTMLLabelElement, LabelHTMLAttributes<HTMLLabelElement>>(
  ({ className, ...props }, ref) => (
    <label ref={ref} className={cn("block text-label font-semibold text-ink mb-1.5", className)} {...props} />
  )
);
Label.displayName = "Label";

const CONTROL = "input:not([type=hidden]), select, textarea, button[role=combobox], [role=combobox], [role=radiogroup], [role=switch], [role=checkbox]";
/** Elements a <label for> can name; anything else is named with aria-labelledby. */
const LABELABLE = new Set(["INPUT", "SELECT", "TEXTAREA", "BUTTON"]);

/**
 * A form field wrapper: label + control (+ hint). The label and the hint are tied
 * to the first control inside, so a screen reader says what the field is and reads
 * its hint: `for` (or aria-labelledby) and aria-describedby are set on it, with an
 * id given to it if it has none. Callers pass the control as they always have.
 */
export function Field({ label, children, hint, className }: { label?: React.ReactNode; children: React.ReactNode; hint?: string; className?: string }) {
  const box = useRef<HTMLDivElement>(null);
  const uid = useId();
  const labelId = `${uid}-label`;
  const hintId = hint ? `${uid}-hint` : undefined;
  const [forId, setForId] = useState<string | undefined>(undefined);

  useLayoutEffect(() => {
    const el = box.current?.querySelector<HTMLElement>(CONTROL);
    if (!el) return;
    if (LABELABLE.has(el.tagName)) {
      if (!el.id) el.id = `${uid}-control`;
      setForId(el.id);
    } else if (label && !el.getAttribute("aria-labelledby")) {
      el.setAttribute("aria-labelledby", labelId);
    }
    if (hintId) {
      const given = (el.getAttribute("aria-describedby") ?? "").split(" ").filter(Boolean);
      if (!given.includes(hintId)) el.setAttribute("aria-describedby", [...given, hintId].join(" "));
    }
  });

  return (
    <div ref={box} className={className}>
      {label && <Label id={labelId} htmlFor={forId}>{label}</Label>}
      {children}
      {hint && <p id={hintId} className="mt-1 text-caption text-muted">{hint}</p>}
    </div>
  );
}
