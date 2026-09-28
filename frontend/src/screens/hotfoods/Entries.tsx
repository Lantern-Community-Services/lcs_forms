import { useState } from "react";
import { Link } from "react-router-dom";
import { ChevronRight, UtensilsCrossed } from "lucide-react";
import { Page } from "@/components/shell/AppShell";
import { PhoneHeader } from "@/components/shell/PhoneHeader";
import { Card } from "@/components/ui/card";
import { Tag } from "@/components/ui/badge";
import { SearchInput } from "@/components/ui/input";
import { Select } from "@/components/ui/select";
import { EmptyState, LoadMore, LoadingState } from "@/components/ui/misc";
import { DateRangeBar, rangeLabel, useDateRange } from "@/components/hotfoods/DateRange";
import { HotFoodsExportButtons, HotFoodsExportMenu } from "@/components/hotfoods/HotFoodsExport";
import { useHotFoodEntries, type HotFoodView } from "@/lib/queries";
import { SitePicker, selectionLabel, useSiteSelection } from "@/lib/site";
import { errorMessage, formatDateTime } from "@/lib/utils";
import type { HotFoodEntryRow } from "@/lib/types";

type Status = "active" | "void" | "all";

/** Every Hot Foods entry in view — sites, dates, search — with print and export of exactly that. */
export function HotFoodsEntriesPage() {
  const { codes, setCodes, selected, param, isLoading: sitesLoading } = useSiteSelection();
  const { from, to, preset, setRange } = useDateRange("7d");
  const [q, setQ] = useState("");
  const [status, setStatus] = useState<Status>("active");
  const view: HotFoodView = { site: param, from, to, q: q.trim(), status };
  const { data, isLoading, isError, error, hasNextPage, fetchNextPage, isFetchingNextPage } = useHotFoodEntries(view, selected.length > 0);
  const items = data?.pages.flatMap((p) => p.items) ?? [];
  const total = data?.pages[0]?.total ?? 0;
  const meals = items.reduce((n, e) => n + (e.voidedAt ? 0 : e.mealCount), 0);
  const multiSite = selected.length > 1;
  const subtitle = `${selected.length ? selectionLabel(codes, selected) : ""} · ${rangeLabel(from, to)}`;

  const search = <SearchInput value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search name, room, notes, staff" wrapperClassName="min-w-0 flex-1" />;
  const statusSelect = (
    <Select
      value={status}
      onChange={(e) => setStatus(e.target.value as Status)}
      aria-label="Status"
      options={[{ value: "active", label: "Counted" }, { value: "void", label: "Voided" }, { value: "all", label: "All" }]}
      className="min-h-[44px] w-[120px] md:min-h-9"
    />
  );

  return (
    <div className="flex min-h-full flex-col">
      <PhoneHeader title="Entries" subtitle={subtitle} actions={<HotFoodsExportMenu kind="entries" view={view} disabled={selected.length === 0} />}>
        <div className="mt-3 flex flex-col gap-2.5">
          <SitePicker codes={codes} onChange={setCodes} />
          <DateRangeBar from={from} to={to} preset={preset} onChange={setRange} />
          <div className="flex gap-2">{search}{statusSelect}</div>
        </div>
      </PhoneHeader>

      <Page className="w-full flex-1 !px-0 md:!px-7">
        <div className="hidden md:block">
          <div className="mb-3 flex flex-wrap items-start justify-between gap-3">
            <p className="text-[13.5px] text-muted">{subtitle}</p>
            <div className="flex flex-wrap items-center gap-2">
              <SitePicker codes={codes} onChange={setCodes} className="w-[240px]" />
              <HotFoodsExportButtons kind="entries" view={view} disabled={selected.length === 0} />
            </div>
          </div>
          <div className="mb-4 flex flex-wrap items-end gap-3">
            <DateRangeBar from={from} to={to} preset={preset} onChange={setRange} />
            <div className="flex min-w-[280px] flex-1 gap-2">{search}{statusSelect}</div>
          </div>
        </div>

        {sitesLoading || isLoading ? (
          <LoadingState />
        ) : isError ? (
          <EmptyState title="Could not load entries" hint={errorMessage(error, "Try again in a moment.")} />
        ) : selected.length === 0 ? (
          <EmptyState title="No sites assigned" hint="You aren't assigned to any sites yet." icon={<UtensilsCrossed className="h-8 w-8" />} />
        ) : items.length === 0 ? (
          <EmptyState title="No entries" hint={q ? "Try a different search." : "Nothing was recorded in this range."} icon={<UtensilsCrossed className="h-8 w-8" />} />
        ) : (
          <>
            <p className="px-4 pb-2 text-[12.5px] text-muted md:px-0">
              <span className="font-semibold text-ink tabular">{total.toLocaleString()}</span> {total === 1 ? "entry" : "entries"}
              {!hasNextPage && status !== "void" && <> · <span className="font-semibold text-ink tabular">{meals.toLocaleString()}</span> meals</>}
            </p>
            <Card className="rounded-none border-x-0 md:rounded-card md:border-x">
              <ul>
                {items.map((e) => (
                  <EntryRow key={e.id} e={e} multiSite={multiSite} />
                ))}
              </ul>
            </Card>
            {hasNextPage && (
              <LoadMore loading={isFetchingNextPage} onClick={() => void fetchNextPage()}>
                Load more ({(total - items.length).toLocaleString()} left)
              </LoadMore>
            )}
          </>
        )}
      </Page>
    </div>
  );
}

function EntryRow({ e, multiSite }: { e: HotFoodEntryRow; multiSite: boolean }) {
  const what = e.items.map((i) => (i.quantity > 1 ? `${i.itemName} × ${i.quantity}` : i.itemName)).join(", ");
  return (
    <li className="border-b border-hairline last:border-0">
      <Link to={`/forms/hot-foods/entries/${e.id}`} className="flex items-center gap-3 px-4 py-3 hover:bg-rowhover">
        <span className="min-w-0 flex-1">
          <span className="flex items-center gap-2">
            <span className={`truncate text-[14.5px] font-semibold ${e.voidedAt ? "text-muted line-through" : "text-ink"}`}>{e.tenantName}</span>
            {e.unit && <span className="shrink-0 text-[12px] text-muted">Rm {e.unit}</span>}
            {e.voidedAt && <Tag tone="red" className="shrink-0 px-1.5 py-0">VOID</Tag>}
            {e.overrideReason && !e.voidedAt && <Tag className="shrink-0 px-1.5 py-0">Override</Tag>}
          </span>
          <span className="block truncate text-[12.5px] text-muted">{what}</span>
          <span className="block truncate text-micro text-muted">
            {multiSite ? `${e.site.name} · ` : ""}
            {formatDateTime(e.occurredAt)} · {e.createdByName}
          </span>
        </span>
        <span className="shrink-0 text-right text-[13px] font-bold tabular text-ink">{e.mealCount}</span>
        <ChevronRight className="h-4 w-4 shrink-0 text-muted" />
      </Link>
    </li>
  );
}
