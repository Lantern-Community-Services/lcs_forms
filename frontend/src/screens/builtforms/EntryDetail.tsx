import { useRef, useState } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import { useQueryClient } from "@tanstack/react-query";
import { Archive, ArchiveRestore, CheckCircle2, ChevronLeft, ChevronRight, Circle, CircleDashed, MinusCircle, Pencil, PenLine, Printer, RotateCcw, Star, Trash2 } from "lucide-react";
import { SignaturePad, type SignaturePadHandle } from "@/components/attendance/SignaturePad";
import { Page, DesktopBackLink } from "@/components/shell/AppShell";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input, Textarea } from "@/components/ui/input";
import { Checkbox } from "@/components/ui/checkbox";
import { Field } from "@/components/ui/label";
import { ToneBadge } from "@/components/ui/badge";
import { EmptyState, LoadingState } from "@/components/ui/misc";
import { Dialog, DialogBody, DialogContent, DialogFooter, DialogHeader } from "@/components/ui/dialog";
import { useToast } from "@/components/ui/toast";
import { AnswerList, FormRenderer } from "@/components/formkit/FormRenderer";
import { fillApi, submitErrors, useEntry, type CheckState, type DoneField, type EntryDetail, type SignOffState } from "@/lib/builder";
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
        <h1 className="mr-auto font-heading text-title font-extrabold text-ink">{data.form.title}</h1>
        <Button variant="secondary" size="icon" disabled={!data.newerId} onClick={() => navigate(`/f/${slug}/entries/${data.newerId}`)} aria-label="Newer entry"><ChevronLeft className="h-4 w-4" /></Button>
        <Button variant="secondary" size="icon" disabled={!data.olderId} onClick={() => navigate(`/f/${slug}/entries/${data.olderId}`)} aria-label="Older entry"><ChevronRight className="h-4 w-4" /></Button>
        <Button variant="secondary" onClick={() => act(() => fillApi.star(slug, id, !entry.starred), entry.starred ? "Unstarred." : "Starred.")}>
          <Star className={cn("h-4 w-4", entry.starred && "fill-[#f5a524] text-[#f5a524]")} /> {entry.starred ? "Starred" : "Star"}
        </Button>
        <Button variant="secondary" onClick={() => window.print()}><Printer className="h-4 w-4" /> Print</Button>
        {data.isAdmin && !editing && <Button variant="secondary" onClick={() => setEditing(true)}><Pencil className="h-4 w-4" /> Edit</Button>}
        {data.canArchive && (
          <Button variant="secondary" onClick={() => act(() => fillApi.archive(slug, !entry.archivedAt, [id]), entry.archivedAt ? "Brought back from the archive." : "Archived. It's hidden from the entries list now.")}>
            {entry.archivedAt ? <><ArchiveRestore className="h-4 w-4" /> Bring back</> : <><Archive className="h-4 w-4" /> Archive</>}
          </Button>
        )}
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
        <div className="grid gap-3 text-label sm:grid-cols-2 lg:grid-cols-3">
          <Meta label="Submitted" value={formatDateTime(entry.createdAt)} />
          <Meta label="By" value={entry.createdByName} />
          {entry.sharedByName && <Meta label="Through the link of" value={entry.sharedByName} />}
          <Meta label="Site" value={entry.site?.name ?? "—"} />
          <Meta label="Source" value={`${SOURCES[entry.source] ?? entry.source} · form v${entry.formVersion}`} />
          <Meta label="Device" value={deviceLabel(entry.deviceKind)} />
          <Meta label="Time to fill" value={fillTimeText(entry.fillSeconds)} />
        </div>
        {entry.status === "voided" && (
          <p className="mt-3 rounded-input bg-status-redBg px-3 py-2 text-label text-status-redText">
            <ToneBadge tone="red">Void</ToneBadge> <span className="ml-1">{entry.voidReason}</span> — {entry.voidedByName}, {formatDateTime(entry.voidedAt)}
          </p>
        )}
        {entry.archivedAt && (
          <p className="mt-3 rounded-input bg-subtle px-3 py-2 text-label text-muted">
            <ToneBadge tone="neutral">Archived</ToneBadge> <span className="ml-1">by {entry.archivedByName}, {formatDateTime(entry.archivedAt)}</span>
          </p>
        )}
        {entry.updatedByName && <p className="mt-2 text-micro text-muted">Last edited by {entry.updatedByName}, {formatDateTime(entry.updatedAt)}</p>}
        {data.clinicalNotice && <p className="mt-2 text-micro text-muted print:hidden">Clinical record. Who opens or exports it is recorded.</p>}
      </Card>

      <Card className="mb-4 p-5">
        {editing ? (
          <>
            <p className="mb-4 rounded-input bg-subtle px-3 py-2 text-label text-muted">Editing as an admin. Fields hidden from the person filling in are shown too. Every change is written to the notes.</p>
            <FormRenderer doc={doc} slug={slug} mode="edit" initial={entry.values} user={null} onSubmit={(v) => saveEdit(v)} submitting={saving} serverErrors={editErrors} submitLabel="Save changes" />
            <Button variant="ghost" className="mt-2" onClick={() => setEditing(false)}>Cancel</Button>
          </>
        ) : (
          <AnswerList doc={doc} values={entry.values} slug={slug} />
        )}
      </Card>

      {!!data.signOffs?.length && !editing && <SignOffPanel slug={slug} id={id} signOffs={data.signOffs} onSigned={refresh} />}

      {entry.followUp && (
        <FollowUpPanel
          entry={entry}
          canDo={data.canFollowUp}
          fields={data.followUpFields ?? []}
          checklist={data.followUpChecklist ?? []}
          doneBefore={Boolean(data.followUpDoneBefore)}
          onTick={(item, done) => act(() => fillApi.followUpItem(slug, id, item, { done }), done ? "Ticked off." : "Unticked.")}
          onRemove={(item, removed) => act(() => fillApi.followUpItem(slug, id, item, { removed }), removed ? "Taken off the list for this person." : "Put back on the list.")}
          onDone={(done, text, values, tellAgain) =>
            act(
              () => fillApi.followUp(slug, id, done, text, values, tellAgain),
              !done ? "Opened again." : data.followUpDoneBefore && !tellAgain ? "Marked done again. Nobody was emailed." : "Marked done. Whoever filed it has been told."
            )
          }
        />
      )}

      {/* A clinical record leaves the site with its 42 CFR Part 2 notice. */}
      {data.clinicalNotice && <p className="hidden text-micro leading-snug text-ink print:mt-4 print:block">{data.clinicalNotice}</p>}

      <Card className="p-5 print:hidden">
        <p className="mb-3 font-heading text-body-lg font-extrabold text-ink">Notes</p>
        {data.notes.length === 0 && <p className="mb-3 text-label text-muted">No notes yet.</p>}
        <ul className="mb-4 space-y-3">
          {data.notes.map((n) => (
            <li key={n.id} className={cn("rounded-input px-3 py-2 text-body", n.kind === "system" ? "bg-subtle text-muted" : "border border-hairline text-ink")}>
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
  doneBefore,
  onTick,
  onRemove,
  onDone,
}: {
  entry: EntryDetail["entry"];
  canDo: boolean;
  fields: DoneField[];
  checklist: CheckState[];
  doneBefore: boolean;
  onTick: (item: string, done: boolean) => Promise<boolean>;
  onRemove: (item: string, removed: boolean) => Promise<boolean>;
  onDone: (done: boolean, note?: string, values?: Record<string, string>, tellAgain?: boolean) => Promise<boolean>;
}) {
  const [text, setText] = useState("");
  // Done before and opened again: nobody hears about it a second time unless this is ticked.
  const [tellAgain, setTellAgain] = useState(false);
  const quiet = doneBefore && !tellAgain;
  // Quietly, nothing is emailed, so there's no password to send.
  const shown = quiet ? fields.filter((d) => d.type !== "password") : fields;
  // Each box starts with what the follow-up fills in for this entry (Onboarding: first.last@lanterncommunity.org).
  const starts = () => Object.fromEntries(fields.filter((d) => d.prefill).map((d) => [d.id, d.prefill!]));
  const [values, setValues] = useState<Record<string, string>>(starts);
  const [busy, setBusy] = useState(false);
  const f = entry.followUp!;
  const counted = checklist.filter((c) => !c.removed);
  const left = counted.filter((c) => !c.done);
  const busyWhile = async (go: () => Promise<boolean>) => {
    setBusy(true);
    try {
      await go();
    } finally {
      setBusy(false);
    }
  };
  const tick = (c: CheckState) => busyWhile(() => onTick(c.id, !c.done));
  const remove = (c: CheckState) => busyWhile(() => onRemove(c.id, !c.removed));
  const missing = shown.filter((d) => d.required && !values[d.id]?.trim());
  const hasPassword = shown.some((d) => d.type === "password" && values[d.id]?.trim());
  const run = async (done: boolean) => {
    setBusy(true);
    try {
      const filled = Object.fromEntries(Object.entries(values).filter(([k, v]) => v.trim() && shown.some((d) => d.id === k)));
      // Kept until it works, so a failed send loses nothing they typed.
      if (await onDone(done, text.trim() || undefined, done && shown.length ? filled : undefined, done && doneBefore ? tellAgain : undefined)) {
        setText("");
        setValues({});
        setTellAgain(false);
      }
    } finally {
      setBusy(false);
    }
  };
  return (
    <Card className={cn("mb-4 p-5 print:hidden", f.status === "open" ? "border-status-amberText/40" : "")}>
      <div className="mb-3 flex items-center gap-2">
        {f.status === "open" ? <CircleDashed className="h-5 w-5 text-status-amberText" /> : <CheckCircle2 className="h-5 w-5 text-status-greenText" />}
        <p className="font-heading text-body-lg font-extrabold text-ink">Follow-up: {f.status === "open" ? "open" : "done"}</p>
        {f.status === "open" && f.reminders > 0 && <span className="text-micro text-muted">· {f.reminders} reminder{f.reminders === 1 ? "" : "s"} sent</span>}
        {counted.length > 0 && <span className="ml-auto text-label font-semibold text-muted">{counted.length - left.length} of {counted.length} done</span>}
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
                  disabled={!can || busy || Boolean(c.removed)}
                  onClick={() => void tick(c)}
                  className={cn("mt-0.5 shrink-0 rounded-full", can ? "cursor-pointer hover:opacity-80" : "cursor-default")}
                >
                  {c.done ? <CheckCircle2 className="h-5 w-5 text-status-greenText" /> : c.removed ? <MinusCircle className="h-5 w-5 text-muted" /> : <Circle className="h-5 w-5 text-muted" />}
                </button>
                <div className="min-w-0 flex-1">
                  <p className={cn("text-body text-ink", (c.done || c.removed) && "text-muted line-through decoration-hairline")}>{c.label}</p>
                  {c.done ? (
                    <p className="text-micro text-muted">Done by {c.done.byName}, {formatDateTime(c.done.at)}</p>
                  ) : c.removed ? (
                    <p className="text-micro text-muted">Not needed: taken off by {c.removed.byName}, {formatDateTime(c.removed.at)}</p>
                  ) : (
                    c.help && <p className="text-micro text-muted">{c.help}</p>
                  )}
                </div>
                {can && !c.done && (
                  <button
                    type="button"
                    disabled={busy}
                    onClick={() => void remove(c)}
                    className="shrink-0 rounded-input px-2 py-1 text-label font-semibold text-muted hover:bg-subtle hover:text-ink"
                    title={c.removed ? "Put it back on this person's list" : "Not needed for this person: take it off the list"}
                  >
                    {c.removed ? "Put back" : "Remove"}
                  </button>
                )}
              </li>
            );
          })}
        </ul>
      )}
      {f.status === "done" ? (
        <>
          <p className="text-body text-ink">
            Done by <span className="font-semibold">{f.doneByName}</span>{f.doneAt ? `, ${formatDateTime(f.doneAt)}` : ""}.
          </p>
          {!!f.values?.length && (
            <dl className="mt-2 grid gap-x-4 gap-y-2 rounded-input border border-hairline px-3 py-2.5 text-body sm:grid-cols-[minmax(140px,auto)_1fr]">
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
          {f.note && <p className="mt-2 whitespace-pre-wrap rounded-input bg-subtle px-3 py-2 text-body text-ink">{f.note}</p>}
          {canDo && (
            <div className="mt-3">
              <Button variant="secondary" size="sm" disabled={busy} onClick={() => void run(false)}><RotateCcw className="h-4 w-4" /> Open it again</Button>
            </div>
          )}
        </>
      ) : canDo ? (
        <>
          <p className="mb-3 text-label text-muted">
            {checklist.length
              ? `Tick each item off as it's done, or remove one this person doesn't need. ${fields.some((d) => d.required || d.type === "password") ? "Then fill this in." : "Ticking the last one marks it done."}`
              : quiet
                ? "When it's done, fill this in."
                : `When it's done, fill this in. ${entry.createdByName} is told.`}
          </p>
          {doneBefore && (
            <label className="mb-3 flex items-start gap-2.5 rounded-input bg-subtle px-3 py-2.5 text-label text-ink">
              <Checkbox className="mt-0.5" checked={tellAgain} onCheckedChange={(v) => setTellAgain(v === true)} />
              <span>
                <span className="font-semibold">Email {entry.createdByName} and everyone told again</span>
                <span className="block text-micro text-muted">
                  It was marked done before, so they've already heard. Tick this only if something changed, like a corrected username or a new password.
                </span>
              </span>
            </label>
          )}
          {shown.length > 0 && (
            <div className="mb-3 grid gap-3 sm:grid-cols-2">
              {shown.map((d) => {
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
          <Field label={shown.length ? "Anything else (optional)" : undefined}>
            <Textarea value={text} onChange={(e) => setText(e.target.value)} maxLength={2000} placeholder="e.g. Accounts created, laptop handed over at orientation." className="min-h-[64px]" />
          </Field>
          <div className="mt-2 flex items-center justify-end gap-3">
            {left.length > 0 ? (
              <span className="text-label text-muted">{left.length} item{left.length === 1 ? "" : "s"} still to tick off</span>
            ) : (
              missing.length > 0 && <span className="text-label text-muted">Fill in {missing.map((d) => d.label).join(", ")}</span>
            )}
            <Button disabled={busy || missing.length > 0 || left.length > 0} onClick={() => void run(true)}>
              <CheckCircle2 className="h-4 w-4" /> {busy && hasPassword ? "Sending…" : "Mark as done"}
            </Button>
          </div>
        </>
      ) : (
        <p className="text-label text-muted">Waiting for the people it's for to mark it done.</p>
      )}
    </Card>
  );
}

/**
 * Signatures signed after filing (a supervisor's, a licensed reviewer's): each
 * waits for the people it names, and one of them signs it here. The signature
 * itself shows with the answers above.
 */
function SignOffPanel({ slug, id, signOffs, onSigned }: { slug: string; id: string; signOffs: SignOffState[]; onSigned: () => Promise<unknown> }) {
  const [signing, setSigning] = useState<SignOffState | null>(null);
  const waiting = signOffs.filter((s) => s.state === "waiting");
  return (
    <Card className={cn("mb-4 p-5 print:hidden", waiting.length ? "border-status-amberText/40" : "")}>
      <div className="mb-3 flex items-center gap-2">
        {waiting.length ? <CircleDashed className="h-5 w-5 text-status-amberText" /> : <CheckCircle2 className="h-5 w-5 text-status-greenText" />}
        <p className="font-heading text-body-lg font-extrabold text-ink">{waiting.length ? `Sign-off: waiting for ${waiting.length === 1 ? "a signature" : `${waiting.length} signatures`}` : "Signed off"}</p>
      </div>
      <ul className="divide-y divide-hairline rounded-input border border-hairline">
        {signOffs.map((s) => (
          <li key={s.id} className="flex flex-wrap items-center gap-3 px-3 py-2.5">
            {s.signed ? <CheckCircle2 className="h-5 w-5 shrink-0 text-status-greenText" /> : <Circle className="h-5 w-5 shrink-0 text-muted" />}
            <div className="min-w-0 flex-1">
              <p className="text-body font-semibold text-ink">{s.label}</p>
              <p className="text-micro text-muted">{signOffLine(s)}</p>
            </div>
            {s.canSign && <Button size="sm" onClick={() => setSigning(s)}><PenLine className="h-4 w-4" /> Sign</Button>}
          </li>
        ))}
      </ul>
      {signing && <SignDialog slug={slug} id={id} signOff={signing} onClose={() => setSigning(null)} onSigned={onSigned} />}
    </Card>
  );
}

/** Where one sign-off stands, in a line: who signed it, what it waits for, who's asked. */
function signOffLine(s: SignOffState): string {
  if (s.signed) return `Signed by ${s.signed.byName}${s.signed.backup ? " (backup)" : ""}, ${formatDateTime(s.signed.at)}`;
  if (s.after) return `After ${s.after}. Then ${s.who} sign it.`;
  const days = s.backup ? `${s.backup.afterDays} day${s.backup.afterDays === 1 ? "" : "s"}` : "";
  const backup = !s.backup ? "" : s.backup.asked ? ` Its backup can sign it too now: ${s.backup.who}.` : ` If it waits ${days}, it goes to ${s.backup.who} too.`;
  return `Waiting for ${s.who}.${backup}${s.cantSignWhy ? ` ${s.cantSignWhy}` : ""}`;
}

const todayNY = () => new Date().toLocaleDateString("en-CA", { timeZone: "America/New_York" });

function SignDialog({ slug, id, signOff, onClose, onSigned }: { slug: string; id: string; signOff: SignOffState; onClose: () => void; onSigned: () => Promise<unknown> }) {
  const pad = useRef<SignaturePadHandle>(null);
  const toast = useToast();
  const [empty, setEmpty] = useState(true);
  const [busy, setBusy] = useState(false);
  const [errors, setErrors] = useState<Errors>({});
  // A date the signer fills in starts as today (the date signed).
  const [answers, setAnswers] = useState<Record<string, string>>(() => Object.fromEntries(signOff.fields.map((f) => [f.id, f.type === "date" ? todayNY() : ""])));
  const missing = signOff.fields.filter((f) => f.required && !answers[f.id]?.trim());

  async function sign() {
    const signature = pad.current?.toDataURL();
    if (!signature) {
      setErrors({ [signOff.id]: "Please sign." });
      return;
    }
    setBusy(true);
    setErrors({});
    try {
      const values = Object.fromEntries(Object.entries(answers).filter(([, v]) => v.trim()));
      await fillApi.sign(slug, id, signOff.id, signature, values);
      await onSigned();
      toast("Signed. Your name and the time are kept with it.");
      onClose();
    } catch (e) {
      setErrors(submitErrors(e));
      toast(errorMessage(e, "Couldn't sign it."), "error");
    } finally {
      setBusy(false);
    }
  }

  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent aria-describedby={undefined}>
        <DialogHeader title={signOff.label} subtitle={signOff.whatToDo ?? "Read the entry through, then sign. Your name and the time are kept with your signature."} />
        <DialogBody>
          {signOff.fields.length > 0 && (
            <div className="mb-3 grid gap-3 sm:grid-cols-2">
              {signOff.fields.map((f) => {
                const set = (v: string) => setAnswers((x) => ({ ...x, [f.id]: v }));
                const choices = f.choices ?? [];
                return (
                  <Field key={f.id} label={`${f.label || f.id}${f.required ? "" : " (optional)"}`} hint={errors[f.id] ?? f.description}>
                    {choices.length ? (
                      <select aria-label={f.label} value={answers[f.id] ?? ""} onChange={(e) => set(e.target.value)} className="h-11 w-full rounded-input border border-strongline bg-surface px-3 text-body md:h-9">
                        <option value="">Choose…</option>
                        {choices.map((c) => <option key={c.value} value={c.value}>{c.label}</option>)}
                      </select>
                    ) : f.type === "textarea" ? (
                      <Textarea aria-label={f.label} value={answers[f.id] ?? ""} onChange={(e) => set(e.target.value)} className="min-h-[64px]" />
                    ) : (
                      <Input
                        aria-label={f.label}
                        type={f.type === "date" ? "date" : f.type === "time" ? "time" : f.type === "number" ? "number" : f.type === "email" ? "email" : f.type === "phone" ? "tel" : "text"}
                        value={answers[f.id] ?? ""}
                        onChange={(e) => set(e.target.value)}
                        autoComplete="off"
                      />
                    )}
                  </Field>
                );
              })}
            </div>
          )}
          <p className="mb-1.5 text-label font-semibold text-ink">Signature</p>
          <div className={cn("overflow-hidden rounded-card border bg-white", errors[signOff.id] ? "border-status-redDot" : "border-hairline")}>
            <SignaturePad ref={pad} onChangeEmpty={setEmpty} className="h-40 w-full" />
          </div>
          <div className="mt-1.5 flex justify-between text-micro text-muted">
            <span>{errors[signOff.id] ?? "Sign with your finger, a pen or the mouse."}</span>
            <button type="button" onClick={() => pad.current?.clear()} className="font-semibold text-accent">Clear</button>
          </div>
        </DialogBody>
        <DialogFooter>
          <Button variant="secondary" onClick={onClose}>Cancel</Button>
          <Button disabled={busy || empty || missing.length > 0} onClick={() => void sign()}><PenLine className="h-4 w-4" /> {busy ? "Signing…" : "Sign"}</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
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
