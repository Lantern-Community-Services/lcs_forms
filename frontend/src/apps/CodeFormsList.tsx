import { FormBackupBar } from "@/components/FormBackupBar";
import { DeleteFormDialog } from "@/components/DeleteFormDialog";
import { useRef, useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { useQueryClient } from "@tanstack/react-query";
import { Code2, FileUp, MoreHorizontal, Palette, Plus } from "lucide-react";
import { designKitHtml, download } from "./design";
import { Page, PageHeader } from "@/components/shell/AppShell";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Field } from "@/components/ui/label";
import { EmptyState, LoadingState } from "@/components/ui/misc";
import { Dialog, DialogBody, DialogContent, DialogFooter, DialogHeader } from "@/components/ui/dialog";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { useToast } from "@/components/ui/toast";
import { StatusBadge } from "@/screens/builder/BuilderList";
import { formIcon } from "@/lib/formIcons";
import { errorMessage, relativeTime } from "@/lib/utils";
import { projectsApi, useProjects, type ProjectSummary } from "./api";
import { CODE_TEMPLATES } from "./templates";

/** Admin → Code forms: forms built in code (Admins and Developers). */
export function CodeFormsList() {
  const [archived, setArchived] = useState(false);
  const { data, isLoading } = useProjects(archived);
  const [creating, setCreating] = useState(false);
  const [deleting, setDeleting] = useState<ProjectSummary | null>(null);
  const qc = useQueryClient();
  const toast = useToast();
  const navigate = useNavigate();
  const fileRef = useRef<HTMLInputElement>(null);
  const refresh = () => qc.invalidateQueries({ queryKey: ["apps"] });

  async function run(fn: () => Promise<unknown>, done: string) {
    try {
      await fn();
      await refresh();
      toast(done);
    } catch (e) {
      toast(errorMessage(e, "That didn't work."), "error");
    }
  }

  return (
    <Page className="max-w-[1000px]">
      <PageHeader
        title="Code forms"
        subtitle="Forms built as code: custom screens, server rules, offline recording, dashboards. Pages run sandboxed; the AI form builder can work on them too."
        actions={
          <>
            <input ref={fileRef} type="file" accept=".json" className="hidden" onChange={async (e) => {
              const f = e.target.files?.[0];
              e.target.value = "";
              if (!f) return;
              try {
                const payload = JSON.parse(await f.text());
                const withEntries = Array.isArray(payload.entries) && payload.entries.length > 0 && confirm(`Bring its ${payload.entries.length} entries too?`);
                const res = await projectsApi.import(payload, withEntries);
                await refresh();
                navigate(`/admin/apps/${res.id}`);
              } catch (err) {
                toast(errorMessage(err, "Couldn't import that file."), "error");
              }
            }} />
            <Button variant="secondary" title="The app's components and tokens as one HTML file, for Claude Design" onClick={async () => {
              try {
                download("lantern-design-kit.html", await designKitHtml());
              } catch (e) {
                toast(errorMessage(e, "Couldn't build the design kit."), "error");
              }
            }}><Palette className="h-4 w-4" /> Design kit</Button>
            <Button variant="secondary" onClick={() => fileRef.current?.click()}><FileUp className="h-4 w-4" /> Import</Button>
            <Button onClick={() => setCreating(true)}><Plus className="h-4 w-4" /> New code form</Button>
          </>
        }
      />
      <FormBackupBar />
      {isLoading ? <LoadingState /> : !data?.length ? (
        <Card>
          <EmptyState icon={<Code2 className="h-6 w-6" />} title={archived ? "No archived code forms" : "No code forms yet"} hint="Start from a template, or ask the AI form builder to write one." />
          <div className="flex justify-center pb-8"><Button onClick={() => setCreating(true)}><Plus className="h-4 w-4" /> New code form</Button></div>
        </Card>
      ) : (
        <Card>
          <ul>
            {data.map((p) => {
              const Icon = formIcon(p.icon ?? "clipboard");
              return (
                <li key={p.id} className="flex items-center gap-3 border-b border-hairline px-4 py-3 last:border-0 hover:bg-rowhover/50">
                  <span className="grid h-9 w-9 shrink-0 place-items-center rounded-panel bg-navsel text-accent dark:text-white"><Icon className="h-[18px] w-[18px]" /></span>
                  <Link to={`/admin/apps/${p.id}`} className="min-w-0 flex-1">
                    <p className="truncate text-[14px] font-semibold text-ink">{p.title}</p>
                    <p className="truncate text-micro text-muted">/apps/{p.slug} · {p.fileCount} files · edited {relativeTime(p.updatedAt)}{p.updatedByName ? ` by ${p.updatedByName}` : ""}</p>
                  </Link>
                  <div className="hidden sm:block"><StatusBadge status={p.status} unpublished={p.unpublishedChanges} /></div>
                  <span className="hidden w-24 text-right text-[13px] text-muted md:block"><span className="tabular font-semibold text-ink">{p.entryCount.toLocaleString()}</span> entries</span>
                  <RowMenu p={p} run={run} onDelete={() => setDeleting(p)} />
                </li>
              );
            })}
          </ul>
        </Card>
      )}
      <div className="mt-3 flex justify-end">
        <button onClick={() => setArchived(!archived)} className="text-[13px] font-semibold text-accent">{archived ? "Hide archived" : "Show archived"}</button>
      </div>
      <NewDialog open={creating} onClose={() => setCreating(false)} onCreated={(id) => { void refresh(); navigate(`/admin/apps/${id}`); }} />
      <DeleteFormDialog
        form={deleting}
        noun="code form"
        onCancel={() => setDeleting(null)}
        onConfirm={async () => {
          const p = deleting!;
          await run(() => projectsApi.remove(p.id, p.entryCount > 0), p.entryCount > 0 ? "Deleted, with its entries and data." : "Deleted.");
          setDeleting(null);
        }}
      />
    </Page>
  );
}

