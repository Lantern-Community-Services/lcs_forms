import { useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { ListChecks } from "lucide-react";
import { ResponsiveDialog } from "@/components/ui/responsive-dialog";
import { Button } from "@/components/ui/button";
import { useToast } from "@/components/ui/toast";
import { rosterApi } from "@/lib/queries";
import { errorMessage } from "@/lib/utils";

/**
 * "Send everyone to review" for one site — a manager wants the whole roster
 * checked again. Everyone active goes into Review and stays there until
 * someone keeps or removes them. Shown on the Roster's Review tab.
 */
export function SendSiteToReview({ site, onRoster }: { site: { code: string; name: string }; onRoster: number }) {
  const qc = useQueryClient();
  const toast = useToast();
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);

  async function confirm() {
    setBusy(true);
    try {
      const r = await rosterApi.sendSiteToReview(site.code);
      toast(
        r.sent === 0
          ? `Everyone at ${r.site.name} was already in Review.`
          : `Sent ${r.sent.toLocaleString()} ${r.sent === 1 ? "person" : "people"} at ${r.site.name} to Review.`,
        "success"
      );
      setOpen(false);
    } catch (e) {
      toast(errorMessage(e, "Could not send to review."), "error");
    } finally {
      setBusy(false);
      await qc.invalidateQueries({ queryKey: ["roster"] });
    }
  }

  return (
    <>
      <div className="mb-3 flex justify-end px-4 md:px-0">
        <Button variant="secondary" onClick={() => setOpen(true)} disabled={onRoster === 0} className="min-h-[44px] md:h-9 md:min-h-0">
          <ListChecks className="h-4 w-4" /> Send everyone to review
        </Button>
      </div>
      <ResponsiveDialog
        open={open}
        onOpenChange={(o) => !busy && setOpen(o)}
        title={`Review everyone at ${site.name}?`}
        footer={
          <>
            <Button variant="secondary" onClick={() => setOpen(false)} disabled={busy} className="min-h-[48px] flex-1 md:h-9 md:min-h-0 md:flex-none">
              Cancel
            </Button>
            <Button onClick={() => void confirm()} disabled={busy} className="min-h-[48px] flex-1 md:h-9 md:min-h-0 md:flex-none">
              {busy ? "Sending…" : `Send ${onRoster.toLocaleString()} to review`}
            </Button>
          </>
        }
      >
        <p className="text-[13px] text-muted">
          All {onRoster.toLocaleString()} people on the {site.name} roster will show as Needs review. Each one stays there,
          even if they come up on a form, until someone confirms they're still here (Keep) or removes them.
        </p>
      </ResponsiveDialog>
    </>
  );
}
