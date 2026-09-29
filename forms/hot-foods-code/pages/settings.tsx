import { useEffect, useState } from "react";
import { ArrowDown, ArrowUp, Plus, UtensilsCrossed } from "lucide-react";
import { actions, app, collections, roster, useData } from "@lcs/sdk";
import { Button, Card, Field, Input, LoadingState, Page, PageHeader, Select, Switch } from "@lcs/ui";
import { slotColor } from "@lcs/charts";
import { DEFAULT_LIMITS, type Limits } from "../lib/rules";
import type { Item, MealType } from "../lib/types";

/** Admin settings for every site at once: daily limits, the shelter cooldown, and the meal types staff pick from. */
export default function Settings() {
  return (
    <Page className="max-w-[820px]">
      <PageHeader title="Settings" subtitle="For the Hot Foods form at every site." />
      <LimitsCard />
      <MealTypesCard />
    </Page>
  );
}

function LimitsCard() {
  const { data, loading, refresh } = useData(() => collections.get<Partial<Limits>>("settings", "limits"), []);
  const { data: sites } = useData(() => roster.sites(), []);
  const saved: Limits = { ...DEFAULT_LIMITS, ...(data?.data ?? {}) };
  const [form, setForm] = useState({ supportive: "", shelter: "", cooldown: "" });
  useEffect(() => setForm({ supportive: String(saved.supportiveLimit), shelter: String(saved.shelterLimit), cooldown: String(saved.cooldownMinutes) }), [data]); // eslint-disable-line react-hooks/exhaustive-deps
  const n = (v: string) => Number(v);
  const valid = [form.supportive, form.shelter].every((v) => Number.isInteger(n(v)) && n(v) >= 1 && n(v) <= 20) && form.cooldown !== "" && Number.isInteger(n(form.cooldown)) && n(form.cooldown) >= 0 && n(form.cooldown) <= 1440;
  const dirty = form.supportive !== String(saved.supportiveLimit) || form.shelter !== String(saved.shelterLimit) || form.cooldown !== String(saved.cooldownMinutes);

  async function save() {
    try {
      await collections.put("settings", "limits", { supportiveLimit: n(form.supportive), shelterLimit: n(form.shelter), cooldownMinutes: n(form.cooldown) });
      app.toast("Saved. Record uses the new limits from the next resident.");
      refresh();
    } catch (e) {
      app.toast(e instanceof Error ? e.message : "Could not save.", "error");
    }
  }

  if (loading && !data) return <LoadingState />;
  const shelters = (sites ?? []).filter((s) => s.siteType === "shelter");
  return (
    <Card className="p-5">
      <p className="font-heading text-[15px] font-extrabold text-ink">Meals per day</p>
      <p className="mt-0.5 text-[13px] text-muted">Counted per meal type for each resident, each day. Going past a limit, or inside the cooldown, still works: staff pick a reason and it's kept with the entry.</p>
      <div className="mt-4 grid gap-4 sm:grid-cols-3">
        <Field label="Supportive housing" hint="Meals of each type per day."><Input type="number" min={1} max={20} value={form.supportive} onChange={(e) => setForm({ ...form, supportive: e.target.value })} className="w-28" /></Field>
        <Field label="Shelters" hint="Meals of each type per day."><Input type="number" min={1} max={20} value={form.shelter} onChange={(e) => setForm({ ...form, shelter: e.target.value })} className="w-28" /></Field>
        <Field label="Shelter cooldown (minutes)" hint="Between two meals of the same type. 0 turns it off."><Input type="number" min={0} max={1440} value={form.cooldown} onChange={(e) => setForm({ ...form, cooldown: e.target.value })} className="w-28" /></Field>
      </div>
      <p className="mt-3 text-[12.5px] text-muted">Shelters: {shelters.length ? shelters.map((s) => s.name).join(", ") : "none of your sites"}. A site's type is set in Admin → Sites.</p>
      <div className="mt-4 flex justify-end"><Button onClick={save} disabled={!dirty || !valid}>Save limits</Button></div>
    </Card>
  );
}

