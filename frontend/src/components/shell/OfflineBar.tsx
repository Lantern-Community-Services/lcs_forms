import { useEffect, useRef, useState } from "react";
import { AlertTriangle, CheckCircle2, ChevronRight, CloudOff, Loader2, RefreshCw, Trash2, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Sheet, SheetBody, SheetClose, SheetContent, SheetFooter, SheetHeader } from "@/components/ui/sheet";
import { useConnectivity } from "@/lib/offline";
import { useSnapshotStatus } from "@/lib/snapshot";
import { discardHotFood, kick, retryHotFoods, useHotFoodsQueue } from "@/lib/hotFoodsQueue";
import { discardFill, retryFills, syncFills, useFillQueue } from "@/lib/fillQueue";
import { allQueued, discard as discardAppEntry, onQueueChange, retryFailed, syncNow, type QueuedEntry as AppQueued } from "@/apps/queue";
import { cn } from "@/lib/utils";

/**
 * The shell's word on the connection, above every screen.
 *
 * Hidden while online with nothing waiting. Offline it says so and that forms
 * still work, how many entries are kept on the device, and how old the data on
 * screen is. Online it shows entries uploading, then "everything uploaded" for
 * a moment; and in red, anything the server refused. Tapping it lists every
 * entry on the device, from all three queues (Hot Foods, built forms, code
 * forms), with retry and discard.
 */

interface Row {
  key: string;
  form: string;
  label: string;
  at: number;
  error?: string;
  discard?: () => void;
}

function useAppQueue() {
  const [rows, setRows] = useState<AppQueued[]>([]);
  useEffect(() => {
    const load = () => void allQueued().then(setRows);
    load();
    const off = onQueueChange(load);
    return () => {
      off();
    };
  }, []);
  return rows;
}

function useOutbox() {
  const hf = useHotFoodsQueue();
  const fill = useFillQueue();
  const apps = useAppQueue();
  const rows: Row[] = [
    // Still inside its Undo window: not waiting on anything yet.
    ...hf.mine.filter((i) => i.status === "failed" || i.holdUntil <= Date.now()).map((i) => ({
      key: `hf-${i.clientId}`,
      form: "Hot Foods",
      label: `${i.tenantName} · ${i.mealCount} meal${i.mealCount === 1 ? "" : "s"}`,
      at: i.savedAt,
      error: i.status === "failed" ? (i.error ?? "Refused") : undefined,
      discard: () => discardHotFood(i.clientId),
    })),
    ...fill.pending.concat(fill.failed).map((r) => ({ key: `f-${r.clientId}`, form: r.title, label: "Entry", at: r.queuedAt, error: r.error, discard: () => void discardFill(r.clientId) })),
    ...apps.map((r) => ({ key: `a-${r.clientId}`, form: r.title ?? r.slug, label: "Entry", at: r.queuedAt, error: r.error, discard: () => void discardAppEntry(r.clientId) })),
  ].sort((a, b) => a.at - b.at);
  return {
    pending: rows.filter((r) => !r.error),
    failed: rows.filter((r) => r.error),
    others: hf.others.length + fill.others.length,
    syncing: hf.syncing || fill.syncing,
    retry: () => {
      retryHotFoods();
      void retryFills();
      new Set(apps.filter((r) => r.error).map((r) => r.slug)).forEach((slug) => void retryFailed(slug));
    },
    upload: () => {
      void kick();
      void syncFills();
      void syncNow();
    },
  };
}

const clock = (ms: number) => {
  const d = new Date(ms);
  const time = d.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
  return d.toDateString() === new Date().toDateString() ? time : `${d.toLocaleDateString([], { month: "short", day: "numeric" })}, ${time}`;
};

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

