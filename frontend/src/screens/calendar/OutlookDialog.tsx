import { useEffect, useState } from "react";
import { Check } from "lucide-react";
import { ResponsiveDialog } from "@/components/ui/responsive-dialog";
import { Button } from "@/components/ui/button";
import { Select } from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { useToast } from "@/components/ui/toast";
import { calendarApi, useCalendarCategories, useCalendarMutation, useOutlookPrefs } from "@/lib/queries";
import { categoryColor } from "@/lib/calendar";
import type { OutlookPrefsInput } from "@/lib/types";
import { cn, errorMessage } from "@/lib/utils";

const REMINDERS = [
  { value: "none", label: "No reminder" },
  { value: "0", label: "When it starts" },
  { value: "5", label: "5 minutes before" },
  { value: "15", label: "15 minutes before" },
  { value: "30", label: "30 minutes before" },
  { value: "60", label: "1 hour before" },
  { value: "120", label: "2 hours before" },
  { value: "1440", label: "1 day before" },
];

/**
 * "Add to my Outlook": which events come to this person's own Outlook calendar
 * (every-site events, their sites, the categories they want), and how: as an
 * invite from whoever added the event (Outlook emails it), or added quietly to
 * their calendar with their own Microsoft sign-in, no email. Opens by itself the first time someone visits the calendar; after
 * that it's the Outlook button. Saving nothing is an answer too ("None for me").
 */
export function OutlookDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const toast = useToast();
  const { data } = useOutlookPrefs();
  const { data: categories } = useCalendarCategories();
  const [prefs, setPrefs] = useState<OutlookPrefsInput | null>(null);
  useEffect(() => {
    if (!open || !data) return;
    // Someone answering for the first time starts with every site ticked: it's what most people want.
    setPrefs({
      everySite: data.answered ? data.everySite : true,
      siteIds: data.answered ? data.siteIds : data.sites.map((s) => s.id),
      emailTeams: data.emailTeams,
      emailOther: data.emailOther,
      reminderMinutes: data.reminderMinutes,
      allDayFree: data.allDayFree,
      mutedCategoryIds: data.mutedCategoryIds,
      skipUncategorized: data.skipUncategorized,
    });
  }, [open, data]);
  const set = (patch: Partial<OutlookPrefsInput>) => setPrefs((p) => (p ? { ...p, ...patch } : p));

  const save = useCalendarMutation((body: OutlookPrefsInput) => calendarApi.saveOutlook(body));
  const submit = (body: OutlookPrefsInput) =>
    save.mutate(body, {
      onSuccess: () => {
        const any = body.everySite || body.siteIds.length > 0;
        toast(any ? (data?.enabled ? "Saved. Your Outlook updates in a minute or two." : "Saved.") : "Saved. Nothing will be added to your Outlook.");
        onClose();
      },
      onError: (e) => toast(errorMessage(e, "Couldn't save. Try again."), "error"),
    });

  const sites = data?.sites ?? [];
  const p = prefs;
  const allSites = Boolean(p && p.everySite && p.siteIds.length === sites.length);
  const toggleSite = (id: string) => p && set({ siteIds: p.siteIds.includes(id) ? p.siteIds.filter((x) => x !== id) : [...p.siteIds, id] });
  const toggleCategory = (id: string) =>
    p && set({ mutedCategoryIds: p.mutedCategoryIds.includes(id) ? p.mutedCategoryIds.filter((x) => x !== id) : [...p.mutedCategoryIds, id] });

  return (
    <ResponsiveDialog
      open={open}
      onOpenChange={(o) => !o && onClose()}
      title="Add to my Outlook calendar"
      dialogClassName="w-[min(560px,calc(100vw-2rem))]"
      dialogBodyClassName="max-h-[min(70vh,680px)] overflow-y-auto scroll-thin"
      footer={
        <>
          <Button
            variant="secondary"
            onClick={() => p && submit({ ...p, everySite: false, siteIds: [] })}
            disabled={save.isPending || !p}
            className="min-h-[48px] flex-1 md:min-h-0 md:flex-none"
          >
            None for me
          </Button>
          <Button onClick={() => p && submit(p)} disabled={save.isPending || !p} className="min-h-[48px] flex-1 md:min-h-0 md:flex-none">
            {save.isPending ? "Saving…" : "Save"}
          </Button>
        </>
      }
    >
      {p && (
        <div className="space-y-6 pb-1">
          <p className="text-[14px] text-ink">
            Choose which calendar events go to your own Outlook calendar{data?.email ? <> ({data.email})</> : null} and how they arrive. They stay up to date when they change here. Nothing to set up in Outlook.
          </p>
          {data && !data.enabled && (
            <p className="rounded-input bg-status-amberBg px-3 py-2 text-[13px] text-status-amberText">
              Sending to Outlook isn't switched on yet. Your choices are kept, and events start arriving once it is.
            </p>
          )}

          <section>
            <SectionHead title="Sites" action={allSites ? "Clear" : "Select all"} onAction={() => (allSites ? set({ everySite: false, siteIds: [] }) : set({ everySite: true, siteIds: sites.map((s) => s.id) }))} />
            <ul className="max-h-[288px] overflow-y-auto scroll-thin rounded-card border border-hairline">
              <Row on={p.everySite} onClick={() => set({ everySite: !p.everySite })} title="Events for every site" hint="Organization-wide: trainings, holidays, all-staff meetings" />
              {sites.map((s) => (
                <Row key={s.id} on={p.siteIds.includes(s.id)} onClick={() => toggleSite(s.id)} title={s.name} />
              ))}
            </ul>
            {sites.length === 0 && <p className="mt-2 text-[12.5px] text-muted">You aren't assigned to any sites yet, so only every-site events can be added.</p>}
          </section>

          <section>
            <SectionHead title="Categories" />
            <div className="flex flex-wrap gap-1.5">
              {(categories ?? []).map((c) => (
                <CategoryToggle key={c.id} on={!p.mutedCategoryIds.includes(c.id)} color={categoryColor(c.colorSlot)} label={c.name} onClick={() => toggleCategory(c.id)} />
              ))}
              <CategoryToggle on={!p.skipUncategorized} color={categoryColor(null)} label="No category" onClick={() => set({ skipUncategorized: !p.skipUncategorized })} />
            </div>
            <p className="mt-1.5 text-micro text-muted">Untick a category to leave its events out of your Outlook. Events added quietly carry the category's name, so a category of that name in your Outlook colors them.</p>
          </section>

          <section className="space-y-2">
            <SectionHead title="How they arrive" />
            <SwitchRow
              on={p.emailTeams}
              onChange={(emailTeams) => set({ emailTeams })}
              title="Email me an invite for Teams meetings"
              hint={p.emailTeams ? "An invite from whoever added the event, with the join link." : "Added quietly, no email. The join link is in the event."}
            />
            <SwitchRow
              on={p.emailOther}
              onChange={(emailOther) => set({ emailOther })}
              title="Email me an invite for other events"
              hint={p.emailOther ? "An invite from whoever added the event, and an email each time it changes." : "Added quietly to your calendar, no email."}
            />
            {data?.enabled && !data.canWriteMine && (!p.emailTeams || !p.emailOther) && (
              <p className="text-micro text-muted">
                Adding events quietly uses your Microsoft sign-in, and Lantern Forms doesn't have it right now (you signed out, or
                haven't signed in with Microsoft since this was turned on). Until you sign in again, they come as invites.
              </p>
            )}
          </section>

          <section className="space-y-2">
            <SectionHead title="Events added quietly" />
            <div className="flex items-center justify-between gap-3 rounded-input border border-hairline px-3 py-2">
              <span className="text-[13.5px] font-semibold text-ink">Reminder</span>
              <div className="w-[200px]">
                <Select
                  value={p.reminderMinutes === null ? "none" : String(p.reminderMinutes)}
                  onChange={(e) => set({ reminderMinutes: e.target.value === "none" ? null : Number(e.target.value) })}
                  aria-label="Reminder"
                  options={REMINDERS}
                />
              </div>
            </div>
            <SwitchRow on={p.allDayFree} onChange={(allDayFree) => set({ allDayFree })} title="Show all-day events as free" hint="Holidays and deadlines don't block your time." />
            <p className="text-micro text-muted">Invites follow your Outlook's own reminder and show-as settings.</p>
          </section>
        </div>
      )}
    </ResponsiveDialog>
  );
}

