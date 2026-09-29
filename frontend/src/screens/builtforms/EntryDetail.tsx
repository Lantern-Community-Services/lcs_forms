import { useState } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import { useQueryClient } from "@tanstack/react-query";
import { ChevronLeft, ChevronRight, Pencil, Printer, RotateCcw, Star, Trash2 } from "lucide-react";
import { Page, DesktopBackLink } from "@/components/shell/AppShell";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/input";
import { ToneBadge } from "@/components/ui/badge";
import { EmptyState, LoadingState } from "@/components/ui/misc";
import { Dialog, DialogBody, DialogContent, DialogFooter, DialogHeader } from "@/components/ui/dialog";
import { useToast } from "@/components/ui/toast";
import { AnswerList, FormRenderer } from "@/components/formkit/FormRenderer";
import { fillApi, submitErrors, useEntry } from "@/lib/builder";
import type { Errors, Values } from "@/lib/formEngine";
import { cn, errorMessage, formatDateTime } from "@/lib/utils";

const SOURCES: Record<string, string> = { app: "In the app", public: "Public link", api: "API", mcp: "AI assistant (MCP)", import: "Imported" };

export function BuiltFormEntryPage() {
  const { slug = "", id = "" } = useParams();
  const { data, isLoading, error } = useEntry(slug, id);
  const qc = useQueryClient();
  const toast = useToast();
  const navigate = useNavigate();
  const [voiding, setVoiding] = useState(false);
  const [reason, setReason] = useState("");
  const [editing, setEditing] = useState(false);
  const [saving, setSaving] = useState(false);
  const [editErrors, setEditErrors] = useState<Errors | undefined>();
  const [note, setNote] = useState("");

  const refresh = () => qc.invalidateQueries({ queryKey: ["fill", slug] });

  if (error) return <Page><Card><EmptyState title={errorMessage(error, "Couldn't load this entry.")} /></Card></Page>;
  if (isLoading || !data) return <LoadingState />;
  const { entry, doc } = data;

  async function act(fn: () => Promise<unknown>, done: string) {
    try {
      await fn();
      await refresh();
      toast(done);
    } catch (e) {
      toast(errorMessage(e, "That didn't work."), "error");
    }
  }

  async function saveEdit(values: Values) {
    setSaving(true);
    setEditErrors(undefined);
    try {
      await fillApi.updateEntry(slug, id, values);
      await refresh();
      setEditing(false);
      toast("Entry updated. The change is noted below.");
    } catch (e) {
      const errs = submitErrors(e);
      if (Object.keys(errs).length) setEditErrors(errs);
      toast(errorMessage(e, "Couldn't save."), "error");
    } finally {
      setSaving(false);
    }
  }

  return (
    <Page className="max-w-[900px]">
      <DesktopBackLink to={`/f/${slug}/entries`}>{data.form.title}: entries</DesktopBackLink>
      <div className="mb-4 flex flex-wrap items-center gap-2 print:hidden">
        <h1 className="mr-auto font-heading text-[22px] font-extrabold text-ink">{data.form.title}</h1>
        <Button variant="secondary" size="icon" disabled={!data.newerId} onClick={() => navigate(`/f/${slug}/entries/${data.newerId}`)} aria-label="Newer entry"><ChevronLeft className="h-4 w-4" /></Button>
        <Button variant="secondary" size="icon" disabled={!data.olderId} onClick={() => navigate(`/f/${slug}/entries/${data.olderId}`)} aria-label="Older entry"><ChevronRight className="h-4 w-4" /></Button>
        <Button variant="secondary" onClick={() => act(() => fillApi.star(slug, id, !entry.starred), entry.starred ? "Unstarred." : "Starred.")}>
          <Star className={cn("h-4 w-4", entry.starred && "fill-[#f5a524] text-[#f5a524]")} /> {entry.starred ? "Starred" : "Star"}
        </Button>
        <Button variant="secondary" onClick={() => window.print()}><Printer className="h-4 w-4" /> Print</Button>
        {data.isAdmin && !editing && <Button variant="secondary" onClick={() => setEditing(true)}><Pencil className="h-4 w-4" /> Edit</Button>}
        {entry.status === "active" && data.canVoid && <Button variant="outlineDanger" onClick={() => setVoiding(true)}>Void</Button>}
        {entry.status === "voided" && data.isAdmin && <Button variant="secondary" onClick={() => act(() => fillApi.restore(slug, id), "Entry restored.")}><RotateCcw className="h-4 w-4" /> Restore</Button>}
        {data.isAdmin && (
          <Button variant="ghost" size="icon" aria-label="Delete entry" onClick={async () => {
            if (!confirm("Delete this entry permanently? Its files go too. Voiding keeps a record; deleting doesn't.")) return;
            try {
              await fillApi.remove(slug, id);
              await refresh();
              navigate(`/f/${slug}/entries`);
              toast("Entry deleted.");
            } catch (e) {
              toast(errorMessage(e, "Couldn't delete."), "error");
            }
          }}><Trash2 className="h-4 w-4 text-status-redText" /></Button>
        )}
      </div>

      <Card className="mb-4 p-4">
        <div className="grid gap-3 text-[13px] sm:grid-cols-2 lg:grid-cols-4">
          <Meta label="Submitted" value={formatDateTime(entry.createdAt)} />
          <Meta label="By" value={entry.createdByName} />
          <Meta label="Site" value={entry.site?.name ?? "—"} />
          <Meta label="Source" value={`${SOURCES[entry.source] ?? entry.source} · form v${entry.formVersion}`} />
        </div>
        {entry.status === "voided" && (
          <p className="mt-3 rounded-input bg-status-redBg px-3 py-2 text-[13px] text-status-redText">
            <ToneBadge tone="red">Void</ToneBadge> <span className="ml-1">{entry.voidReason}</span> — {entry.voidedByName}, {formatDateTime(entry.voidedAt)}
          </p>
        )}
        {entry.updatedByName && <p className="mt-2 text-micro text-muted">Last edited by {entry.updatedByName}, {formatDateTime(entry.updatedAt)}</p>}
      </Card>

      <Card className="mb-4 p-5">
        {editing ? (
          <>
            <p className="mb-4 rounded-input bg-subtle px-3 py-2 text-[13px] text-muted">Editing as an admin. Fields hidden from the person filling in are shown too. Every change is written to the notes.</p>
            <FormRenderer doc={doc} slug={slug} mode="edit" initial={entry.values} user={null} onSubmit={(v) => saveEdit(v)} submitting={saving} serverErrors={editErrors} submitLabel="Save changes" />
            <Button variant="ghost" className="mt-2" onClick={() => setEditing(false)}>Cancel</Button>
          </>
        ) : (
          <AnswerList doc={doc} values={entry.values} slug={slug} />
        )}
      </Card>

      <Card className="p-5 print:hidden">
        <p className="mb-3 font-heading text-[15px] font-extrabold text-ink">Notes</p>
        {data.notes.length === 0 && <p className="mb-3 text-[13px] text-muted">No notes yet.</p>}
        <ul className="mb-4 space-y-3">
          {data.notes.map((n) => (
            <li key={n.id} className={cn("rounded-input px-3 py-2 text-[13.5px]", n.kind === "system" ? "bg-subtle text-muted" : "border border-hairline text-ink")}>
              <p className="whitespace-pre-wrap">{n.body}</p>
              <p className="mt-1 text-micro text-muted">{n.authorName} · {formatDateTime(n.createdAt)}</p>
            </li>
          ))}
        </ul>
        <Textarea value={note} onChange={(e) => setNote(e.target.value)} placeholder="Add a note for whoever looks at this next…" className="min-h-[70px]" />
        <div className="mt-2 flex justify-end">
          <Button disabled={!note.trim()} onClick={() => act(async () => { await fillApi.note(slug, id, note.trim()); setNote(""); }, "Note added.")}>Add note</Button>
        </div>
      </Card>

      <Dialog open={voiding} onOpenChange={setVoiding}>
        <DialogContent aria-describedby={undefined}>
          <DialogHeader title="Void this entry?" subtitle="It stays on record, marked void, and stops counting in exports of active entries." />
          <DialogBody>
            <Textarea autoFocus value={reason} onChange={(e) => setReason(e.target.value)} placeholder="Why? (e.g. entered twice, wrong resident)" />
          </DialogBody>
          <DialogFooter>
            <Button variant="secondary" onClick={() => setVoiding(false)}>Cancel</Button>
            <Button variant="danger" disabled={!reason.trim()} onClick={() => act(async () => { await fillApi.void(slug, id, reason.trim()); setVoiding(false); setReason(""); }, "Entry voided.")}>Void entry</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
      <p className="mt-4 text-center text-micro text-muted"><Link to={`/f/${slug}/entries`} className="font-semibold text-accent">Back to all entries</Link></p>
    </Page>
  );
}

function Meta({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <p className="text-micro font-bold uppercase tracking-[0.04em] text-muted">{label}</p>
      <p className="mt-0.5 text-ink">{value}</p>
    </div>
  );
}
