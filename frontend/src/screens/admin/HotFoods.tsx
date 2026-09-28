import { useEffect, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { Page, PageHeader } from "@/components/shell/AppShell";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Field } from "@/components/ui/label";
import { LoadingState } from "@/components/ui/misc";
import { useToast } from "@/components/ui/toast";
import { hotFoodsApi, useHotFoodConfig } from "@/lib/queries";
import type { HotFoodConfig } from "@/lib/types";
import { MealTypesEditor } from "@/screens/hotfoods/ManageItems";
import { errorMessage } from "@/lib/utils";

/**
 * Admin → Hot Foods: the form's settings for every site at once — the meal
 * types staff pick from, how many meals of each type a resident gets a day,
 * and the shelter cooldown.
 */
export function AdminHotFoods() {
  const { data, isLoading } = useHotFoodConfig();
  if (isLoading || !data) return <LoadingState />;
  return (
    <Page className="max-w-[820px]">
      <PageHeader title="Hot Foods" subtitle="Settings for the Hot Foods form at every site." />
      <Limits config={data} />
      <Card className="mt-4">
        <div className="border-b border-hairline px-5 py-3.5">
          <p className="font-heading text-[15px] font-extrabold text-ink">Meal types</p>
          <p className="mt-0.5 text-[13px] text-muted">What staff can pick. Hide one rather than renaming it into something else, so past entries keep their meaning.</p>
        </div>
        <div className="p-5">
          <MealTypesEditor />
        </div>
      </Card>
    </Page>
  );
}

function Limits({ config }: { config: HotFoodConfig }) {
  const toast = useToast();
  const qc = useQueryClient();
  const [supportive, setSupportive] = useState(String(config.supportiveLimit));
  const [shelter, setShelter] = useState(String(config.shelterLimit));
  const [cooldown, setCooldown] = useState(String(config.cooldownMinutes));
  const [saving, setSaving] = useState(false);
  useEffect(() => {
    setSupportive(String(config.supportiveLimit));
    setShelter(String(config.shelterLimit));
    setCooldown(String(config.cooldownMinutes));
  }, [config.supportiveLimit, config.shelterLimit, config.cooldownMinutes]);

  const dirty = supportive !== String(config.supportiveLimit) || shelter !== String(config.shelterLimit) || cooldown !== String(config.cooldownMinutes);
  const valid = [supportive, shelter].every((v) => Number.isInteger(Number(v)) && Number(v) >= 1 && Number(v) <= 20) && Number.isInteger(Number(cooldown)) && Number(cooldown) >= 0 && Number(cooldown) <= 1440 && cooldown !== "";

  async function save() {
    setSaving(true);
    try {
      await hotFoodsApi.updateConfig({ supportiveLimit: Number(supportive), shelterLimit: Number(shelter), cooldownMinutes: Number(cooldown) });
      await qc.invalidateQueries({ queryKey: ["hotfoods"] });
      toast("Saved. Record uses the new limits from the next resident.");
    } catch (e) {
      toast(errorMessage(e, "Could not save."), "error");
    } finally {
      setSaving(false);
    }
  }

  return (
    <Card className="p-5">
      <p className="font-heading text-[15px] font-extrabold text-ink">Meals per day</p>
      <p className="mt-0.5 text-[13px] text-muted">
        Counted per meal type for each resident, each day. Going past a limit, or inside the cooldown, still works: staff pick a reason and it's kept with the entry.
      </p>
      <div className="mt-4 grid gap-4 sm:grid-cols-3">
        <Field label="Supportive housing" hint="Meals of each type per day.">
          <Input type="number" min={1} max={20} value={supportive} onChange={(e) => setSupportive(e.target.value)} className="w-28" />
        </Field>
        <Field label="Shelters" hint="Meals of each type per day.">
          <Input type="number" min={1} max={20} value={shelter} onChange={(e) => setShelter(e.target.value)} className="w-28" />
        </Field>
        <Field label="Shelter cooldown (minutes)" hint="Between two meals of the same type. 0 turns it off.">
          <Input type="number" min={0} max={1440} value={cooldown} onChange={(e) => setCooldown(e.target.value)} className="w-28" />
        </Field>
      </div>
      <div className="mt-4 flex justify-end">
        <Button onClick={save} disabled={!dirty || !valid || saving}>Save limits</Button>
      </div>
    </Card>
  );
}