function RowMenu({ p, run, onDelete }: { p: ProjectSummary; run: (fn: () => Promise<unknown>, done: string) => void; onDelete: () => void }) {
  const navigate = useNavigate();
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild><Button variant="ghost" size="icon" aria-label={`Actions for ${p.title}`}><MoreHorizontal className="h-4 w-4" /></Button></DropdownMenuTrigger>
      <DropdownMenuContent align="end">
        <DropdownMenuItem onSelect={() => navigate(`/admin/apps/${p.id}`)}>Edit</DropdownMenuItem>
        {p.liveVersion > 0 && <DropdownMenuItem onSelect={() => navigate(`/apps/${p.slug}`)}>Open</DropdownMenuItem>}
        <DropdownMenuSeparator />
        <DropdownMenuItem onSelect={() => run(() => projectsApi.duplicate(p.id), "Duplicated.")}>Duplicate</DropdownMenuItem>
        <DropdownMenuItem onSelect={() => run(() => projectsApi.exportFile(p.id, false), "Exported.")}>Export code</DropdownMenuItem>
        <DropdownMenuItem onSelect={() => run(() => projectsApi.exportFile(p.id, true), "Exported with data.")}>Export with data</DropdownMenuItem>
        <DropdownMenuSeparator />
        {p.status === "published" && <DropdownMenuItem onSelect={() => run(() => projectsApi.setStatus(p.id, "closed"), "Closed to new entries.")}>Close to new entries</DropdownMenuItem>}
        {p.status === "closed" && <DropdownMenuItem onSelect={() => run(() => projectsApi.setStatus(p.id, "published"), "Reopened.")}>Reopen</DropdownMenuItem>}
        {p.status !== "archived" ? (
          <DropdownMenuItem onSelect={() => run(() => projectsApi.setStatus(p.id, "archived"), "Archived.")}>Archive</DropdownMenuItem>
        ) : (
          <DropdownMenuItem onSelect={() => run(() => projectsApi.setStatus(p.id, "draft"), "Unarchived.")}>Unarchive</DropdownMenuItem>
        )}
        <DropdownMenuItem onSelect={onDelete}>
          <span className="text-status-redText">Delete…</span>
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

function NewDialog({ open, onClose, onCreated }: { open: boolean; onClose: () => void; onCreated: (id: string) => void }) {
  const [title, setTitle] = useState("");
  const [template, setTemplate] = useState(CODE_TEMPLATES[0].key);
  const [busy, setBusy] = useState(false);
  const toast = useToast();
  async function create() {
    setBusy(true);
    try {
      const t = CODE_TEMPLATES.find((x) => x.key === template)!;
      const row = await projectsApi.create(t.files ? { files: t.files(title.trim() || t.name) } : { title: title.trim() || "Untitled code form" });
      onClose();
      onCreated(row.id);
    } catch (e) {
      toast(errorMessage(e, "Couldn't create it."), "error");
    } finally {
      setBusy(false);
    }
  }
  return (
    <Dialog open={open} onOpenChange={(o) => !o && onClose()}>
      <DialogContent aria-describedby={undefined}>
        <DialogHeader title="New code form" subtitle="It starts as a draft you can preview. Nobody else sees it until you publish." />
        <DialogBody className="space-y-4">
          <Field label="Title"><Input autoFocus value={title} onChange={(e) => setTitle(e.target.value)} placeholder="e.g. Pantry distribution" /></Field>
          <div className="grid gap-2">
            {CODE_TEMPLATES.map((t) => (
              <button key={t.key} onClick={() => setTemplate(t.key)} className={`rounded-card border p-3 text-left ${template === t.key ? "border-navy bg-navsel" : "border-hairline hover:border-strongline"}`}>
                <p className="text-[14px] font-semibold text-ink">{t.name}</p>
                <p className="mt-0.5 text-[12.5px] text-muted">{t.blurb}</p>
              </button>
            ))}
          </div>
        </DialogBody>
        <DialogFooter>
          <Button variant="secondary" onClick={onClose}>Cancel</Button>
          <Button onClick={create} disabled={busy}>Create draft</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
