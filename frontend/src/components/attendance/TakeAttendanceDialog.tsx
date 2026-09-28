import { useEffect, useState } from "react";
import { ResponsiveDialog } from "@/components/ui/responsive-dialog";
import { Button } from "@/components/ui/button";
import { Input, Textarea } from "@/components/ui/input";
import { Field } from "@/components/ui/label";
import { Select } from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { EmptyState, LoadingState } from "@/components/ui/misc";
import { useToast } from "@/components/ui/toast";
import { useIsPhone } from "@/lib/useMediaQuery";
import { attendanceApi, useAttendanceMutation, useSites, useTenants } from "@/lib/queries";
import { useAuth } from "@/lib/auth";
import { cn, errorMessage } from "@/lib/utils";
import { RollCall, type PresentEntry } from "./RollCall";

/**
 * Take attendance as a popup over the Attendance page — a brief setup
 * followed by the one-person-at-a-time roll call, boxed the same way as
 * Add resident: a `Dialog` on desktop, a bottom `Sheet` on a phone. Closing it
 * (Escape, the backdrop, the ×) discards anything in progress, same as every
 * other add/edit popup in the app.
 */
export function TakeAttendanceDialog({
  open,
  onOpenChange,
  defaultSiteCode,
  onSaved,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Prefilled when exactly one site is in view; otherwise the person picks. */
  defaultSiteCode?: string;
  /** Called with the new event's id once it's saved, so the caller can open its detail page. */
  onSaved: (id: string) => void;
}) {
  const { can } = useAuth();
  const toast = useToast();
  const phone = useIsPhone();
  const { data: sites } = useSites();
  const [siteCode, setSiteCode] = useState(defaultSiteCode ?? "");
  const [title, setTitle] = useState("");
  const [description, setDescription] = useState("");
  /** Off by default: marking someone here only opens the signature pad when asked for. */
  const [collectSignatures, setCollectSignatures] = useState(false);
  const [started, setStarted] = useState(false);
  const [editingDetails, setEditingDetails] = useState(false);
  const [clock, setClock] = useState(() => new Date());
  const create = useAttendanceMutation((body: Record<string, unknown>) => attendanceApi.create(body));

  useEffect(() => {
    if (open) {
      setSiteCode(defaultSiteCode ?? "");
      setTitle("");
      setDescription("");
      setCollectSignatures(false);
      setStarted(false);
      setEditingDetails(false);
    }
  }, [open]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (!open) return;
    const timer = window.setInterval(() => setClock(new Date()), 60_000);
    return () => window.clearInterval(timer);
  }, [open]);

  const effectiveCode = siteCode || (sites?.length === 1 ? sites[0].code : "");
  const site = sites?.find((item) => item.code === effectiveCode);
  const { data, isLoading, isPlaceholderData, isError, error } = useTenants(site?.code, "active", open && Boolean(site));
  const roster = isPlaceholderData ? [] : data?.items ?? [];

  if (!can("roster.edit")) return null;

  function start() {
    if (!site) return toast("Choose a site.", "error");
    if (!title.trim()) return toast("Title is required.", "error");
    if (!description.trim()) return toast("Description is required.", "error");
    setStarted(true);
  }

  async function save(entries: PresentEntry[]) {
    if (!site || !started) return;
    if (!title.trim() || !description.trim()) return toast("Title and description are required.", "error");
    try {
      const event = await create.mutateAsync({ site: site.code, title: title.trim(), description: description.trim(), entries });
      toast(`Saved — ${event.entries.length} present.`);
      onOpenChange(false);
      onSaved(event.id);
    } catch (failure) {
      toast(errorMessage(failure, "Could not save attendance."), "error");
    }
  }

  const localTime = clock.toLocaleString("en-US", { weekday: "long", month: "long", day: "numeric", hour: "numeric", minute: "2-digit" });

  const body =
    !started || editingDetails ? (
      <div className="space-y-3">
        <div className="grid gap-3 sm:grid-cols-2">
          <Field label="Title *">
            <Input value={title} onChange={(event) => setTitle(event.target.value)} placeholder="e.g. Tuesday tenant meeting" className="min-h-[44px]" maxLength={160} autoFocus={!started && !phone} />
          </Field>
          <Field label="Site *">
            {started ? (
              <p className="flex min-h-[44px] items-center text-[14px] font-semibold text-ink">{site?.name}</p>
            ) : (
              <Select value={effectiveCode} onChange={(event) => setSiteCode(event.target.value)} options={(sites ?? []).map((item) => ({ value: item.code, label: item.name }))} placeholder="Choose a site" className="min-h-[44px] font-semibold" />
            )}
          </Field>
        </div>
        <Field label="Description *">
          <Textarea value={description} onChange={(event) => setDescription(event.target.value)} placeholder="What is this attendance for?" maxLength={2000} />
        </Field>
        <label className="flex min-h-[44px] cursor-pointer items-center justify-between gap-3 rounded-input border border-hairline px-3 py-2">
          <span className="min-w-0">
            <span className="block text-[14px] font-semibold text-ink">Collect signatures</span>
            <span className="block text-[12px] text-muted">Open the signature pad each time someone is marked here.</span>
          </span>
          <Switch checked={collectSignatures} onCheckedChange={setCollectSignatures} />
        </label>
        <p className="text-[12px] text-muted">Date and time: {localTime} (your local time)</p>
        {started ? (
          <Button variant="secondary" onClick={() => setEditingDetails(false)}>
            Done editing
          </Button>
        ) : (
          <Button className="min-h-[48px] w-full" onClick={start} disabled={!site || isLoading || isPlaceholderData || isError}>
            Start roll call
          </Button>
        )}
      </div>
    ) : (
      <>
        <div className="mb-2 flex flex-none items-start gap-2 rounded-[16px] border border-hairline bg-subtle2/60 px-3 py-2 md:mb-3 md:py-2.5">
          <div className="min-w-0 flex-1">
            <p className="truncate text-[14px] font-bold text-ink">{title}</p>
            <p className="truncate text-[11px] text-muted">
              {site?.name} · {localTime}
            </p>
          </div>
          <Button variant="ghost" size="sm" onClick={() => setEditingDetails(true)}>
            Edit
          </Button>
        </div>
        {isLoading || isPlaceholderData ? (
          <LoadingState label="Loading roster…" />
        ) : isError ? (
          <EmptyState title="Could not load this roster" hint={errorMessage(error, "Try again in a moment.")} />
        ) : (
          <RollCall roster={roster} saving={create.isPending} collectSignatures={collectSignatures} onSave={save} />
        )}
      </>
    );

  // The phone's sheet is taller than usual, so the whole roll call fits without
  // scrolling. Flex all the way down so the roll call can fill it exactly; the
  // body only scrolls on a phone too short for the deck's floor.
  return (
    <ResponsiveDialog
      open={open}
      onOpenChange={onOpenChange}
      title="Take attendance"
      sheetClassName="max-h-[92dvh]"
      sheetBodyClassName="flex flex-col"
      dialogClassName="flex max-h-[85vh] w-[min(640px,calc(100vw-2rem))] flex-col p-0"
      dialogBodyClassName="flex min-h-0 flex-1 flex-col overflow-y-auto scroll-thin"
    >
      {/* Clips a card flying off sideways so it never grows the scroll area (the
          roll call masks it vertically); bleeds over the body padding. */}
      <div className={cn("flex min-h-0 flex-1 flex-col overflow-x-clip", phone ? "-mx-4 -my-3.5 px-4 py-3.5" : "-mx-6 -my-5 px-6 py-5")}>{body}</div>
    </ResponsiveDialog>
  );
}
