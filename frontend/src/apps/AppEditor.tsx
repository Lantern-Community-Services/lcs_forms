import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Link, useParams } from "react-router-dom";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import {
  AlertTriangle, BookOpen, ChevronDown, Palette, ChevronLeft, ChevronRight, ExternalLink, FilePlus, FileText, Folder, History, Loader2, Monitor, Pencil,
  Play, Rocket, Save, Smartphone, Tablet, Terminal, Trash2, X,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Select } from "@/components/ui/select";
import { LoadingState, EmptyState } from "@/components/ui/misc";
import { Dialog, DialogBody, DialogContent, DialogFooter, DialogHeader } from "@/components/ui/dialog";
import { useToast } from "@/components/ui/toast";
import { CodeEditor } from "@/components/formkit/CodeEditor";
import { StatusBadge } from "@/screens/builder/BuilderList";
import { ApiError } from "@/lib/api";
import { useForms } from "@/lib/queries";
import { cn, errorMessage, formatDateTime } from "@/lib/utils";
import type { ConsoleLine } from "./AppFrame";
import { DevicePreview } from "@/components/preview/DevicePreview";
import { appKeys, projectsApi, useAppRuntime, useProject, type FileProblem, type Project } from "./api";
import { download, handoffHtml } from "./design";

type Panel = "problems" | "console" | "versions" | "reference" | "settings";

const langOf = (path: string) => (path.endsWith(".css") ? "css" : path.endsWith(".json") ? "json" : /\.(md|txt)$/.test(path) ? "html" : "typescript") as "css" | "json" | "html" | "typescript";

/** Admin → Code forms → one form: files, editor, live preview, console, versions, reference. */
export function AppEditorPage() {
  const { id = "" } = useParams();
  const { data, isLoading, error } = useProject(id);
  if (error) return <div className="p-6"><EmptyState title={errorMessage(error, "Couldn't open this code form.")} /></div>;
  if (isLoading || !data) return <LoadingState />;
  return <AppEditor key={data.id} initial={data} />;
}

