import { useRef, useState } from "react";
import { Link } from "react-router-dom";
import {
  ArrowRightLeft, CheckCircle2, CircleMinus, ClipboardList, Download, FileImage, FileText, Files, History, LogIn, LogOut, Paperclip, Plane, Plus, RotateCcw, Trash2, UserMinus,
} from "lucide-react";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Field } from "@/components/ui/label";
import { Select } from "@/components/ui/select";
import { LoadMore, Spinner } from "@/components/ui/misc";
import { ResponsiveDialog } from "@/components/ui/responsive-dialog";
import { useToast } from "@/components/ui/toast";
import {
  documentsApi, documentUrl, fileSize, uploadDocument, useClientDocuments, useClientRecordRefresh, useClientTimeline,
  type ClientDocument, type DocumentsResponse, type TimelineItem, type TimelineKind,
} from "@/lib/clientRecord";
import { ApiError } from "@/lib/api";
import { isSample } from "@/lib/tour/sampleData";
import { cn, errorMessage, formatDate, formatDay } from "@/lib/utils";
import type { Tenant } from "@/lib/types";

/**
 * A resident's whole record on their page (case management, for people with
 * client information): their documents (PlanStreet's case attachments) and the
 * timeline of everything about them (its case activity list) — form entries
 * they could open, moves, time away, checklist items done and documents added.
 */

// ── Documents ────────────────────────────────────────────────────────────

export function DocumentsCard({ tenant }: { tenant: Tenant }) {
  const { data, error } = useClientDocuments(tenant.id, true);
  const [adding, setAdding] = useState(false);

  // The tour's sample residents have no record; a switch or permission that changed since the page loaded hides the card.
  if (isSample(tenant.id) || (error instanceof ApiError && (error.status === 403 || error.status === 404))) return null;
  if (error) return <Card className="mb-4 p-5 text-label text-status-redText">{errorMessage(error, "Could not load the documents.")}</Card>;
  if (!data) {
    return <Card className="mb-4 flex items-center gap-2 p-5 text-label text-muted"><Spinner className="h-4 w-4" /> Loading documents…</Card>;
  }
  return (
    <Card className="page-list-item-enter mb-4 p-5" style={{ animationDelay: "60ms" }}>
      <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
        <p className="kicker flex items-center gap-1.5"><Files className="h-3.5 w-3.5" /> Documents</p>
        {data.canEdit && (
          <Button size="sm" variant="secondary" onClick={() => setAdding(true)} className="min-h-[40px] md:min-h-0">
            <Plus className="h-3.5 w-3.5" /> Add document
          </Button>
        )}
      </div>
      {data.items.length === 0 ? (
        <p className="text-label text-muted">No documents yet.{data.canEdit ? " Add their ID, lease or a signed release here." : ""}</p>
      ) : (
        <ul className="divide-y divide-hairline">
          {data.items.map((d) => <DocumentLine key={d.id} tenantId={tenant.id} doc={d} canEdit={data.canEdit} />)}
        </ul>
      )}
      {adding && <AddDocumentDialog tenantId={tenant.id} meta={data} onClose={() => setAdding(false)} />}
    </Card>
  );
}

function DocumentLine({ tenantId, doc, canEdit }: { tenantId: string; doc: ClientDocument; canEdit: boolean }) {
  const toast = useToast();
  const refresh = useClientRecordRefresh(tenantId);
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  const Icon = doc.mime.startsWith("image/") ? FileImage : FileText;

  async function remove() {
    setBusy(true);
    try {
      await documentsApi.remove(tenantId, doc.id);
      await refresh();
      toast("Removed.");
    } catch (e) {
      toast(errorMessage(e, "Could not remove it."), "error");
      setBusy(false);
    }
  }

  return (
    <li className="py-2.5">
      <div className="flex items-center gap-3">
        <Icon className="h-5 w-5 shrink-0 text-muted" />
        <span className="min-w-0 flex-1">
          <a href={documentUrl(tenantId, doc.id)} target="_blank" rel="noreferrer" className="block truncate text-body font-semibold text-accent hover:underline">
            {doc.label ?? doc.name}
          </a>
          <span className="block truncate text-micro text-muted">
            {doc.kindLabel} · {doc.label ? `${doc.name} · ` : ""}{fileSize(doc.size)} · added by {doc.createdByName}, {formatDate(doc.createdAt)}
          </span>
        </span>
        {!confirming && (
          <span className="flex shrink-0 gap-1">
            <a href={documentUrl(tenantId, doc.id, true)} className="inline-flex h-9 w-9 items-center justify-center rounded-input text-accent hover:bg-subtle2" aria-label={`Download ${doc.label ?? doc.name}`} title="Download">
              <Download className="h-4 w-4" />
            </a>
            {canEdit && (
              <button type="button" onClick={() => setConfirming(true)} className="inline-flex h-9 w-9 items-center justify-center rounded-input text-status-redText hover:bg-status-redBg" aria-label={`Remove ${doc.label ?? doc.name}`} title="Remove">
                <Trash2 className="h-4 w-4" />
              </button>
            )}
          </span>
        )}
      </div>
      {confirming && (
        <div className="mt-2 flex flex-wrap items-center gap-2 rounded-input bg-status-redBg px-3 py-2 text-label text-status-redText">
          <span className="flex-1">Remove this document from their record?</span>
          <Button size="sm" variant="secondary" onClick={() => setConfirming(false)} disabled={busy}>Keep it</Button>
          <Button size="sm" variant="danger" onClick={() => void remove()} disabled={busy}>{busy ? "Removing…" : "Remove"}</Button>
        </div>
      )}
    </li>
  );
}

