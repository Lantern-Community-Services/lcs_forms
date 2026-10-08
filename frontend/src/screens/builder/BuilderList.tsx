import { FormBackupBar } from "@/components/FormBackupBar";
import { DeleteFormDialog } from "@/components/DeleteFormDialog";
import { useRef, useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { useQueryClient } from "@tanstack/react-query";
import { Code2, Download, FileUp, MoreHorizontal, Plus, Sparkles } from "lucide-react";
import { Page, PageHeader } from "@/components/shell/AppShell";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Field } from "@/components/ui/label";
import { ToneBadge } from "@/components/ui/badge";
import { EmptyState, LoadingState } from "@/components/ui/misc";
import { Dialog, DialogBody, DialogContent, DialogFooter, DialogHeader } from "@/components/ui/dialog";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { useToast } from "@/components/ui/toast";
import { CodeEditor } from "@/components/formkit/CodeEditor";
import { builderApi, builderKeys, docProblems, formPath, useBuiltForms, type BuiltFormSummary, type ImportResult } from "@/lib/builder";
import { FORM_TEMPLATES } from "@/lib/formTemplates";
import { formIcon } from "@/lib/formIcons";
import { cn, errorMessage, relativeTime } from "@/lib/utils";

export function StatusBadge({ status, unpublished }: { status: string; unpublished?: boolean }) {
  const tone = status === "published" ? "green" : status === "closed" ? "amber" : status === "archived" ? "neutral" : "blue";
  const label = status === "published" ? "Live" : status === "closed" ? "Closed" : status === "archived" ? "Archived" : "Draft";
  return (
    <span className="inline-flex items-center gap-1.5">
      <ToneBadge tone={tone}>{label}</ToneBadge>
      {unpublished && status !== "draft" && <ToneBadge tone="violet" dot={false}>Unpublished changes</ToneBadge>}
    </span>
  );
}

const ACCESS: Record<string, string> = { signed_in: "Staff", roles: "Some roles", public: "Public" };

/** Admin → Form builder: every built form, plus new / import / export. */
export function AdminBuilderList() {
  const [archived, setArchived] = useState(false);
  const { data: forms, isLoading } = useBuiltForms(archived);
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const [creating, setCreating] = useState(false);
  const [importing, setImporting] = useState(false);
  const [deleting, setDeleting] = useState<BuiltFormSummary | null>(null);
  const qc = useQueryClient();
  const toast = useToast();
  const navigate = useNavigate();
  const refresh = () => qc.invalidateQueries({ queryKey: builderKeys.all });

  async function run(fn: () => Promise<unknown>, done: string) {
    try {
      await fn();
      await refresh();
      toast(done);
    } catch (e) {
      toast(errorMessage(e, "That didn't work."), "error");
    }
  }

  const toggle = (id: string) => setPicked((s) => { const n = new Set(s); if (n.has(id)) n.delete(id); else n.add(id); return n; });

  return (
    <Page className="max-w-[1100px]">
      <PageHeader
        title="Form builder"
        subtitle="Build forms here, in code, from Gravity Forms, or with an AI assistant. New forms are drafts until you publish them."
        actions={
          <>
            {picked.size > 0 && (
              <Button variant="secondary" onClick={() => run(() => builderApi.exportFile([...picked]), "Exported.")}><Download className="h-4 w-4" /> Export {picked.size}</Button>
            )}
            <Button variant="secondary" onClick={() => setImporting(true)}><FileUp className="h-4 w-4" /> Import</Button>
            <Button onClick={() => setCreating(true)}><Plus className="h-4 w-4" /> New form</Button>
          </>
        }
      />
      <FormBackupBar />

      {isLoading ? <LoadingState /> : !forms?.length ? (
        <Card>
          <EmptyState title={archived ? "No archived forms" : "No forms yet"} hint="Start one from a template, paste JSON, import a Gravity Forms export, or connect an AI assistant (Admin → AI form builder)." />
          <div className="flex justify-center gap-2 pb-8">
            <Button onClick={() => setCreating(true)}><Plus className="h-4 w-4" /> New form</Button>
            <Button variant="secondary" onClick={() => setImporting(true)}><FileUp className="h-4 w-4" /> Import</Button>
          </div>
        </Card>
      ) : (
        <Card>
          <ul>
            {forms.map((f) => {
              const Icon = formIcon(f.icon ?? "clipboard");
              return (
                <li key={f.id} className="flex items-center gap-3 border-b border-hairline px-4 py-3 last:border-0 hover:bg-rowhover/50">
                  <input type="checkbox" aria-label={`Select ${f.title}`} checked={picked.has(f.id)} onChange={() => toggle(f.id)} className="h-4 w-4 accent-[rgb(var(--c-brand))]" />
                  <span className="grid h-9 w-9 shrink-0 place-items-center rounded-panel bg-navsel text-accent dark:text-white"><Icon className="h-[18px] w-[18px]" /></span>
                  <Link to={`/admin/builder/${f.id}`} className="min-w-0 flex-1">
                    <p className="truncate text-[14px] font-semibold text-ink">{f.title}</p>
                    <p className="truncate text-micro text-muted">
                      {formPath(f.slug, f.access)} · {f.fieldCount} field{f.fieldCount === 1 ? "" : "s"} · {ACCESS[f.access]} · edited {relativeTime(f.updatedAt)}{f.updatedByName ? ` by ${f.updatedByName}` : ""}
                    </p>
                  </Link>
                  <div className="hidden sm:block"><StatusBadge status={f.status} unpublished={f.unpublishedChanges} /></div>
                  <Link to={`/f/${f.slug}/entries`} className="hidden w-24 text-right text-[13px] text-muted hover:text-accent md:block">
                    <span className="tabular font-semibold text-ink">{f.entryCount.toLocaleString()}</span> entr{f.entryCount === 1 ? "y" : "ies"}
                  </Link>
                  <RowMenu form={f} run={run} onOpen={() => navigate(`/admin/builder/${f.id}`)} onDelete={() => setDeleting(f)} />
                </li>
              );
            })}
          </ul>
        </Card>
      )}
      <div className="mt-3 flex justify-end">
        <button onClick={() => setArchived(!archived)} className="text-[13px] font-semibold text-accent">{archived ? "Hide archived forms" : "Show archived forms"}</button>
      </div>

      <NewFormDialog open={creating} onClose={() => setCreating(false)} onCreated={(id) => { void refresh(); navigate(`/admin/builder/${id}`); }} />
      <ImportDialog open={importing} onClose={() => setImporting(false)} onDone={refresh} />
      <DeleteFormDialog
        form={deleting}
        noun="form"
        onCancel={() => setDeleting(null)}
        onConfirm={async () => {
          const f = deleting!;
          await run(() => builderApi.remove(f.id, f.entryCount > 0), f.entryCount > 0 ? "Deleted, with its entries." : "Deleted.");
          setDeleting(null);
        }}
      />
    </Page>
  );
}

