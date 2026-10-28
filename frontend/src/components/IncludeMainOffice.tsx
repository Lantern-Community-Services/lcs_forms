import { useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Switch } from "@/components/ui/switch";
import { useToast } from "@/components/ui/toast";
import { api } from "@/lib/api";
import { errorMessage } from "@/lib/utils";

/**
 * A form's "Include the Main Office" switch (backend services/officeSites.ts),
 * for both kinds of form, in each one's editor. Office sites have no roster
 * and are left out of every form's site list unless this is on. Saved
 * straight away, not with Publish.
 */

interface OfficeSitesView {
  includeOffice: boolean;
  offices: { code: string; name: string }[];
  updatedByName: string | null;
  updatedAt: string | null;
}

export const officeSitesKey = (formId: string) => ["forms", "office-sites", formId];

export function IncludeMainOffice({ formId }: { formId: string }) {
  const qc = useQueryClient();
  const toast = useToast();
  const [busy, setBusy] = useState(false);
  const { data } = useQuery({ queryKey: officeSitesKey(formId), queryFn: () => api.get<OfficeSitesView>(`/forms/built/${formId}/office-sites`) });
  const names = data?.offices.map((o) => o.name).join(", ") || "the Main Office";

  async function set(includeOffice: boolean) {
    setBusy(true);
    try {
      await api.put(`/forms/built/${formId}/office-sites`, { includeOffice });
      await qc.invalidateQueries({ queryKey: officeSitesKey(formId) });
      await qc.invalidateQueries({ queryKey: ["roster", "sites"] });
      toast(includeOffice ? `Saved: ${names} is in this form's site list now.` : `Saved: ${names} is out of this form's site list.`);
    } catch (e) {
      toast(errorMessage(e, "Couldn't save."), "error");
    } finally {
      setBusy(false);
    }
  }

  return (
    <label className="flex cursor-pointer items-start justify-between gap-4">
      <span>
        <span className="block text-[13.5px] font-semibold text-ink">Include the Main Office</span>
        <span className="block text-[12px] text-muted">
          {data && !data.offices.length
            ? "There's no office site yet: add one in Sites with the type Office."
            : `Offer ${names} in this form's site list, to everyone filling it. It has no roster. Saved straight away, not with Publish.`}
        </span>
      </span>
      <Switch checked={Boolean(data?.includeOffice)} disabled={!data || busy} onCheckedChange={set} className="mt-0.5" />
    </label>
  );
}