function AddDocumentDialog({ tenantId, meta, onClose }: { tenantId: string; meta: DocumentsResponse; onClose: () => void }) {
  const toast = useToast();
  const refresh = useClientRecordRefresh(tenantId);
  const input = useRef<HTMLInputElement>(null);
  const [file, setFile] = useState<File | null>(null);
  const [kind, setKind] = useState("");
  const [label, setLabel] = useState("");
  const [busy, setBusy] = useState(false);
  const maxMb = Math.round(meta.maxBytes / 1024 / 1024);

  async function save() {
    if (!file) return toast("Choose the file.", "error");
    if (!kind) return toast("Pick what kind of document it is.", "error");
    // Photos are shrunk before they go, so only other files are held to the limit here.
    if (!file.type.startsWith("image/") && file.size > meta.maxBytes) return toast(`Documents can be at most ${maxMb} MB.`, "error");
    setBusy(true);
    try {
      await uploadDocument(tenantId, file, kind, label.trim());
      await refresh();
      toast("Added.");
      onClose();
    } catch (e) {
      toast(errorMessage(e, "Could not add it."), "error");
      setBusy(false);
    }
  }

  return (
    <ResponsiveDialog
      open
      onOpenChange={(o) => !o && !busy && onClose()}
      title="Add a document"
      footer={
        <>
          <Button variant="secondary" onClick={onClose} disabled={busy}>Cancel</Button>
          <Button onClick={() => void save()} disabled={busy || !file || !kind}>{busy ? "Adding…" : "Add"}</Button>
        </>
      }
    >
      <div className="space-y-4">
        <Field label="File" hint={`A PDF, a photo or a Word file, up to ${maxMb} MB.`}>
          <input ref={input} type="file" accept={meta.accept} className="sr-only" onChange={(e) => setFile(e.target.files?.[0] ?? null)} />
          <div className="flex flex-wrap items-center gap-2">
            <Button type="button" variant="secondary" onClick={() => input.current?.click()} disabled={busy} className="min-h-[44px] md:min-h-9">
              <Paperclip className="h-4 w-4" /> {file ? "Choose another" : "Choose a file"}
            </Button>
            {file && <span className="min-w-0 truncate text-label text-ink">{file.name} · {fileSize(file.size)}</span>}
          </div>
        </Field>
        <Field label="What is it?">
          <Select value={kind} onChange={(e) => setKind(e.target.value)} placeholder="Pick one…" options={meta.kinds.map((k) => ({ value: k.key, label: k.label }))} className="min-h-[44px] md:min-h-9" />
        </Field>
        <Field label="Label" hint="Optional. For example: Lease renewal 2026.">
          <Input value={label} onChange={(e) => setLabel(e.target.value)} maxLength={200} className="min-h-[44px] md:min-h-9" />
        </Field>
      </div>
    </ResponsiveDialog>
  );
}

// ── Timeline ─────────────────────────────────────────────────────────────

const ICONS: Record<TimelineKind, typeof FileText> = {
  entry: ClipboardList,
  moved_in: LogIn,
  transferred: ArrowRightLeft,
  moved_out: LogOut,
  removed: UserMinus,
  away: Plane,
  back: RotateCcw,
  task_done: CheckCircle2,
  task_skipped: CircleMinus,
  document: Paperclip,
};

const TIME_FMT = new Intl.DateTimeFormat("en-US", { hour: "numeric", minute: "2-digit" });

