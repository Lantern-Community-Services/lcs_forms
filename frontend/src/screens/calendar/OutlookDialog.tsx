import { useEffect, useState } from "react";
import { Check } from "lucide-react";
import { ResponsiveDialog } from "@/components/ui/responsive-dialog";
import { Button } from "@/components/ui/button";
import { useToast } from "@/components/ui/toast";
import { calendarApi, useCalendarMutation, useOutlookPrefs } from "@/lib/queries";
import { cn, errorMessage } from "@/lib/utils";

/**
 * "Add to my Outlook": which events come to this person's own Outlook calendar
 * as invites from Lantern Calendar. Every-site events, and any of their sites.
 * It opens by itself the first time someone visits the calendar; after that
 * it's the Outlook button. Saving nothing is an answer too ("none for me").
 */
export function OutlookDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const toast = useToast();
  const { data } = useOutlookPrefs();
  const [everySite, setEverySite] = useState(false);
  const [siteIds, setSiteIds] = useState<string[]>([]);
  useEffect(() => {
    if (!open || !data) return;
    // Someone answering for the first time starts with everything ticked: it's what most people want.
    setEverySite(data.answered ? data.everySite : true);
    setSiteIds(data.answered ? data.siteIds : data.sites.map((s) => s.id));
  }, [open, data]);

  const save = useCalendarMutation((body: { everySite: boolean; siteIds: string[] }) => calendarApi.saveOutlook(body));
  const submit = (body: { everySite: boolean; siteIds: string[] }) =>
    save.mutate(body, {
      onSuccess: () => {
        const n = (body.everySite ? 1 : 0) + body.siteIds.length;
        toast(n ? (data?.enabled ? "Saved. Invites will arrive in your Outlook shortly." : "Saved.") : "Saved. Nothing will be added to your Outlook.");
        onClose();
      },
      onError: (e) => toast(errorMessage(e, "Couldn't save. Try again."), "error"),
    });

  const sites = data?.sites ?? [];
  const all = everySite && siteIds.length === sites.length;
  const toggle = (id: string) => setSiteIds((ids) => (ids.includes(id) ? ids.filter((x) => x !== id) : [...ids, id]));

  return (
    <ResponsiveDialog
      open={open}
      onOpenChange={(o) => !o && onClose()}
      title="Add to my Outlook calendar"
      dialogClassName="w-[min(520px,calc(100vw-2rem))]"
      dialogBodyClassName="max-h-[min(65vh,600px)] overflow-y-auto scroll-thin"
      footer={
        <>
          <Button variant="secondary" onClick={() => submit({ everySite: false, siteIds: [] })} disabled={save.isPending} className="min-h-[48px] flex-1 md:min-h-0 md:flex-none">
            None for me
          </Button>
          <Button onClick={() => submit({ everySite, siteIds })} disabled={save.isPending} className="min-h-[48px] flex-1 md:min-h-0 md:flex-none">
            {save.isPending ? "Saving…" : "Save"}
          </Button>
        </>
      }
    >
      <div className="space-y-4 pb-1">
        <p className="text-[14px] text-ink">
          Choose which events go to your own Outlook calendar{data?.email ? <> ({data.email})</> : null}. They arrive as invites from <strong>Lantern Calendar</strong> and stay up to date when they change here.
        </p>
        {data && !data.enabled && (
          <p className="rounded-input bg-status-amberBg px-3 py-2 text-[13px] text-status-amberText">
            Sending to Outlook isn't switched on yet. Your choices are kept, and invites start once it is.
          </p>
        )}
        <div>
          <div className="mb-1.5 flex items-center justify-between">
            <p className="text-[12px] font-semibold text-muted">Add these events</p>
            <button
              type="button"
              onClick={() => (all ? (setEverySite(false), setSiteIds([])) : (setEverySite(true), setSiteIds(sites.map((s) => s.id))))}
              className="text-[12.5px] font-semibold text-accent dark:text-white"
            >
              {all ? "Clear" : "Select all"}
            </button>
          </div>
          <ul className="overflow-hidden rounded-card border border-hairline">
            <Row on={everySite} onClick={() => setEverySite((v) => !v)} title="Events for every site" hint="Organization-wide: trainings, holidays, all-staff meetings" />
            {sites.map((s) => (
              <Row key={s.id} on={siteIds.includes(s.id)} onClick={() => toggle(s.id)} title={s.name} />
            ))}
          </ul>
          {sites.length === 0 && <p className="mt-2 text-[12.5px] text-muted">You aren't assigned to any sites yet, so only every-site events can be added.</p>}
        </div>
        <p className="text-micro text-muted">Change this any time from the Outlook button on the calendar. Changes made in Outlook aren't kept; events are changed here.</p>
      </div>
    </ResponsiveDialog>
  );
}

function Row({ on, onClick, title, hint }: { on: boolean; onClick: () => void; title: string; hint?: string }) {
  return (
    <li className="border-b border-hairline last:border-b-0">
      <button type="button" role="checkbox" aria-checked={on} onClick={onClick} className="flex min-h-[48px] w-full items-center gap-3 px-3 py-2 text-left hover:bg-rowhover">
        <span className={cn("flex h-[18px] w-[18px] shrink-0 items-center justify-center rounded-[4px] border", on ? "border-navy bg-navy dark:border-white dark:bg-white" : "border-strongline")}>
          {on && <Check className="h-3 w-3 text-white dark:text-navy" strokeWidth={3} />}
        </span>
        <span className="min-w-0">
          <span className="block text-[14px] font-semibold text-ink">{title}</span>
          {hint && <span className="block text-micro text-muted">{hint}</span>}
        </span>
      </button>
    </li>
  );
}