function SectionHead({ title, action, onAction }: { title: string; action?: string; onAction?: () => void }) {
  return (
    <div className="mb-1.5 flex items-center justify-between">
      <p className="text-[12px] font-bold uppercase tracking-[0.04em] text-muted">{title}</p>
      {action && (
        <button type="button" onClick={onAction} className="text-[12.5px] font-semibold text-accent dark:text-white">
          {action}
        </button>
      )}
    </div>
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

function CategoryToggle({ on, color, label, onClick }: { on: boolean; color: string; label: string; onClick: () => void }) {
  return (
    <button
      type="button"
      role="checkbox"
      aria-checked={on}
      onClick={onClick}
      className={cn(
        "inline-flex min-h-[36px] items-center gap-1.5 rounded-pill border px-3 text-[12.5px] font-semibold transition-colors md:min-h-[32px]",
        on ? "border-hairline bg-surface text-ink hover:bg-navsel/60" : "border-dashed border-hairline text-muted line-through decoration-muted/60"
      )}
    >
      <span className="h-2.5 w-2.5 rounded-full" style={{ background: on ? color : "transparent", boxShadow: on ? undefined : `inset 0 0 0 1.5px ${color}` }} />
      {label}
    </button>
  );
}

function SwitchRow({ on, onChange, title, hint }: { on: boolean; onChange: (v: boolean) => void; title: string; hint: string }) {
  return (
    <label className="flex cursor-pointer items-start justify-between gap-3 rounded-input border border-hairline px-3 py-2.5">
      <span>
        <span className="block text-[13.5px] font-semibold text-ink">{title}</span>
        <span className="block text-micro text-muted">{hint}</span>
      </span>
      <Switch checked={on} onCheckedChange={onChange} className="mt-0.5" />
    </label>
  );
}