export function useOfflineBarVisible() {
  const conn = useConnectivity();
  const box = useOutbox();
  const [celebrate, setCelebrate] = useState(false);
  const waiting = box.pending.length;
  // A backlog: entries kept while offline. Online, an entry uploads within a
  // second, and a bar for that would only flicker.
  const backlog = useRef(false);
  if (!conn.online && waiting) backlog.current = true;
  // Online but still waiting after a minute: the server is failing, say so.
  const stuck = box.pending.some((r) => Date.now() - r.at > 60_000);
  // "Everything uploaded", briefly, when a backlog clears.
  useEffect(() => {
    if (waiting || !backlog.current || !conn.online || box.failed.length) return;
    backlog.current = false;
    setCelebrate(true);
    const t = setTimeout(() => setCelebrate(false), 4000);
    return () => clearTimeout(t);
  }, [waiting, conn.online, box.failed.length]);
  return { conn, box, celebrate, visible: !conn.online || box.failed.length > 0 || (waiting > 0 && (backlog.current || stuck)) || celebrate };
}

export function OfflineBar({ state }: { state: ReturnType<typeof useOfflineBarVisible> }) {
  const { conn, box, celebrate, visible } = state;
  const [open, setOpen] = useState(false);
  if (!visible && !open) return null;

  const waiting = box.pending.length;
  const failed = box.failed.length;

  let tone: string, icon: React.ReactNode, title: string, detail: string | null;
  if (failed) {
    tone = "bg-status-redBg text-status-redText";
    icon = <AlertTriangle className="h-4 w-4" />;
    title = `${plural(failed, "entry", "entries")} couldn't upload`;
    detail = "Tap to see why";
  } else if (!conn.online) {
    tone = "bg-status-amberBg text-status-amberText";
    icon = <CloudOff className="h-4 w-4" />;
    title = waiting ? `Offline · ${plural(waiting, "entry", "entries")} saved on this device` : "Offline";
    detail = !conn.ready
      ? "Keep the app open until the connection is back"
      : conn.showingSavedFrom
        ? `Forms still work · data from ${clock(conn.showingSavedFrom)}`
        : "Forms still work and are saved on this device";
  } else if (waiting) {
    tone = "bg-status-blueBg text-status-blueText";
    icon = <Loader2 className="h-4 w-4 animate-spin" />;
    title = `Uploading ${plural(waiting, "saved entry", "saved entries")}…`;
    detail = null;
  } else {
    tone = "bg-status-greenBg text-status-greenText";
    icon = <CheckCircle2 className="h-4 w-4" />;
    title = celebrate ? "Back online · everything uploaded" : "Everything uploaded";
    detail = null;
  }

  return (
    <>
      {visible && (
        <button
          type="button"
          onClick={() => setOpen(true)}
          // Clears the status bar on a phone; the screen below drops its own allowance (AppShell).
          style={{ paddingTop: "max(6px, var(--safe-top))" }}
          className={cn("flex w-full flex-none items-center gap-2 px-4 pb-1.5 text-left text-[13px] font-semibold md:px-7", tone)}
          aria-label={`${title}. ${detail ?? ""} Show what's saved on this device.`}
        >
          {icon}
          <span className="min-w-0 flex-1 truncate">
            {title}
            {detail && <span className="font-normal opacity-90"> · {detail}</span>}
          </span>
          <ChevronRight className="h-4 w-4 shrink-0 opacity-70" />
        </button>
      )}

      <Sheet open={open} onOpenChange={setOpen}>
        <SheetContent aria-describedby={undefined} className="md:mx-auto md:max-w-[560px]">
          <SheetHeader
            title="Saved on this device"
            action={
              <SheetClose className="flex h-10 w-10 items-center justify-center rounded-full text-muted hover:bg-subtle2" aria-label="Close">
                <X className="h-5 w-5" />
              </SheetClose>
            }
          />
          <SheetBody>
            <p className="text-[13.5px] text-muted">
              {conn.online
                ? "Entries filled in without a connection upload on their own."
                : "There's no connection. Keep filling in forms: each entry is kept on this device and uploads on its own when the internet is back."}
              {!conn.online && conn.showingSavedFrom && <> Screens show what this device last loaded, as of {clock(conn.showingSavedFrom)}.</>}
            </p>
            <SnapshotSummary className="mt-3" />
            {!conn.online && !conn.ready && (
              <p className="mt-2 text-[13.5px] font-semibold text-status-redText">
                This device can't open the app without a connection. Don't close or reload it until the connection is back.
              </p>
            )}

            {failed > 0 && (
              <Group title="The server refused these" hint="Usually something changed while the entry waited, like a resident moved off the roster or a form was closed. Fix it and retry, or discard it.">
                {box.failed.map((r) => <OutboxRow key={r.key} row={r} />)}
              </Group>
            )}
            {waiting > 0 && (
              <Group title={conn.online ? "Uploading" : "Waiting for the internet"}>
                {box.pending.map((r) => <OutboxRow key={r.key} row={r} />)}
              </Group>
            )}
            {box.others > 0 && (
              <p className="mt-4 text-[12.5px] text-muted">
                {plural(box.others, "entry", "entries")} by someone else {box.others === 1 ? "is" : "are"} also on this device. They upload when that person signs in here.
              </p>
            )}
            {!failed && !waiting && (
              <p className="mt-6 flex items-center justify-center gap-2 text-[14px] font-semibold text-status-greenText">
                <CheckCircle2 className="h-5 w-5" /> Nothing waiting. Everything is uploaded.
              </p>
            )}
          </SheetBody>
          {(failed > 0 || waiting > 0) && (
            <SheetFooter className="pb-3">
              <Button className="min-h-[52px] flex-1 text-[15px]" onClick={() => (failed ? box.retry() : box.upload())} disabled={box.syncing || (!failed && !conn.online)}>
                <RefreshCw className={cn("h-4 w-4", box.syncing && "animate-spin")} /> {failed ? "Retry all" : "Upload now"}
              </Button>
            </SheetFooter>
          )}
        </SheetContent>
      </Sheet>
    </>
  );
}

