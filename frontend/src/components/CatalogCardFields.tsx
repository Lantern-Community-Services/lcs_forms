import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { useQueryClient } from "@tanstack/react-query";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Field } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { useToast } from "@/components/ui/toast";
import { formsApi, useForms } from "@/lib/queries";
import { errorMessage } from "@/lib/utils";

type Card = { title: string; description: string; keywords: string; badge: string; active: boolean };

/**
 * A built form's card on the Forms screen, in its own editor (Form builder's
 * Settings, a code form's Settings panel): the card's title, line under it,
 * search words, tag and whether staff see it. Saved straight away, like the
 * category. Everything else about the card is on its Forms catalog page.
 */
export function CatalogCardFields({ linkId }: { linkId: string }) {
  const qc = useQueryClient();
  const toast = useToast();
  const { data } = useForms(true);
  const link = data?.categories.flatMap((c) => c.forms).find((f) => f.id === linkId);
  const saved: Card | null = link ? { title: link.title, description: link.description ?? "", keywords: link.keywords ?? "", badge: link.badge ?? "", active: link.active } : null;
  const [draft, setDraft] = useState<Card | null>(null);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    if (saved) setDraft(saved);
  }, [JSON.stringify(saved)]); // eslint-disable-line react-hooks/exhaustive-deps

  if (!draft || !saved) return null;
  const changed = JSON.stringify(draft) !== JSON.stringify(saved);

  async function save() {
    if (!draft!.title.trim()) return toast("Give the card a title.", "error");
    setBusy(true);
    try {
      await formsApi.update(linkId, draft!);
      await qc.invalidateQueries({ queryKey: ["forms"] });
      toast("Card saved. It's live on the Forms screen.");
    } catch (e) {
      toast(errorMessage(e, "Couldn't save the card."), "error");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="space-y-4 rounded-input border border-hairline p-3">
      <div className="flex items-center gap-3">
        <p className="min-w-0 flex-1 text-[13px] font-semibold text-ink">Its card on the Forms screen</p>
        <label className="flex items-center gap-2 text-[12.5px] text-ink">
          <Switch checked={draft.active} onCheckedChange={(active) => setDraft({ ...draft, active })} aria-label="Visible to staff" />
          Visible to staff
        </label>
      </div>
      <Field label="Title on the card">
        <Input value={draft.title} onChange={(e) => setDraft({ ...draft, title: e.target.value })} maxLength={120} />
      </Field>
      <Field label="Description" hint="One short line under the title.">
        <Input value={draft.description} onChange={(e) => setDraft({ ...draft, description: e.target.value })} maxLength={300} />
      </Field>
      <div className="grid gap-4 sm:grid-cols-[minmax(0,1fr)_170px]">
        <Field label="Search words" hint="Comma-separated, e.g. an old name.">
          <Input value={draft.keywords} onChange={(e) => setDraft({ ...draft, keywords: e.target.value })} maxLength={255} />
        </Field>
        <Field label="Tag" hint="e.g. “New”.">
          <Input value={draft.badge} onChange={(e) => setDraft({ ...draft, badge: e.target.value })} maxLength={30} />
        </Field>
      </div>
      <div className="flex flex-wrap items-center justify-end gap-3">
        <Link to={`/admin/forms/card/${linkId}`} className="mr-auto text-[12.5px] font-semibold text-accent dark:text-white">Everything about the card</Link>
        <Button size="sm" onClick={() => void save()} disabled={busy || !changed}>Save the card</Button>
      </div>
    </div>
  );
}