/** The day an item belongs under: its own day, or the day of its time here. */
function dayOf(i: TimelineItem): string {
  if (i.day) return i.day;
  const d = new Date(i.at);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

export function TimelineCard({ tenant }: { tenant: Tenant }) {
  const { data, isLoading, isError, error, fetchNextPage, hasNextPage, isFetchingNextPage } = useClientTimeline(tenant.id, true);
  const items = data?.pages.flatMap((p) => p.items) ?? [];
  const days: { day: string; items: TimelineItem[] }[] = [];
  for (const i of items) {
    const d = dayOf(i);
    if (days[days.length - 1]?.day === d) days[days.length - 1].items.push(i);
    else days.push({ day: d, items: [i] });
  }

  if (isSample(tenant.id) || (error instanceof ApiError && (error.status === 403 || error.status === 404))) return null;
  return (
    <Card className="page-list-item-enter mb-4 p-5" style={{ animationDelay: "65ms" }}>
      <div className="mb-3 flex flex-wrap items-baseline justify-between gap-2">
        <p className="kicker flex items-center gap-1.5"><History className="h-3.5 w-3.5" /> Timeline</p>
        <p className="text-micro text-muted">Forms, moves, checklist and documents, newest first</p>
      </div>
      {isLoading ? (
        <p className="flex items-center gap-2 text-label text-muted"><Spinner className="h-4 w-4" /> Loading…</p>
      ) : isError ? (
        <p className="text-label text-status-redText">{errorMessage(error, "Could not load the timeline.")}</p>
      ) : items.length === 0 ? (
        <p className="text-label text-muted">Nothing yet. Forms filled in about them, their moves and their checklist show here.</p>
      ) : (
        <>
          <ol className="space-y-4">
            {days.map((g) => (
              <li key={g.day}>
                <p className="mb-1.5 text-micro font-bold uppercase tracking-wide text-muted">{formatDay(g.day)}</p>
                <ul className="space-y-2.5 border-l border-hairline pl-4">
                  {g.items.map((i) => <TimelineLine key={i.key} item={i} tenantId={tenant.id} />)}
                </ul>
              </li>
            ))}
          </ol>
          {hasNextPage && <LoadMore loading={isFetchingNextPage} onClick={() => void fetchNextPage()}>Show older</LoadMore>}
        </>
      )}
    </Card>
  );
}

function TimelineLine({ item, tenantId }: { item: TimelineItem; tenantId: string }) {
  const Icon = ICONS[item.kind] ?? ClipboardList;
  const e = item.entry;
  // The day is the heading above; things with a time show it.
  const meta = [item.day ? null : TIME_FMT.format(new Date(item.at)), item.by, item.site].filter(Boolean).join(" · ");
  const title = e ? (
    <Link to={e.link} className="font-semibold text-accent hover:underline">{item.title}</Link>
  ) : item.document ? (
    <a href={documentUrl(tenantId, item.document.id)} target="_blank" rel="noreferrer" className="font-semibold text-accent hover:underline">{item.title}</a>
  ) : (
    <span className="font-semibold text-ink">{item.title}</span>
  );
  return (
    <li className="relative text-label">
      <span className="absolute -left-[25px] top-0.5 flex h-[18px] w-[18px] items-center justify-center rounded-full bg-surface">
        <Icon className={cn("h-3.5 w-3.5", item.kind === "task_done" ? "text-status-greenDot" : item.kind === "moved_out" || item.kind === "removed" ? "text-status-redText" : "text-muted")} />
      </span>
      <p className="text-ink">{title}</p>
      {item.detail && <p className="text-muted">{item.detail}</p>}
      {e && <EntryBadges entry={e} />}
      {meta && <p className="text-micro text-muted">{meta}</p>}
    </li>
  );
}

function EntryBadges({ entry }: { entry: NonNullable<TimelineItem["entry"]> }) {
  const badges: { text: string; tone: "amber" | "green" | "plain" }[] = [];
  if (entry.signOff) badges.push(entry.signOff.status === "waiting" ? { text: "Waiting for sign-off", tone: "amber" } : { text: `Signed${entry.signOff.signed.length ? ` by ${entry.signOff.signed.join(", ")}` : ""}`, tone: "green" });
  if (entry.followUp) badges.push(entry.followUp.status === "open" ? { text: "Follow-up open", tone: "amber" } : { text: "Follow-up done", tone: "green" });
  if (entry.noteCount > 0) badges.push({ text: `${entry.noteCount} ${entry.noteCount === 1 ? "note" : "notes"}`, tone: "plain" });
  if (entry.archived) badges.push({ text: "Archived", tone: "plain" });
  if (!badges.length) return null;
  return (
    <p className="mt-0.5 flex flex-wrap gap-1">
      {badges.map((b) => (
        <span
          key={b.text}
          className={cn(
            "rounded-pill px-2 py-0.5 text-micro font-bold",
            b.tone === "amber" ? "bg-status-amberBg text-status-amberText" : b.tone === "green" ? "bg-status-greenBg text-status-greenText" : "bg-subtle2 text-ink"
          )}
        >
          {b.text}
        </span>
      ))}
    </p>
  );
}
