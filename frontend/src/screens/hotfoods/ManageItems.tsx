import { useState } from "react";
import { ArrowDown, ArrowUp, Plus, UtensilsCrossed } from "lucide-react";
import { Dialog, DialogBody, DialogContent, DialogHeader } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";
import { LoadingState } from "@/components/ui/misc";
import { useToast } from "@/components/ui/toast";
import { hotFoodsApi, useHotFoodItems, useHotFoodsMutation } from "@/lib/queries";
import type { HotFoodItem } from "@/lib/types";
import { slotColor } from "@/components/hotfoods/Charts";
import { cn, errorMessage } from "@/lib/utils";

/**
 * The meal types staff pick from — what WordPress kept in hotfood.csv. Hidden
 * rather than deleted, so past entries and reports keep their names.
 */
export function ManageItemsDialog({ open, onOpenChange }: { open: boolean; onOpenChange: (o: boolean) => void }) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent aria-describedby={undefined} className="flex max-h-[85vh] w-[min(620px,calc(100vw-2rem))] flex-col p-0">
        <DialogHeader title="Meal types" subtitle="What staff can pick on the Hot Foods form." />
        <DialogBody className="min-h-0 flex-1 overflow-y-auto scroll-thin">
          <MealTypesEditor />
        </DialogBody>
      </DialogContent>
    </Dialog>
  );
}

/** The list and the add row, shared by the dialog on Record and Admin → Hot Foods. */
export function MealTypesEditor() {
  const toast = useToast();
  const { data: items, isLoading } = useHotFoodItems(true);
  const [name, setName] = useState("");
  const [imageUrl, setImageUrl] = useState("");
  const create = useHotFoodsMutation((b: { name: string; imageUrl?: string }) => hotFoodsApi.createItem(b));
  const update = useHotFoodsMutation((v: { id: string; body: Parameters<typeof hotFoodsApi.updateItem>[1] }) => hotFoodsApi.updateItem(v.id, v.body));
  const reorder = useHotFoodsMutation((ids: string[]) => hotFoodsApi.reorderItems(ids));

  const run = async (p: Promise<unknown>, ok?: string) => {
    try {
      await p;
      if (ok) toast(ok);
    } catch (e) {
      toast(errorMessage(e, "That didn't save."), "error");
    }
  };

  function move(list: HotFoodItem[], i: number, by: number) {
    const next = [...list];
    const [it] = next.splice(i, 1);
    next.splice(i + by, 0, it);
    void run(reorder.mutateAsync(next.map((x) => x.id)));
  }

  return (
    <>
      {isLoading || !items ? (
        <LoadingState />
      ) : (
        <ul className="mb-5 divide-y divide-hairline rounded-card border border-hairline">
          {items.map((item, i) => (
            <ItemRow
              key={item.id}
              item={item}
              first={i === 0}
              last={i === items.length - 1}
              usedBy={(slot) => items.find((x) => x.id !== item.id && x.colorSlot === slot)?.name}
              onMove={(by) => move(items, i, by)}
              onSave={(body) => run(update.mutateAsync({ id: item.id, body }), "Saved.")}
            />
          ))}
        </ul>
      )}
      <p className="mb-2 text-[13px] font-bold text-ink">Add a meal type</p>
      <div className="flex flex-col gap-2 sm:flex-row">
        <Input value={name} onChange={(e) => setName(e.target.value)} placeholder="Name, e.g. Thanksgiving Dinner" maxLength={80} className="min-h-[44px] sm:flex-1" />
        <Input value={imageUrl} onChange={(e) => setImageUrl(e.target.value)} placeholder="Picture link (optional)" className="min-h-[44px] sm:flex-1" type="url" />
        <Button
          className="min-h-[44px]"
          disabled={!name.trim() || create.isPending}
          onClick={() =>
            run(
              create.mutateAsync({ name: name.trim(), ...(imageUrl.trim() ? { imageUrl: imageUrl.trim() } : {}) }).then(() => {
                setName("");
                setImageUrl("");
              }),
              "Added."
            )
          }
        >
          <Plus className="h-4 w-4" /> Add
        </Button>
      </div>
    </>
  );
}