function RowMenu({ form: f, run, onOpen, onDelete }: { form: BuiltFormSummary; run: (fn: () => Promise<unknown>, done: string) => void; onOpen: () => void; onDelete: () => void }) {
  const navigate = useNavigate();
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild><Button variant="ghost" size="icon" aria-label={`Actions for ${f.title}`}><MoreHorizontal className="h-4 w-4" /></Button></DropdownMenuTrigger>
      <DropdownMenuContent align="end">
        <DropdownMenuItem onSelect={onOpen}>Edit</DropdownMenuItem>
        <DropdownMenuItem onSelect={() => navigate(formPath(f.slug, f.access))}>Open form</DropdownMenuItem>
        <DropdownMenuItem onSelect={() => navigate(`/f/${f.slug}/entries`)}>Entries</DropdownMenuItem>
        <DropdownMenuSeparator />
        <DropdownMenuItem onSelect={() => run(() => builderApi.duplicate(f.id), "Duplicated.")}>Duplicate</DropdownMenuItem>
        <DropdownMenuItem onSelect={() => run(() => builderApi.exportFile([f.id]), "Exported.")}>Export form</DropdownMenuItem>
        <DropdownMenuItem onSelect={() => run(() => builderApi.exportFile([f.id], { entries: true }), "Exported with entries.")}>Export with entries</DropdownMenuItem>
        <DropdownMenuSeparator />
        {f.status === "published" && <DropdownMenuItem onSelect={() => run(() => builderApi.setStatus(f.id, "closed"), "Closed — it no longer takes entries.")}>Close to new entries</DropdownMenuItem>}
        {f.status === "closed" && <DropdownMenuItem onSelect={() => run(() => builderApi.setStatus(f.id, "published"), "Reopened.")}>Reopen</DropdownMenuItem>}
        {f.status !== "archived" ? (
          <DropdownMenuItem onSelect={() => run(() => builderApi.setStatus(f.id, "archived"), "Archived. Entries are kept.")}>Archive</DropdownMenuItem>
        ) : (
          <DropdownMenuItem onSelect={() => run(() => builderApi.setStatus(f.id, "draft"), "Unarchived.")}>Unarchive</DropdownMenuItem>
        )}
        <DropdownMenuItem onSelect={onDelete}>
          <span className="text-status-redText">Delete…</span>
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

function NewFormDialog({ open, onClose, onCreated }: { open: boolean; onClose: () => void; onCreated: (id: string) => void }) {
  const [mode, setMode] = useState<"template" | "code">("template");
  const [title, setTitle] = useState("");
  const [template, setTemplate] = useState("blank");
  const [code, setCode] = useState(() => JSON.stringify(FORM_TEMPLATES[0].build(), null, 2));
  const [problems, setProblems] = useState<{ path: string; message: string }[]>([]);
  const [busy, setBusy] = useState(false);
  const toast = useToast();

  async function create() {
    setBusy(true);
    setProblems([]);
    try {
      let doc;
      if (mode === "code") {
        try {
          doc = JSON.parse(code);
        } catch (e) {
          setProblems([{ path: "", message: `Not valid JSON: ${e instanceof Error ? e.message : e}` }]);
          return;
        }
      } else {
        doc = FORM_TEMPLATES.find((t) => t.key === template)!.build();
        if (title.trim()) doc.title = title.trim();
      }
      const row = await builderApi.create({ doc });
      onClose();
      onCreated(row.id);
    } catch (e) {
      const p = docProblems(e);
      if (p.length) setProblems(p);
      else toast(errorMessage(e, "Couldn't create the form."), "error");
    } finally {
      setBusy(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={(o) => !o && onClose()}>
      <DialogContent aria-describedby={undefined} className="w-[min(760px,calc(100vw-2rem))]">
        <DialogHeader title="New form" />
        <DialogBody className="max-h-[70vh] overflow-y-auto">
          <div className="mb-4 inline-flex rounded-input border border-hairline p-0.5">
            {([["template", "Start from a template", Sparkles], ["code", "Write it in code", Code2]] as const).map(([k, label, Icon]) => (
              <button key={k} onClick={() => setMode(k)} className={cn("inline-flex items-center gap-1.5 rounded-[5px] px-3 py-1.5 text-[13px] font-semibold", mode === k ? "bg-navy text-white" : "text-muted hover:text-ink")}>
                <Icon className="h-3.5 w-3.5" /> {label}
              </button>
            ))}
          </div>
          {mode === "template" ? (
            <>
              <Field label="Title" hint="You can change it later."><Input autoFocus value={title} onChange={(e) => setTitle(e.target.value)} placeholder={FORM_TEMPLATES.find((t) => t.key === template)?.build().title} /></Field>
              <div className="mt-4 grid gap-2 sm:grid-cols-2">
                {FORM_TEMPLATES.map((t) => (
                  <button key={t.key} onClick={() => setTemplate(t.key)} className={cn("rounded-card border p-3 text-left", template === t.key ? "border-navy bg-navsel" : "border-hairline hover:border-strongline")}>
                    <p className="text-[14px] font-semibold text-ink">{t.name}</p>
                    <p className="mt-0.5 text-[12.5px] text-muted">{t.blurb}</p>
                  </button>
                ))}
              </div>
            </>
          ) : (
            <>
              <p className="mb-2 text-[13px] text-muted">Paste or write an lcs-form document. The format is documented under Admin → AI form builder, and the builder's Code tab shows any form as code.</p>
              <CodeEditor value={code} onChange={setCode} minHeight={320} />
            </>
          )}
          {problems.length > 0 && <ProblemList problems={problems} />}
        </DialogBody>
        <DialogFooter>
          <Button variant="secondary" onClick={onClose}>Cancel</Button>
          <Button onClick={create} disabled={busy}>Create draft</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

export function ProblemList({ problems }: { problems: { path: string; message: string }[] }) {
  return (
    <ul className="mt-3 max-h-48 space-y-1 overflow-y-auto rounded-input border border-status-redDot/50 bg-status-redBg p-3 text-[12.5px] text-status-redText">
      {problems.map((p, i) => (
        <li key={i}><code className="font-semibold">{p.path || "(form)"}</code> — {p.message}</li>
      ))}
    </ul>
  );
}

function ImportDialog({ open, onClose, onDone }: { open: boolean; onClose: () => void; onDone: () => void }) {
  const fileRef = useRef<HTMLInputElement>(null);
  const [text, setText] = useState("");
  const [fileName, setFileName] = useState("");
  const [publish, setPublish] = useState(false);
  const [withEntries, setWithEntries] = useState(false);
  const [result, setResult] = useState<ImportResult | null>(null);
  const [busy, setBusy] = useState(false);
  const toast = useToast();

  const kind = (() => {
    try {
      const j = JSON.parse(text);
      if (j?.format === "lcs-form") return "A Lantern form";
      if (j?.format === "lcs-form-bundle") return `A Lantern bundle of ${j.forms?.length ?? 0} form(s)${j.forms?.some((f: { entries?: unknown[] }) => f.entries?.length) ? " with entries" : ""}`;
      if (j && (Array.isArray(j.fields) || Object.keys(j).some((k) => /^\d+$/.test(k)))) return "A Gravity Forms export";
      return "Unrecognised JSON";
    } catch {
      return text.trim() ? "Not valid JSON" : "";
    }
  })();

  async function run() {
    setBusy(true);
    try {
      const res = await builderApi.import(JSON.parse(text), { publish, withEntries });
      setResult(res);
      onDone();
    } catch (e) {
      toast(errorMessage(e, "Import failed."), "error");
    } finally {
      setBusy(false);
    }
  }

  function close() {
    setText("");
    setFileName("");
    setResult(null);
    onClose();
  }

  return (
    <Dialog open={open} onOpenChange={(o) => !o && close()}>
      <DialogContent aria-describedby={undefined} className="w-[min(680px,calc(100vw-2rem))]">
        <DialogHeader title="Import forms" subtitle="A Lantern form or bundle (.lcsform.json), or a Gravity Forms export (Forms → Import/Export → Export Forms)." />
        <DialogBody className="max-h-[70vh] overflow-y-auto">
          {result ? (
            <div className="space-y-3 text-[13.5px]">
              {result.created.length > 0 && (
                <div>
                  <p className="font-semibold text-ink">Imported {result.created.length} form{result.created.length === 1 ? "" : "s"}:</p>
                  <ul className="mt-1 list-disc pl-5">
                    {result.created.map((c) => <li key={c.id}><Link to={`/admin/builder/${c.id}`} onClick={close} className="font-semibold text-accent">{c.title}</Link>{c.entries ? ` (${c.entries} entries)` : ""}</li>)}
                  </ul>
                </div>
              )}
              {result.failed.map((f, i) => (
                <div key={i}><p className="font-semibold text-status-redText">Couldn't import “{f.title}”</p><ProblemList problems={f.problems} /></div>
              ))}
              {result.warnings.length > 0 && (
                <div className="rounded-input bg-status-amberBg p-3 text-status-amberText">
                  <p className="mb-1 font-semibold">Check these:</p>
                  <ul className="list-disc space-y-0.5 pl-5 text-[12.5px]">{result.warnings.map((w, i) => <li key={i}>{w}</li>)}</ul>
                </div>
              )}
            </div>
          ) : (
            <>
              <input ref={fileRef} type="file" accept=".json,application/json" className="hidden" onChange={async (e) => {
                const f = e.target.files?.[0];
                if (!f) return;
                setFileName(f.name);
                setText(await f.text());
                e.target.value = "";
              }} />
              <button onClick={() => fileRef.current?.click()} className="flex w-full flex-col items-center gap-1 rounded-card border border-dashed border-strongline bg-subtle/50 px-4 py-6 text-[13.5px] hover:bg-subtle">
                <FileUp className="h-6 w-6 text-muted" />
                <span className="font-semibold text-accent">{fileName || "Choose a .json file"}</span>
                <span className="text-micro text-muted">or paste the JSON below</span>
              </button>
              <textarea value={text} onChange={(e) => setText(e.target.value)} placeholder="{ … }" className="mt-3 h-40 w-full rounded-input border border-hairline bg-surface p-2 font-mono text-[12px] text-ink" />
              {kind && <p className={cn("mt-1 text-[12.5px] font-semibold", kind.startsWith("Not") || kind.startsWith("Unrec") ? "text-status-redText" : "text-status-greenText")}>{kind}</p>}
              <label className="mt-3 flex items-center gap-2 text-[13.5px] text-ink"><input type="checkbox" checked={publish} onChange={(e) => setPublish(e.target.checked)} /> Publish right away (otherwise they arrive as drafts)</label>
              <label className="mt-1 flex items-center gap-2 text-[13.5px] text-ink"><input type="checkbox" checked={withEntries} onChange={(e) => setWithEntries(e.target.checked)} /> Bring entries too (Lantern bundles exported with entries)</label>
            </>
          )}
        </DialogBody>
        <DialogFooter>
          {result ? <Button onClick={close}>Done</Button> : (
            <>
              <Button variant="secondary" onClick={close}>Cancel</Button>
              <Button onClick={run} disabled={busy || !kind || kind.startsWith("Not") || kind.startsWith("Unrec")}>Import</Button>
            </>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
