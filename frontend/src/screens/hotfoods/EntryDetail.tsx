import { useState } from "react";
import { useParams } from "react-router-dom";
import { DesktopBackLink, Page } from "@/components/shell/AppShell";
import { PhoneHeader } from "@/components/shell/PhoneHeader";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Dialog, DialogBody, DialogContent, DialogFooter, DialogHeader } from "@/components/ui/dialog";
import { EmptyState, LoadingState } from "@/components/ui/misc";
import { useToast } from "@/components/ui/toast";
import { HotFoodEntryPrint } from "@/components/hotfoods/HotFoodsExport";
import { hotFoodsApi, useHotFoodEntry, useHotFoodsMutation } from "@/lib/queries";
import { useAuth } from "@/lib/auth";
import { errorMessage, formatDateTime } from "@/lib/utils";

/** One Hot Foods entry: what was handed out, the signature, and — for managers — Void. */
export function HotFoodsEntryDetailPage() {
  const { id } = useParams();
  const { can } = useAuth();
  const { data: e, isLoading, isError, error } = useHotFoodEntry(id);
  const [voiding, setVoiding] = useState(false);
  const back = { to: "/forms/hot-foods/entries", label: "Entries" };

  return (
    <div className="flex min-h-full flex-col">
      <PhoneHeader title={e?.tenantName ?? "Entry"} subtitle={e ? `${e.site.name} · ${formatDateTime(e.occurredAt)}` : undefined} back={back} />
      <Page className="w-full max-w-[760px]">
        <DesktopBackLink to={back.to} className="mb-3">{back.label}</DesktopBackLink>
        {isLoading ? (
          <LoadingState />
        ) : isError || !e ? (
          <EmptyState title="Entry not found" hint={error instanceof Error ? error.message : undefined} />
        ) : (
          <>
            <div className="mb-4 hidden md:block">
              <h1 className="text-[24px] font-heading font-extrabold text-ink">{e.tenantName}</h1>
              <p className="mt-1 text-[13.5px] text-muted">{e.site.name} · {formatDateTime(e.occurredAt)} · recorded by {e.createdByName}</p>
            </div>

            {e.voidedAt && (
              <div className="mb-4 rounded-card border border-status-redDot/40 bg-status-redBg px-4 py-3 text-[13.5px] text-status-redText">
                <p className="font-bold">Void — not counted in reports</p>
                <p className="mt-0.5">{e.voidReason} · {e.voidedByName} · {formatDateTime(e.voidedAt)}</p>
              </div>
            )}

            <Card className="mb-4">
              <dl className="divide-y divide-hairline">
                <Row k="Resident" v={e.tenantName} />
                <Row k="Room" v={e.unit ?? "—"} />
                <Row k="Items" v={e.items.map((i) => `${i.itemName} × ${i.quantity}`).join("\n")} />
                <Row k="Meals" v={String(e.mealCount)} />
                {e.overrideReason && <Row k="Over-limit reason" v={e.overrideReason} />}
                {e.notes && <Row k="Notes" v={e.notes} />}
                <Row k="Recorded by" v={`${e.createdByName}${e.source === "demo" ? " (demo data)" : ""}`} />
              </dl>
            </Card>

            <p className="mb-1.5 text-[12px] font-semibold text-muted">Resident signature</p>
            <div className="mb-5 rounded-card border border-hairline bg-white p-2">
              <img src={e.signature} alt={`Signature of ${e.tenantName}`} className="mx-auto max-h-[200px] w-full object-contain" />
            </div>

            <div className="flex flex-wrap items-center justify-between gap-3">
              <HotFoodEntryPrint id={e.id} />
              {can("entries.void") && !e.voidedAt && (
                <Button variant="outlineDanger" onClick={() => setVoiding(true)}>Void entry</Button>
              )}
            </div>
            <VoidDialog id={e.id} name={e.tenantName} open={voiding} onOpenChange={setVoiding} />
          </>
        )}
      </Page>
    </div>
  );
}

function Row({ k, v }: { k: string; v: string }) {
  return (
    <div className="grid grid-cols-[8.5rem_1fr] gap-3 px-4 py-2.5">
      <dt className="text-[13px] text-muted">{k}</dt>
      <dd className="whitespace-pre-line text-[14px] font-semibold text-ink">{v}</dd>
    </div>
  );
}

function VoidDialog({ id, name, open, onOpenChange }: { id: string; name: string; open: boolean; onOpenChange: (o: boolean) => void }) {
  const toast = useToast();
  const [reason, setReason] = useState("");
  const voidIt = useHotFoodsMutation((r: string) => hotFoodsApi.void(id, r));
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent aria-describedby={undefined} className="w-[min(460px,calc(100vw-2rem))] p-0">
        <DialogHeader title="Void this entry?" />
        <DialogBody>
          <p className="mb-3 text-[13.5px] text-muted">
            {name}'s entry stays on record, marked void, and stops counting toward today's limit and every report. This can't be undone — record it again if it was right after all.
          </p>
          <label className="block">
            <span className="mb-1.5 block text-[12px] font-semibold text-muted">Reason *</span>
            <Input value={reason} onChange={(e) => setReason(e.target.value)} maxLength={300} placeholder="e.g. Recorded under the wrong resident" className="min-h-[44px]" autoFocus />
          </label>
        </DialogBody>
        <DialogFooter>
          <Button variant="secondary" onClick={() => onOpenChange(false)}>Cancel</Button>
          <Button
            variant="danger"
            disabled={reason.trim().length < 3 || voidIt.isPending}
            onClick={async () => {
              try {
                await voidIt.mutateAsync(reason.trim());
                toast("Entry voided.");
                onOpenChange(false);
              } catch (e) {
                toast(errorMessage(e, "Could not void this entry."), "error");
              }
            }}
          >
            {voidIt.isPending ? "Voiding…" : "Void entry"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