function ItemRow({ item, first, last, usedBy, onMove, onSave }: {
  item: HotFoodItem;
  first: boolean;
  last: boolean;
  usedBy: (slot: number) => string | undefined;
  onMove: (by: number) => void;
  onSave: (body: { name?: string; imageUrl?: string; active?: boolean; colorSlot?: number | null }) => void;
}) {
  const [name, setName] = useState(item.name);
  const [imageUrl, setImageUrl] = useState(item.imageUrl ?? "");
  const dirty = name.trim() !== item.name || imageUrl.trim() !== (item.imageUrl ?? "");
  return (
    <li className="flex items-start gap-3 px-3 py-3">
      <span className="mt-1 flex h-12 w-12 shrink-0 items-center justify-center overflow-hidden rounded-input border border-hairline bg-white">
        {item.imageUrl ? <img src={item.imageUrl} alt="" className="h-full w-full object-contain" /> : <UtensilsCrossed className="h-5 w-5 text-muted" />}
      </span>
      <div className="min-w-0 flex-1 space-y-1.5">
        <Input value={name} onChange={(e) => setName(e.target.value)} maxLength={80} aria-label="Name" className={item.active ? "" : "text-muted"} />
        <Input value={imageUrl} onChange={(e) => setImageUrl(e.target.value)} placeholder="Picture link" aria-label="Picture link" className="text-[12.5px]" />
        <div className="flex flex-wrap items-center gap-3">
          <label className="flex items-center gap-2 text-[12.5px] text-muted">
            <Switch checked={item.active} onCheckedChange={(active) => onSave({ active })} /> {item.active ? "Offered" : "Hidden"}
          </label>
          <ColorPicker value={item.colorSlot} usedBy={usedBy} onChange={(colorSlot) => onSave({ colorSlot })} />
          {dirty && (
            <Button size="sm" disabled={!name.trim()} onClick={() => onSave({ name: name.trim(), imageUrl: imageUrl.trim() })}>Save</Button>
          )}
        </div>
      </div>
      <div className="flex flex-col">
        <Button variant="ghost" size="icon" disabled={first} onClick={() => onMove(-1)} aria-label="Move up"><ArrowUp className="h-4 w-4" /></Button>
        <Button variant="ghost" size="icon" disabled={last} onClick={() => onMove(1)} aria-label="Move down"><ArrowDown className="h-4 w-4" /></Button>
      </div>
    </li>
  );
}

/**
 * Report color for a meal type, from the eight validated chart colors only (no
 * free color picker: arbitrary colors can't be checked for colorblind safety).
 * A color another meal already wears is marked, so two meals don't end up
 * looking the same on the charts.
 */
function ColorPicker({ value, usedBy, onChange }: { value: number | null; usedBy: (slot: number) => string | undefined; onChange: (slot: number) => void }) {
  return (
    <div className="flex items-center gap-1" role="radiogroup" aria-label="Report color">
      <span className="mr-1 text-[12.5px] text-muted">Report color</span>
      {Array.from({ length: 8 }, (_, slot) => {
        const other = usedBy(slot);
        const on = value === slot;
        return (
          <button
            key={slot}
            type="button"
            role="radio"
            aria-checked={on}
            aria-label={`Color ${slot + 1}${other ? ` (used by ${other})` : ""}`}
            title={other ? `Also used by ${other}` : `Color ${slot + 1}`}
            onClick={() => !on && onChange(slot)}
            className={cn("relative h-5 w-5 rounded-full ring-offset-2 ring-offset-surface", on && "ring-2 ring-ink", other && !on && "opacity-40")}
            style={{ background: slotColor(slot) }}
          />
        );
      })}
    </div>
  );
}
