import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Field } from "@/components/ui/label";
import { IconPicker } from "@/components/IconPicker";
import { ApiError } from "@/lib/api";
import { formIcon, type FormIconKey } from "@/lib/formIcons";
import { errorMessage } from "@/lib/utils";

/** Pieces shared by the Forms catalog and its card page. */

/** Where a new link starts, and what an emptied one goes back to. */
export const LINK_DOMAIN = "https://forms.lanterncommunity.org/";

/**
 * A validation failure's own words ("Use a full https:// link…") rather than
 * the generic "Validation failed" the API puts on top of them.
 */
export function messageOf(e: unknown): string {
  if (e instanceof ApiError) {
    const d = e.details as { formErrors?: string[]; fieldErrors?: Record<string, string[] | undefined> } | undefined;
    const first = d?.formErrors?.[0] ?? Object.values(d?.fieldErrors ?? {}).flat()[0];
    if (first) return first;
  }
  return errorMessage(e, "Could not save.");
}

/** A titled block of an editor. */
export function FormSection({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="space-y-4">
      <h3 className="kicker">{title}</h3>
      {children}
    </section>
  );
}

/** The card's icon, with the full picker tucked away until asked for. */
export function IconField({ value, onChange, inherit: Inherit, canInherit = true }: {
  value: FormIconKey | null;
  onChange: (icon: FormIconKey | null) => void;
  inherit: React.ElementType;
  /** False for a category, which always has its own icon. */
  canInherit?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const Current = value ? formIcon(value) : Inherit;
  return (
    <Field label="Icon">
      <div className="flex items-center gap-3">
        <span className="flex h-10 w-10 items-center justify-center rounded-[9px] bg-navsel text-accent dark:text-white">
          <Current className="h-5 w-5" />
        </span>
        <span className="min-w-0 flex-1 text-[13px] text-muted">{!canInherit ? "Shown on the Forms page" : value ? "Its own icon" : "The category's icon"}</span>
        {value && canInherit && (
          <Button type="button" size="sm" variant="ghost" onClick={() => onChange(null)}>
            Use the category's
          </Button>
        )}
        <Button type="button" size="sm" variant="secondary" onClick={() => setOpen(!open)} aria-expanded={open}>
          {open ? "Done" : "Change"}
        </Button>
      </div>
      {open && (
        <div className="mt-3">
          <IconPicker value={value} onChange={(icon) => onChange(icon as FormIconKey | null)} inherit={canInherit ? Inherit : undefined} />
        </div>
      )}
    </Field>
  );
}