function AppEditor({ initial }: { initial: Project }) {
  const qc = useQueryClient();
  const toast = useToast();
  const [project, setProject] = useState(initial);
  const [files, setFiles] = useState<Record<string, string>>(initial.files);
  const [saved, setSaved] = useState(JSON.stringify(initial.files));
  const [open, setOpen] = useState<string[]>(() => ["form.json", ...Object.keys(initial.files).filter((f) => f.startsWith("pages/")).slice(0, 1)]);
  const [active, setActive] = useState<string>(() => Object.keys(initial.files).find((f) => f.startsWith("pages/")) ?? "form.json");
  const [jump, setJump] = useState<{ line: number; column?: number; n: number } | undefined>();
  const [saving, setSaving] = useState(false);
  const [problems, setProblems] = useState<FileProblem[]>([]);
  const [panel, setPanel] = useState<Panel>("console");
  const [panelOpen, setPanelOpen] = useState(true);
  const [consoleLines, setConsole] = useState<ConsoleLine[]>([]);
  const [nonce, setNonce] = useState(0);
  const [previewPage, setPreviewPage] = useState<string>("");
  const [previewParams, setPreviewParams] = useState<Record<string, string>>({});
  const [width, setWidth] = useState<"phone" | "tablet" | "full">("full");
  const [showPreview, setShowPreview] = useState(true);
  const [publishing, setPublishing] = useState(false);
  const dirty = JSON.stringify(files) !== saved;

  const runtime = useAppRuntime(project.slug, true, nonce);
  const buildProblems = runtime.error instanceof ApiError && runtime.error.status === 422 ? ((runtime.error.details as { problems?: FileProblem[] })?.problems ?? []) : [];
  const allProblems = problems.length ? problems : buildProblems;

  useEffect(() => {
    if (buildProblems.length) setPanel("problems");
  }, [buildProblems.length]);

  const log = useCallback((line: ConsoleLine) => setConsole((c) => [...c.slice(-400), line]), []);
  // The device previews run the page in the app; its console comes back here.
  useEffect(() => {
    const onMessage = (e: MessageEvent) => {
      if (e.origin === window.location.origin && e.data?.lcsConsole) log(e.data.lcsConsole as ConsoleLine);
    };
    window.addEventListener("message", onMessage);
    return () => window.removeEventListener("message", onMessage);
  }, [log]);

  const save = useCallback(async () => {
    setSaving(true);
    try {
      const row = await projectsApi.save(project.id, files, project.revision);
      setProject(row);
      setSaved(JSON.stringify(row.files));
      qc.setQueryData(appKeys.project(row.id), row);
      void qc.invalidateQueries({ queryKey: ["apps", "projects"] });
      const build = await projectsApi.build(row.id);
      setProblems(build.ok ? [] : build.problems);
      if (!build.ok) {
        setPanel("problems");
        setPanelOpen(true);
      }
      setNonce((n) => n + 1);
      return row;
    } catch (e) {
      toast(errorMessage(e, "Couldn't save."), "error");
      return null;
    } finally {
      setSaving(false);
    }
  }, [files, project, qc, toast]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "s") {
        e.preventDefault();
        if (!saving) void save();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [save, saving]);

  useEffect(() => {
    if (!dirty) return;
    const warn = (e: BeforeUnloadEvent) => e.preventDefault();
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, [dirty]);

  const openFile = (path: string, line?: number, column?: number) => {
    if (files[path] === undefined) return;
    setOpen((o) => (o.includes(path) ? o : [...o, path]));
    setActive(path);
    if (line) setJump({ line, column, n: Date.now() });
  };

  const closeFile = (path: string) => {
    const next = open.filter((p) => p !== path);
    setOpen(next);
    if (active === path) setActive(next[next.length - 1] ?? "");
  };

  function newFile() {
    const path = prompt("New file path (e.g. pages/report.tsx, lib/rules.ts, server/limits.ts):", "pages/new-page.tsx")?.trim();
    if (!path) return;
    if (files[path] !== undefined) return toast("That file already exists.", "error");
    if (!/^[A-Za-z0-9_\-./]+\.(tsx?|jsx?|css|json|md|txt)$/.test(path) || path.includes("..")) return toast("Use a relative path ending in .tsx, .ts, .css, .json or .md.", "error");
    const stub = path.startsWith("pages/") && path.endsWith(".tsx")
      ? `import { Page, PageHeader } from "@lcs/ui";\n\nexport default function NewPage() {\n  return (\n    <Page>\n      <PageHeader title="New page" />\n    </Page>\n  );\n}\n`
      : "";
    setFiles({ ...files, [path]: stub });
    openFile(path);
    if (path.startsWith("pages/")) toast("Add it to \"pages\" in form.json to give it a tab.");
  }

  function renameFile(path: string) {
    const to = prompt("Rename to:", path)?.trim();
    if (!to || to === path) return;
    if (files[to] !== undefined) return toast("That name is taken.", "error");
    const next: Record<string, string> = {};
    for (const [k, v] of Object.entries(files)) next[k === path ? to : k] = v;
    setFiles(next);
    setOpen((o) => o.map((p) => (p === path ? to : p)));
    if (active === path) setActive(to);
  }

  function deleteFile(path: string) {
    if (path === "form.json") return toast("form.json is required.", "error");
    if (!confirm(`Delete ${path}?`)) return;
    const next = { ...files };
    delete next[path];
    setFiles(next);
    closeFile(path);
  }

  const pages = runtime.data?.pages ?? [];
  const page = previewPage && pages.some((p) => p.id === previewPage) ? previewPage : pages[0]?.id ?? "";
  const frameWidth = width === "phone" ? 390 : width === "tablet" ? 820 : undefined;

  return (
    <div className="flex h-full min-h-0 flex-col bg-appbg">
      {/* Top bar */}
      <div className="flex flex-none flex-wrap items-center gap-2 border-b border-hairline bg-surface px-3 py-2 pt-safe-top">
        <Link to="/admin/apps" className="inline-flex items-center gap-1 rounded-input px-1.5 py-1 text-[13px] font-semibold text-accent hover:bg-subtle dark:text-white"><ChevronLeft className="h-4 w-4" /> <span className="hidden sm:inline">Code forms</span></Link>
        <span className="font-heading text-[15px] font-extrabold text-ink">{project.title}</span>
        <StatusBadge status={project.status} unpublished={project.unpublishedChanges || (dirty && project.status !== "draft")} />
        <code className="hidden text-micro text-muted md:inline">/apps/{project.slug}</code>
        <div className="flex-1" />
        {allProblems.length > 0 && (
          <Button variant="outlineDanger" size="sm" onClick={() => { setPanel("problems"); setPanelOpen(true); }}><AlertTriangle className="h-3.5 w-3.5" /> {allProblems.length}</Button>
        )}
        {project.liveVersion > 0 && <a href={`/apps/${project.slug}`} target="_blank" rel="noreferrer"><Button variant="secondary" size="sm"><ExternalLink className="h-3.5 w-3.5" /> <span className="hidden md:inline">Open live</span></Button></a>}
        <Button
          variant="secondary"
          size="sm"
          disabled={!runtime.data}
          title="One HTML file: every page on phone, iPad and desktop with sample data, the design brief and the source — for Claude Design"
          onClick={async () => {
            if (!runtime.data) return;
            try {
              const { html, usedFixtures } = await handoffHtml({ title: project.title, slug: project.slug, runtime: runtime.data, files });
              download(`${project.slug}-design-handoff.html`, html);
              toast(usedFixtures ? "Exported with the sample data in design/fixtures.json." : "Exported with made-up sample data. Add design/fixtures.json to control what the screens show.");
            } catch (e) {
              toast(errorMessage(e, "Couldn't export."), "error");
            }
          }}
        >
          <Palette className="h-3.5 w-3.5" /> <span className="hidden xl:inline">Export for Claude Design</span>
        </Button>
        <Button variant="secondary" size="sm" onClick={() => setShowPreview((v) => !v)} className="hidden lg:inline-flex"><Play className="h-3.5 w-3.5" /> {showPreview ? "Hide preview" : "Preview"}</Button>
        <Button variant="secondary" size="sm" onClick={() => void save()} disabled={saving}>
          {saving ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Save className="h-3.5 w-3.5" />} {dirty ? "Save & run" : "Run"}
        </Button>
        <Button size="sm" onClick={() => setPublishing(true)}><Rocket className="h-3.5 w-3.5" /> Publish</Button>
      </div>

      <div className="grid min-h-0 flex-1 grid-cols-[200px_1fr] lg:grid-cols-[200px_minmax(0,1fr)_minmax(0,1fr)]" style={showPreview ? undefined : { gridTemplateColumns: "200px minmax(0,1fr)" }}>
        {/* Files */}
        <aside className="min-h-0 overflow-y-auto border-r border-hairline bg-surface py-2 scroll-thin">
          <div className="mb-1 flex items-center justify-between px-3">
            <span className="text-micro font-bold uppercase tracking-[0.04em] text-muted">Files</span>
            <button onClick={newFile} className="rounded p-1 text-muted hover:bg-subtle hover:text-ink" title="New file" aria-label="New file"><FilePlus className="h-4 w-4" /></button>
          </div>
          <FileTree files={files} active={active} onOpen={openFile} onRename={renameFile} onDelete={deleteFile} problems={allProblems} />
        </aside>

        {/* Editor */}
        <section className="flex min-h-0 flex-col border-r border-hairline">
          <div className="flex flex-none overflow-x-auto border-b border-hairline bg-surface">
            {open.filter((p) => files[p] !== undefined).map((p) => (
              <div key={p} className={cn("group flex shrink-0 items-center gap-1 border-r border-hairline px-3 py-1.5 text-[12.5px]", p === active ? "bg-appbg font-semibold text-ink" : "text-muted hover:text-ink")}>
                <button onClick={() => setActive(p)}>{p.split("/").pop()}</button>
                <button onClick={() => closeFile(p)} className="rounded opacity-50 hover:opacity-100" aria-label={`Close ${p}`}><X className="h-3 w-3" /></button>
              </div>
            ))}
          </div>
          <div className="min-h-0 flex-1 p-2">
            {active && files[active] !== undefined ? (
              <CodeEditor key={active} value={files[active]} onChange={(v) => setFiles((f) => ({ ...f, [active]: v }))} language={langOf(active)} jump={jump} fill className="h-full" minHeight={200} />
            ) : (
              <div className="grid h-full place-items-center text-[13px] text-muted">Open a file on the left.</div>
            )}
          </div>
          {/* Bottom panel */}
          <div className="flex-none border-t border-hairline bg-surface">
            <div className="flex items-center gap-1 px-2">
              {([["problems", `Problems${allProblems.length ? ` (${allProblems.length})` : ""}`, AlertTriangle], ["console", `Console${consoleLines.length ? ` (${consoleLines.length})` : ""}`, Terminal], ["versions", "Versions", History], ["settings", "Settings", Pencil], ["reference", "SDK reference", BookOpen]] as const).map(([k, label, Icon]) => (
                <button key={k} onClick={() => { setPanel(k); setPanelOpen(true); }} className={cn("inline-flex items-center gap-1 border-b-2 px-2 py-1.5 text-[12px] font-semibold", panel === k && panelOpen ? "border-navy text-ink" : "border-transparent text-muted hover:text-ink")}>
                  <Icon className="h-3.5 w-3.5" /> {label}
                </button>
              ))}
              <div className="flex-1" />
              {panel === "console" && panelOpen && <button onClick={() => setConsole([])} className="text-micro font-semibold text-muted hover:text-ink">Clear</button>}
              <button onClick={() => setPanelOpen((o) => !o)} className="rounded p-1 text-muted hover:text-ink" aria-label="Toggle panel"><ChevronDown className={cn("h-4 w-4 transition-transform", !panelOpen && "rotate-180")} /></button>
            </div>
            {panelOpen && (
              <div className="h-[210px] overflow-y-auto border-t border-hairline px-3 py-2 scroll-thin">
                {panel === "problems" && <Problems problems={allProblems} onOpen={openFile} />}
                {panel === "console" && <Console lines={consoleLines} />}
                {panel === "versions" && <Versions project={project} dirty={dirty} onRestored={(row) => { setProject(row); setFiles(row.files); setSaved(JSON.stringify(row.files)); setNonce((n) => n + 1); }} />}
                {panel === "settings" && <SettingsPanel project={project} onChange={setProject} />}
                {panel === "reference" && <Reference />}
              </div>
            )}
          </div>
        </section>

        {/* Preview */}
        {showPreview && (
          <section className="hidden min-h-0 flex-col lg:flex">
            {runtime.error ? (
              <div className="m-4 rounded-card border border-status-redDot/50 bg-status-redBg p-4 text-[13px] text-status-redText">
                <p className="font-bold">{buildProblems.length ? "The draft doesn't build yet." : errorMessage(runtime.error, "Couldn't load the preview.")}</p>
                {buildProblems.length > 0 && <p className="mt-1">See Problems below.</p>}
              </div>
            ) : runtime.isLoading || !page ? (
              <LoadingState label="Building…" />
            ) : (
              // The real page, in the app, in phone / iPad / desktop frames at true size.
              <DevicePreview
                src={`/apps/${project.slug}/${page}?draft=1`}
                reloadKey={nonce}
                initialMode="tablet"
                toolbarExtra={
                  <div className="w-36">
                    <Select value={page} onChange={(e) => setPreviewPage(e.target.value)} options={pages.map((p) => ({ value: p.id, label: p.label + (p.hidden ? " (hidden)" : "") }))} className="min-h-7 py-0.5 text-[12px]" />
                  </div>
                }
              />
            )}
            <p className="flex-none border-t border-hairline bg-surface px-3 py-1 text-micro text-muted">Preview runs your saved draft (Save & run to refresh) with real data; entries made here are marked “preview” and hidden from the live form.</p>
          </section>
        )}
      </div>

      <PublishDialog open={publishing} onClose={() => setPublishing(false)} project={project} dirty={dirty} save={save} onDone={(row) => { setProject(row); qc.setQueryData(appKeys.project(row.id), row); toast(`Published version ${row.liveVersion}.`); }} onProblems={(p) => { setProblems(p); setPanel("problems"); setPanelOpen(true); }} />
    </div>
  );
}

function FileTree({ files, active, onOpen, onRename, onDelete, problems }: { files: Record<string, string>; active: string; onOpen: (p: string) => void; onRename: (p: string) => void; onDelete: (p: string) => void; problems: FileProblem[] }) {
  const [closed, setClosed] = useState<Set<string>>(new Set());
  const bad = new Set(problems.map((p) => p.file));
  const sorted = useMemo(() => Object.keys(files).sort((a, b) => {
    const da = a.includes("/"), db = b.includes("/");
    if (a === "form.json") return -1;
    if (b === "form.json") return 1;
    if (da !== db) return da ? -1 : 1;
    return a.localeCompare(b);
  }), [files]);
  const folders = new Map<string, string[]>();
  const rootFiles: string[] = [];
  for (const f of sorted) {
    const i = f.lastIndexOf("/");
    if (i < 0) rootFiles.push(f);
    else folders.set(f.slice(0, i), [...(folders.get(f.slice(0, i)) ?? []), f]);
  }
  const Row = ({ path, depth }: { path: string; depth: number }) => (
    <div className={cn("group flex items-center gap-1 pr-1 text-[12.5px]", path === active ? "bg-navsel font-semibold text-ink" : "text-ink hover:bg-rowhover")} style={{ paddingLeft: 10 + depth * 12 }}>
      <button onClick={() => onOpen(path)} className="flex min-w-0 flex-1 items-center gap-1.5 py-1 text-left">
        <FileText className={cn("h-3.5 w-3.5 shrink-0", bad.has(path) ? "text-status-redText" : "text-muted")} />
        <span className={cn("truncate", bad.has(path) && "text-status-redText")}>{path.split("/").pop()}</span>
      </button>
      <button onClick={() => onRename(path)} className="hidden rounded p-0.5 text-muted hover:text-ink group-hover:block" aria-label={`Rename ${path}`}><Pencil className="h-3 w-3" /></button>
      <button onClick={() => onDelete(path)} className="hidden rounded p-0.5 text-muted hover:text-status-redText group-hover:block" aria-label={`Delete ${path}`}><Trash2 className="h-3 w-3" /></button>
    </div>
  );
  return (
    <div>
      {[...folders.entries()].map(([dir, list]) => (
        <div key={dir}>
          <button onClick={() => setClosed((c) => { const n = new Set(c); if (n.has(dir)) n.delete(dir); else n.add(dir); return n; })} className="flex w-full items-center gap-1 px-2 py-1 text-left text-[12.5px] font-semibold text-muted hover:text-ink">
            <ChevronRight className={cn("h-3 w-3 transition-transform", !closed.has(dir) && "rotate-90")} /> <Folder className="h-3.5 w-3.5" /> {dir}
          </button>
          {!closed.has(dir) && list.map((f) => <Row key={f} path={f} depth={1} />)}
        </div>
      ))}
      {rootFiles.map((f) => <Row key={f} path={f} depth={0} />)}
    </div>
  );
}

function Problems({ problems, onOpen }: { problems: FileProblem[]; onOpen: (path: string, line?: number, column?: number) => void }) {
  if (!problems.length) return <p className="text-[12.5px] text-status-greenText">No problems — the draft builds.</p>;
  return (
    <ul className="space-y-1 font-mono text-[12px]">
      {problems.map((p, i) => (
        <li key={i}>
          <button onClick={() => onOpen(p.file, p.line, p.column)} className="text-left hover:underline">
            <span className="font-semibold text-status-redText">{p.file || "(project)"}{p.line ? `:${p.line}${p.column !== undefined ? `:${p.column + 1}` : ""}` : ""}</span> <span className="text-ink">{p.message}</span>
          </button>
        </li>
      ))}
    </ul>
  );
}

function Console({ lines }: { lines: ConsoleLine[] }) {
  const end = useRef<HTMLDivElement>(null);
  useEffect(() => {
    end.current?.scrollIntoView({ block: "end" });
  }, [lines.length]);
  if (!lines.length) return <p className="text-[12.5px] text-muted">console.log from pages (in the preview) and server code (ctx.log) shows up here.</p>;
  return (
    <div className="font-mono text-[11.5px]">
      {lines.map((l, i) => (
        <div key={i} className={cn("whitespace-pre-wrap border-b border-hairline/60 py-0.5", l.level === "error" ? "text-status-redText" : l.level === "warn" ? "text-status-amberText" : "text-ink")}>
          <span className="mr-2 rounded bg-subtle px-1 text-[10px] uppercase text-muted">{l.source}</span>{l.text}
        </div>
      ))}
      <div ref={end} />
    </div>
  );
}

function Versions({ project, dirty, onRestored }: { project: Project; dirty: boolean; onRestored: (row: Project) => void }) {
  const toast = useToast();
  const { data } = useQuery({ queryKey: ["apps", "versions", project.id, project.liveVersion], queryFn: () => projectsApi.versions(project.id) });
  if (!data?.length) return <p className="text-[12.5px] text-muted">Not published yet. Each publish is kept here and can be restored.</p>;
  return (
    <ul className="space-y-1 text-[12.5px]">
      {data.map((v) => (
        <li key={v.version} className="flex items-center gap-2">
          <span className="font-semibold text-ink">v{v.version}</span>
          <span className="min-w-0 flex-1 truncate text-muted">{v.note || "—"} · {v.publishedByName} · {formatDateTime(v.createdAt)}{v.version === project.liveVersion ? " · live" : ""}</span>
          <button className="font-semibold text-accent" onClick={async () => {
            if (dirty && !confirm("Unsaved changes will be replaced. Restore anyway?")) return;
            try {
              onRestored(await projectsApi.restore(project.id, v.version));
              toast(`Version ${v.version} is now the draft.`);
            } catch (e) {
              toast(errorMessage(e, "Couldn't restore."), "error");
            }
          }}>Restore</button>
        </li>
      ))}
    </ul>
  );
}

function SettingsPanel({ project, onChange }: { project: Project; onChange: (p: Project) => void }) {
  const { data: catalog } = useForms(true);
  const toast = useToast();
  const current = catalog?.categories.find((c) => c.forms.some((f) => f.id === project.catalogLinkId))?.id ?? "";
  return (
    <div className="grid max-w-xl gap-3 text-[12.5px]">
      <label className="grid gap-1">
        <span className="font-semibold text-muted">Forms screen category (the card and sidebar entry)</span>
        <Select value={current} onChange={async (e) => {
          try {
            onChange(await projectsApi.setCatalog(project.id, e.target.value || null));
            toast(e.target.value ? "Listed on the Forms screen." : "Taken off the Forms screen.");
          } catch (err) {
            toast(errorMessage(err, "Couldn't change it."), "error");
          }
        }} options={[{ value: "", label: "Not listed" }, ...(catalog?.categories ?? []).map((c) => ({ value: c.id, label: c.name }))]} />
      </label>
      <p className="text-muted">Title, icon, tabs and who can see what are in <code>form.json</code>. The URL is <code>/apps/{project.slug}</code>.</p>
      <div className="flex gap-2">
        <Button size="sm" variant="secondary" onClick={() => projectsApi.exportFile(project.id, false)}>Export code</Button>
        <Button size="sm" variant="secondary" onClick={() => projectsApi.exportFile(project.id, true)}>Export with data</Button>
      </div>
    </div>
  );
}

function Reference() {
  const { data } = useQuery({ queryKey: ["apps", "guide"], queryFn: () => projectsApi.guide(), staleTime: 10 * 60_000 });
  return <pre className="whitespace-pre-wrap font-mono text-[11.5px] leading-relaxed text-ink">{data ?? "Loading…"}</pre>;
}

function PublishDialog({ open, onClose, project, dirty, save, onDone, onProblems }: {
  open: boolean; onClose: () => void; project: Project; dirty: boolean; save: () => Promise<Project | null>; onDone: (p: Project) => void; onProblems: (p: FileProblem[]) => void;
}) {
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  const toast = useToast();
  async function go() {
    setBusy(true);
    try {
      if (dirty && !(await save())) return;
      onDone(await projectsApi.publish(project.id, note.trim() || undefined));
      setNote("");
      onClose();
    } catch (e) {
      if (e instanceof ApiError && (e.details as { problems?: FileProblem[] })?.problems) {
        onProblems((e.details as { problems: FileProblem[] }).problems);
        onClose();
      }
      toast(errorMessage(e, "Couldn't publish."), "error");
    } finally {
      setBusy(false);
    }
  }
  return (
    <Dialog open={open} onOpenChange={(o) => !o && onClose()}>
      <DialogContent aria-describedby={undefined}>
        <DialogHeader title={project.liveVersion ? `Publish version ${project.liveVersion + 1}` : "Publish this code form"} subtitle="Everyone who can open it gets this version from their next visit." />
        <DialogBody>
          <label className="mb-1 block text-[12px] font-semibold text-muted">What changed? (for the version history)</label>
          <Input autoFocus value={note} onChange={(e) => setNote(e.target.value)} onKeyDown={(e) => e.key === "Enter" && void go()} />
        </DialogBody>
        <DialogFooter>
          <Button variant="secondary" onClick={onClose}>Cancel</Button>
          <Button onClick={go} disabled={busy}>{busy && <Loader2 className="h-4 w-4 animate-spin" />} Publish</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
