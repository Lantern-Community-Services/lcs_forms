import { Avatar } from "@/components/ui/avatar";
import { tintFor } from "@/lib/utils";
import type { Tenant } from "@/lib/types";

/**
 * The top of a resident's swipe card — avatar, name, legal name when they go by
 * another, unit — shared by the review queue and the roll call so the two
 * decks stay laid out exactly alike. The swipe-* classes let a short card
 * tighten (see .swipe-deck in index.css).
 */
export function ResidentCardHeader({ tenant: t, showSite = false }: { tenant: Tenant; /** Several sites in view: say which. */ showSite?: boolean }) {
  return (
    <>
      <Avatar name={t.displayName} color={tintFor(t.id)} size={84} className="swipe-avatar" />
      <h2 className="swipe-name mt-4 text-[24px] font-heading font-extrabold leading-tight text-ink">{t.displayName}</h2>
      {t.preferredName && (
        <p className="mt-0.5 text-[13px] text-muted">
          {t.firstName} {t.lastName}
        </p>
      )}
      <p className="mt-2 text-[15px] font-semibold text-ink">
        {[t.unit ? `Unit ${t.unit}` : "No unit", showSite && t.site?.name].filter(Boolean).join(" · ")}
      </p>
    </>
  );
}
