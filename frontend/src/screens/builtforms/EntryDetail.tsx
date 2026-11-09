import { useState } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import { useQueryClient } from "@tanstack/react-query";
import { CheckCircle2, ChevronLeft, ChevronRight, Circle, CircleDashed, Pencil, Printer, RotateCcw, Star, Trash2 } from "lucide-react";
import { Page, DesktopBackLink } from "@/components/shell/AppShell";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input, Textarea } from "@/components/ui/input";
import { Field } from "@/components/ui/label";
import { ToneBadge } from "@/components/ui/badge";
import { EmptyState, LoadingState } from "@/components/ui/misc";
import { Dialog, DialogBody, DialogContent, DialogFooter, DialogHeader } from "@/components/ui/dialog";
import { useToast } from "@/components/ui/toast";
import { AnswerList, FormRenderer } from "@/components/formkit/FormRenderer";
import { fillApi, submitErrors, useEntry, type CheckState, type DoneField, type EntryDetail } from "@/lib/builder";
import type { Errors, Values } from "@/lib/formEngine";
import { cn, errorMessage, formatDateTime } from "@/lib/utils";
import { deviceLabel, fillTimeText } from "@/lib/fillMeta";

const SOURCES: Record<string, string> = { app: "In the app", public: "Public link", share: "Share link", api: "API", mcp: "AI assistant (MCP)", import: "Imported" };

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

  /** Run it, refresh and say so; false when it didn't work (its error is shown). */
  async function act(fn: () => Promise<unknown>, done: string): Promise<boolean> {
    try {
      await fn();
      await refresh();
      toast(done);
      return true;
    } catch (e) {
      toast(errorMessage(e, "That didn't work."), "error");
      return false;
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
        <div className="grid gap-3 text-[13px] sm:grid-cols-2 lg:grid-cols-3">
          <Meta label="Submitted" value={formatDateTime(entry.createdAt)} />
          <Meta label="By" value={entry.createdByName} />
          {entry.sharedByName && <Meta label="Through the link of" value={entry.sharedByName} />}
          <Meta label="Site" value={entry.site?.name ?? "—"} />
          <Meta label="Source" value={`${SOURCES[entry.source] ?? entry.source} · form v${entry.formVersion}`} />
          <Meta label="Device" value={deviceLabel(entry.deviceKind)} />
          <Meta label="Time to fill" value={fillTimeText(entry.fillSeconds)} />
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

      {entry.followUp && (
        <FollowUpPanel
          entry={entry}
          canDo={data.canFollowUp}
          fields={data.followUpFields ?? []}
          checklist={data.followUpChecklist ?? []}
          onTick={(item, done) => act(() => fillApi.followUpItem(slug, id, item, done), done ? "Ticked off. They've been told." : "Unticked.")}
          onDone={(done, text, values) => act(() => fillApi.followUp(slug, id, done, text, values), done ? "Marked done. Whoever filed it has been told." : "Opened again.")}
        />
      )}

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

/**
 * The entry's follow-up: open until someone it's for marks it done, with what
 * they did; then whoever filed it is told. Done ones can be opened again.
 */
function FollowUpPanel({
  entry,
  canDo,
  fields,
  checklist,
  onTick,
  onDone,
}: {
  entry: EntryDetail["entry"];
  canDo: boolean;
  fields: DoneField[];
  checklist: CheckState[];
  onTick: (item: string, done: boolean) => Promise<boolean>;
  onDone: (done: boolean, note?: string, values?: Record<string, string>) => Promise<boolean>;
}) {
  const [text, setText] = useState("");
  const [values, setValues] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const f = entry.followUp!;
  const left = checklist.filter((c) => !c.done);
  const tick = async (c: CheckState) => {
    setBusy(true);
    try {
      await onTick(c.id, !c.done);
    } finally {
      setBusy(false);
    }
  };
  const missing = fields.filter((d) => d.required && !values[d.id]?.trim());
  const hasPassword = fields.some((d) => d.type === "password" && values[d.id]?.trim());
  const run = async (done: boolean) => {
    setBusy(true);
    try {
      const filled = Object.fromEntries(Object.entries(values).filter(([, v]) => v.trim()));
      // Kept until it works, so a failed send loses nothing they typed.
      if (await onDone(done, text.trim() || undefined, done && fields.length ? filled : undefined)) {
        setText("");
        setValues({});
      }
    } finally {
      setBusy(false);
    }
  };
  return (
    <Card className={cn("mb-4 p-5 print:hidden", f.status === "open" ? "border-status-amberText/40" : "")}>
      <div className="mb-3 flex items-center gap-2">
        {f.status === "open" ? <CircleDashed className="h-5 w-5 text-status-amberText" /> : <CheckCircle2 className="h-5 w-5 text-status-greenText" />}
        <p className="font-heading text-[15px] font-extrabold text-ink">Follow-up: {f.status === "open" ? "open" : "done"}</p>
        {f.status === "open" && f.reminders > 0 && <span className="text-micro text-muted">· {f.reminders} reminder{f.reminders === 1 ? "" : "s"} sent</span>}
        {checklist.length > 0 && <span className="ml-auto text-[12.5px] font-semibold text-muted">{checklist.length - left.length} of {checklist.length} done</span>}
      </div>
      {checklist.length > 0 && (
        <ul className="mb-3 divide-y divide-hairline rounded-input border border-hairline">
          {checklist.map((c) => {
            const can = canDo && f.status === "open";
            return (
              <li key={c.id} className="flex items-start gap-3 px-3 py-2.5">
                <button
                  type="button"
                  role="checkbox"
                  aria-checked={Boolean(c.done)}
                  aria-label={c.label}
                  disabled={!can || busy}
                  onClick={() => void tick(c)}
                  className={cn("mt-0.5 shrink-0 rounded-full", can ? "cursor-pointer hover:opacity-80" : "cursor-default")}
                >
                  {c.done ? <CheckCircle2 className="h-5 w-5 text-status-greenText" /> : <Circle className="h-5 w-5 text-muted" />}
                </button>
                <div className="min-w-0 flex-1">
                  <p className={cn("text-[13.5px] text-ink", c.done && "text-muted line-through decoration-hairline")}>{c.label}</p>
                  {c.done ? (
                    <p className="text-micro text-muted">Done by {c.done.byName}, {formatDateTime(c.done.at)}</p>
                  ) : (
                    c.help && <p className="text-micro text-muted">{c.help}</p>
                  )}
                </div>
              </li>
            );
          })}
        </ul>
      )}
      {f.status === "done" ? (
        <>
          <p className="text-[13.5px] text-ink">
            Done by <span className="font-semibold">{f.doneByName}</span>{f.doneAt ? `, ${formatDateTime(f.doneAt)}` : ""}.
          </p>
          {!!f.values?.length && (
            <dl className="mt-2 grid gap-x-4 gap-y-2 rounded-input border border-hairline px-3 py-2.5 text-[13.5px] sm:grid-cols-[minmax(140px,auto)_1fr]">
              {f.values.map((v) => (
                <div key={v.id} className="contents">
                  <dt className="text-muted">{v.label}</dt>
                  <dd className="min-w-0 whitespace-pre-wrap break-words text-ink">
                    {v.emailed ? <span className="text-muted">Emailed to {entry.createdByName}, not kept</span> : v.value}
                  </dd>
                </div>
              ))}
            </dl>
          )}
          {f.note && <p className="mt-2 whitespace-pre-wrap rounded-input bg-subtle px-3 py-2 text-[13.5px] text-ink">{f.note}</p>}
          {canDo && (
            <div className="mt-3">
              <Button variant="secondary" size="sm" disabled={busy} onClick={() => void run(false)}><RotateCcw className="h-4 w-4" /> Open it again</Button>
            </div>
          )}
        </>
      ) : canDo ? (
        <>
          <p className="mb-3 text-[13px] text-muted">
            {checklist.length
              ? `Tick each item off as it's done; ${entry.createdByName} is told. ${fields.some((d) => d.required || d.type === "password") ? "Then fill this in." : "Ticking the last one marks it done."}`
              : `When it's done, fill this in. ${entry.createdByName} is told.`}
          </p>
          {fields.length > 0 && (
            <div className="mb-3 grid gap-3 sm:grid-cols-2">
              {fields.map((d) => {
                const set = (v: string) => setValues((x) => ({ ...x, [d.id]: v }));
                const label = `${d.label}${d.required ? "" : " (optional)"}`;
                const hint = d.type === "password" ? `Emailed to ${entry.createdByName} once. Lantern Forms doesn't keep it.` : d.help;
                return (
                  <div key={d.id} className={cn(d.type === "textarea" && "sm:col-span-2")}>
                    <Field label={label} hint={hint}>
                      {d.type === "textarea" ? (
                        <Textarea aria-label={d.label} value={values[d.id] ?? ""} onChange={(e) => set(e.target.value)} maxLength={2000} className="min-h-[64px]" />
                      ) : (
                        <Input
                          aria-label={d.label}
                          type={d.type === "email" ? "email" : d.type === "date" ? "date" : "text"}
                          value={values[d.id] ?? ""}
                          onChange={(e) => set(e.target.value)}
                          maxLength={d.type === "password" ? 200 : 320}
                          autoComplete="off"
                          spellCheck={false}
                          data-1p-ignore={d.type === "password" ? "" : undefined}
                          data-lpignore={d.type === "password" ? "true" : undefined}
                        />
                      )}
                    </Field>
                  </div>
                );
              })}
            </div>
          )}
          <Field label={fields.length ? "Anything else (optional)" : undefined}>
            <Textarea value={text} onChange={(e) => setText(e.target.value)} maxLength={2000} placeholder="e.g. Accounts created, laptop handed over at orientation." className="min-h-[64px]" />
          </Field>
          <div className="mt-2 flex items-center justify-end gap-3">
            {left.length > 0 ? (
              <span className="text-[12.5px] text-muted">{left.length} item{left.length === 1 ? "" : "s"} still to tick off</span>
            ) : (
              missing.length > 0 && <span className="text-[12.5px] text-muted">Fill in {missing.map((d) => d.label).join(", ")}</span>
            )}
            <Button disabled={busy || missing.length > 0 || left.length > 0} onClick={() => void run(true)}>
              <CheckCircle2 className="h-4 w-4" /> {busy && hasPassword ? "Sending…" : "Mark as done"}
            </Button>
          </div>
        </>
      ) : (
        <p className="text-[13px] text-muted">Waiting for the people it's for to mark it done.</p>
      )}
    </Card>
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
