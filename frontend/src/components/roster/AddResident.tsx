import { useEffect, useRef, useState } from "react";
import { ResponsiveDialog } from "@/components/ui/responsive-dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Field } from "@/components/ui/label";
import { Select } from "@/components/ui/select";
import { useToast } from "@/components/ui/toast";
import { useIsPhone } from "@/lib/useMediaQuery";
import { rosterApi, useRosterMutation } from "@/lib/queries";
import { errorMessage, formatDateInput } from "@/lib/utils";
import type { SiteRef } from "@/lib/types";

const blank = () => ({ unit: "", firstName: "", lastName: "", preferredName: "", moveInDate: formatDateInput(new Date()) });

/**
 * Quick add. Four fields, one of them required, and "Save & add another" keeps
 * the sheet open with the cursor back in Unit — at a shelter intake desk the
 * common case is several people in a row, and re-opening a form per person is
 * exactly what made the old Tenant Updater slow.
 */
export function AddResident({ open, onOpenChange, sites }: {
  open: boolean;
  onOpenChange: (o: boolean) => void;
  /** The sites in view. With more than one, the form asks which. */
  sites: SiteRef[];
}) {
  const phone = useIsPhone();
  const toast = useToast();
  const [form, setForm] = useState(blank);
  const [error, setError] = useState<string | null>(null);
  const [added, setAdded] = useState(0);
  const [siteCode, setSiteCode] = useState(sites[0]?.code ?? "");
  const siteName = sites.find((s) => s.code === siteCode)?.name;
  const unitRef = useRef<HTMLInputElement>(null);
  const create = useRosterMutation((body: Record<string, unknown>) => rosterApi.create(body));

  useEffect(() => {
    if (open) {
      setForm(blank());
      setError(null);
      setAdded(0);
      // Keep the last-used site if it's still in view; it's usually the same desk.
      setSiteCode((c) => (sites.some((s) => s.code === c) ? c : sites[0]?.code ?? ""));
    }
  }, [open]); // eslint-disable-line react-hooks/exhaustive-deps

  const set = (k: keyof ReturnType<typeof blank>) => (e: React.ChangeEvent<HTMLInputElement>) =>
    setForm((f) => ({ ...f, [k]: e.target.value }));

  async function save(another: boolean) {
    if (!siteCode) {
      setError("Choose a site.");
      return;
    }
    if (!form.firstName.trim()) {
      setError("First name is required.");
      return;
    }
    setError(null);
    try {
      const t = await create.mutateAsync({
        site: siteCode,
        unit: form.unit.trim() || null,
        firstName: form.firstName.trim(),
        lastName: form.lastName.trim(),
        preferredName: form.preferredName.trim() || null,
        moveInDate: form.moveInDate || null,
      });
      toast(`Added ${t.displayName}${t.unit ? ` to ${t.unit}` : ""}.`);
      if (another) {
        setAdded((n) => n + 1);
        setForm((f) => ({ ...blank(), moveInDate: f.moveInDate }));
        setTimeout(() => unitRef.current?.focus(), 0);
      } else onOpenChange(false);
    } catch (e) {
      setError(errorMessage(e, "Could not add."));
    }
  }

  const title = `Add to ${siteName ?? "roster"}`;
  const body = (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        void save(true);
      }}
      className="grid grid-cols-2 gap-3"
    >
      {sites.length > 1 && (
        <Field label="Site *" className="col-span-2">
          <Select
            value={siteCode}
            onChange={(e) => setSiteCode(e.target.value)}
            options={sites.map((s) => ({ value: s.code, label: s.name }))}
            className="min-h-[44px] font-semibold"
          />
        </Field>
      )}
      <Field label="Unit / bed" className="col-span-1">
        <Input ref={unitRef} value={form.unit} onChange={set("unit")} placeholder="e.g. 3B" className="min-h-[44px]" autoFocus={!phone} />
      </Field>
      <Field label="Move-in date" className="col-span-1">
        <Input type="date" value={form.moveInDate} onChange={set("moveInDate")} className="min-h-[44px]" />
      </Field>
      <Field label="First name *" className="col-span-2 sm:col-span-1">
        <Input value={form.firstName} onChange={set("firstName")} autoComplete="off" className="min-h-[44px]" autoCapitalize="words" />
      </Field>
      <Field label="Last name" className="col-span-2 sm:col-span-1">
        <Input value={form.lastName} onChange={set("lastName")} autoComplete="off" className="min-h-[44px]" autoCapitalize="words" />
      </Field>
      <Field label="Goes by (optional)" className="col-span-2" hint="Shown first everywhere, including form dropdowns.">
        <Input value={form.preferredName} onChange={set("preferredName")} autoComplete="off" className="min-h-[44px]" />
      </Field>
      {error && <p className="col-span-2 rounded-input bg-status-redBg px-3 py-2 text-[13px] text-status-redText">{error}</p>}
      {added > 0 && <p className="col-span-2 text-micro text-muted">{added} added this session.</p>}
      {/* Enter = save & add another */}
      <button type="submit" hidden />
    </form>
  );
  const actions = (
    <>
      <Button variant="secondary" onClick={() => void save(false)} disabled={create.isPending} className="min-h-[48px] flex-1 md:h-9 md:min-h-0 md:flex-none">
        Save & close
      </Button>
      <Button onClick={() => void save(true)} disabled={create.isPending} className="min-h-[48px] flex-1 md:h-9 md:min-h-0 md:flex-none">
        {create.isPending ? "Saving…" : "Save & add another"}
      </Button>
    </>
  );

  return (
    <ResponsiveDialog open={open} onOpenChange={onOpenChange} title={title} footer={actions}>
      {body}
    </ResponsiveDialog>
  );
}