function MealTypesCard() {
  const { data, loading, refresh } = useData(() => actions.call<Item[]>("mealTypes", { all: true }), []);
  const [busy, setBusy] = useState(false);
  const list = data ?? [];

  async function put(id: string | null, m: MealType) {
    setBusy(true);
    try {
      await collections.put("mealTypes", id, m);
      refresh();
    } catch (e) {
      app.toast(e instanceof Error ? e.message : "Could not save.", "error");
    } finally {
      setBusy(false);
    }
  }

  async function move(i: number, d: -1 | 1) {
    const a = list[i], b = list[i + d];
    if (!a || !b) return;
    const { id: aid, ...am } = a;
    const { id: bid, ...bm } = b;
    await put(aid, { ...am, sortOrder: b.sortOrder });
    await put(bid, { ...bm, sortOrder: a.sortOrder });
  }

  return (
    <Card className="mt-4">
      <div className="border-b border-hairline px-5 py-3.5">
        <p className="font-heading text-[15px] font-extrabold text-ink">Meal types</p>
        <p className="mt-0.5 text-[13px] text-muted">What staff can pick. Hide one rather than renaming it into something else, so past entries keep their meaning.</p>
      </div>
      {loading && !data ? <LoadingState /> : (
        <ul>
          {list.map((m, i) => <MealRow key={m.id} item={m} first={i === 0} last={i === list.length - 1} busy={busy} onSave={(next) => put(m.id, next)} onMove={(d) => move(i, d)} />)}
        </ul>
      )}
      <div className="border-t border-hairline p-4">
        <Button variant="secondary" disabled={busy} onClick={() => put(null, { name: "New meal type", imageUrl: null, active: true, sortOrder: (list[list.length - 1]?.sortOrder ?? -1) + 1, colorSlot: null })}><Plus className="h-4 w-4" /> Add meal type</Button>
      </div>
    </Card>
  );
}

function MealRow({ item, first, last, busy, onSave, onMove }: { item: Item; first: boolean; last: boolean; busy: boolean; onSave: (m: MealType) => void; onMove: (d: -1 | 1) => void }) {
  const { id: _id, ...base } = item;
  const [name, setName] = useState(item.name);
  const [image, setImage] = useState(item.imageUrl ?? "");
  useEffect(() => { setName(item.name); setImage(item.imageUrl ?? ""); }, [item.name, item.imageUrl]);
  const dirty = name.trim() !== item.name || (image.trim() || null) !== (item.imageUrl ?? null);
  return (
    <li className={`flex flex-wrap items-center gap-3 border-b border-hairline px-5 py-3 last:border-0 ${item.active ? "" : "opacity-60"}`}>
      <span className="flex h-12 w-12 shrink-0 items-center justify-center overflow-hidden rounded-[10px] bg-white ring-1 ring-hairline">
        {image ? <img src={image} alt="" className="h-full w-full object-contain p-0.5" /> : <UtensilsCrossed className="h-5 w-5 text-muted" />}
      </span>
      <div className="grid min-w-[220px] flex-1 gap-1.5">
        <Input value={name} onChange={(e) => setName(e.target.value)} aria-label="Name" />
        <Input value={image} onChange={(e) => setImage(e.target.value)} placeholder="Picture URL (https://…)" aria-label="Picture URL" className="text-[12.5px]" />
      </div>
      <div className="flex items-center gap-1.5">
        <span className="h-4 w-4 rounded-[4px]" style={{ background: slotColor(item.colorSlot) }} />
        <div className="w-[110px]">
          <Select value={item.colorSlot === null ? "" : String(item.colorSlot)} onChange={(e) => onSave({ ...base, colorSlot: e.target.value === "" ? null : Number(e.target.value) })}
            options={[{ value: "", label: "Other (gray)" }, ...Array.from({ length: 8 }, (_, i) => ({ value: String(i), label: `Color ${i + 1}` }))]} aria-label="Report color" />
        </div>
      </div>
      <label className="flex items-center gap-2 text-[13px] text-ink"><Switch checked={item.active} onCheckedChange={(v) => onSave({ ...base, active: v })} /> {item.active ? "Shown" : "Hidden"}</label>
      <div className="flex">
        <button disabled={first || busy} onClick={() => onMove(-1)} className="rounded p-1 text-muted disabled:opacity-30" aria-label="Move up"><ArrowUp className="h-4 w-4" /></button>
        <button disabled={last || busy} onClick={() => onMove(1)} className="rounded p-1 text-muted disabled:opacity-30" aria-label="Move down"><ArrowDown className="h-4 w-4" /></button>
      </div>
      {dirty && <Button size="sm" disabled={busy || !name.trim()} onClick={() => onSave({ ...base, name: name.trim(), imageUrl: image.trim() || null })}>Save</Button>}
    </li>
  );
}