/**
 * How much of the site this device holds for offline use (lib/snapshot.ts), in
 * one line: on the "Saved on this device" sheet and on Profile.
 */
export function SnapshotSummary({ className }: { className?: string }) {
  const conn = useConnectivity();
  const snap = useSnapshotStatus();
  let text: string;
  if (!conn.ready) text = "This device can't keep the app for offline use (it needs a secure https connection). Forms still queue entries while it stays open.";
  else if (!snap.total) text = "Getting ready to save the site on this device…";
  else if (snap.fresh >= snap.total && snap.completeAt) text = `The whole site is saved on this device for offline use, up to date as of ${clock(snap.completeAt)}.`;
  else text = `Saving the site on this device for offline use, a little at a time while you work: ${snap.fresh} of ${snap.total} screens ready.`;
  return (
    <p className={cn("flex items-start gap-2 text-[13px] text-muted", className)}>
      {conn.ready && snap.total > 0 && snap.fresh >= snap.total ? <CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0 text-status-greenText" /> : <CloudOff className="mt-0.5 h-4 w-4 shrink-0" />}
      <span>{text}</span>
    </p>
  );
}

function Group({ title, hint, children }: { title: string; hint?: string; children: React.ReactNode }) {
  return (
    <section className="mt-4">
      <h3 className="text-[13px] font-bold uppercase tracking-wide text-muted">{title}</h3>
      {hint && <p className="mt-0.5 text-[12.5px] text-muted">{hint}</p>}
      <ul className="mt-2 divide-y divide-hairline rounded-card border border-hairline">{children}</ul>
    </section>
  );
}

function OutboxRow({ row }: { row: Row }) {
  return (
    <li className="flex items-center gap-3 px-3 py-2.5">
      <span className="min-w-0 flex-1">
        <span className="block truncate text-[14.5px] font-semibold text-ink">{row.form}</span>
        <span className="block text-[12.5px] text-muted">
          {row.label} · {clock(row.at)}
        </span>
        {row.error && <span className="mt-0.5 block text-[12.5px] font-semibold text-status-redText">{row.error}</span>}
      </span>
      {row.error && row.discard && (
        <button
          type="button"
          onClick={() => {
            if (confirm(`Discard this ${row.form} entry? It won't be recorded anywhere.`)) row.discard!();
          }}
          className="flex h-11 w-11 shrink-0 items-center justify-center rounded-full text-status-redText hover:bg-status-redBg"
          aria-label={`Discard this ${row.form} entry`}
        >
          <Trash2 className="h-[18px] w-[18px]" />
        </button>
      )}
    </li>
  );
}
