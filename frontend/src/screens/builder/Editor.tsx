import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Link, useParams } from "react-router-dom";
import { useQueryClient } from "@tanstack/react-query";
import {
  AlertTriangle, ArrowDown, ArrowUp, ChevronLeft, Copy, Download, ExternalLink, Eye, GripVertical, History, Loader2, Monitor,
  Plus, Redo2, RotateCcw, Rocket, Save, Settings2, Smartphone, Tablet, Trash2, Undo2, Wrench, Braces, EyeOff, GitBranch, Lock,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { LoadingState, EmptyState } from "@/components/ui/misc";
import { Dialog, DialogBody, DialogContent, DialogFooter, DialogHeader } from "@/components/ui/dialog";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuLabel, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { useToast } from "@/components/ui/toast";
import { CodeEditor } from "@/components/formkit/CodeEditor";
import { FieldView, FormRenderer } from "@/components/formkit/FormRenderer";
import { DevicePreview } from "@/components/preview/DevicePreview";
import { FieldProperties } from "./FieldProperties";
import { SettingsPanel } from "./SettingsPanel";
import { StatusBadge, ProblemList } from "./BuilderList";
import { moveItem, referencesTo, renameFieldId } from "./docOps";
import {
  builderApi, builderKeys, docProblems, formPath, useBuilderReference, useBuiltForm, useFormVersions,
  type BuiltFormDetail, type DocProblem,
} from "@/lib/builder";
import { ApiError } from "@/lib/api";
import {
  FIELD_TYPES, cleanValues, lintForm, makeFieldId, newField, typeInfo, validateValues,
  type Field, type FieldType, type FormDoc, type Values,
} from "@/lib/formEngine";
import { cn, errorMessage, formatDateTime } from "@/lib/utils";

type Tab = "build" | "code" | "settings" | "preview" | "history";

const DRAG_TYPE = "application/x-lcs-type";
const DRAG_FIELD = "application/x-lcs-field";

/** Admin → Form builder → one form: build, code, settings, preview, history. */
export function FormEditorPage() {
  const { id = "" } = useParams();
  const { data, isLoading, error } = useBuiltForm(id);
  if (error) return <div className="p-6"><EmptyState title={errorMessage(error, "Couldn't open this form.")} /></div>;
  if (isLoading || !data) return <LoadingState />;
  return <Editor key={data.id} initial={data} />;
}

function Editor({ initial }: { initial: BuiltFormDetail }) {
  const qc = useQueryClient();
  const toast = useToast();
  const { data: reference } = useBuilderReference();
  const [form, setForm] = useState(initial);
  const [doc, setDoc] = useState<FormDoc>(initial.draft);
  const [slug, setSlug] = useState(initial.slug);
  const [saved, setSaved] = useState(() => ({ json: JSON.stringify(initial.draft), slug: initial.slug }));
  const [tab, setTab] = useState<Tab>("build");
  const [selected, setSelected] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [serverProblems, setServerProblems] = useState<DocProblem[]>([]);
  const [publishing, setPublishing] = useState(false);
  const history = useRef<{ past: FormDoc[]; future: FormDoc[]; last: number }>({ past: [], future: [], last: 0 });
  const [, bump] = useState(0);

  const dirty = JSON.stringify(doc) !== saved.json || slug !== saved.slug;
  const problems = useMemo(() => lintForm(doc), [doc]);

  /** Change the document, with undo. Rapid edits (typing) collapse into one step. */
  const commit = useCallback((next: FormDoc | ((d: FormDoc) => FormDoc)) => {
    setDoc((cur) => {
      const n = typeof next === "function" ? next(cur) : next;
      const h = history.current;
      const now = Date.now();
      if (now - h.last > 700) {
        h.past.push(cur);
        if (h.past.length > 150) h.past.shift();
      }
      h.last = now;
      h.future = [];
      return n;
    });
    bump((x) => x + 1);
  }, []);

  const undo = useCallback(() => {
    const h = history.current;
    const prev = h.past.pop();
    if (!prev) return;
    setDoc((cur) => {
      h.future.push(cur);
      return prev;
    });
    h.last = 0;
    bump((x) => x + 1);
  }, []);

  const redo = useCallback(() => {
    const h = history.current;
    const next = h.future.pop();
    if (!next) return;
    setDoc((cur) => {
      h.past.push(cur);
      return next;
    });
    h.last = 0;
    bump((x) => x + 1);
  }, []);

  const adopt = (row: BuiltFormDetail) => {
    setForm(row);
    setSaved({ json: JSON.stringify(row.draft), slug: row.slug });
    qc.setQueryData(builderKeys.form(row.id), row);
    void qc.invalidateQueries({ queryKey: ["builder", "list"] });
  };

  const save = useCallback(async (): Promise<BuiltFormDetail | null> => {
    setSaving(true);
    setServerProblems([]);
    try {
      const row = await builderApi.save(form.id, { doc, revision: form.revision, slug: slug !== form.slug ? slug : undefined });
      adopt(row);
      return row;
    } catch (e) {
      const p = docProblems(e);
      if (p.length) {
        setServerProblems(p);
        toast(`Not saved — ${p.length} problem${p.length === 1 ? "" : "s"} to fix.`, "error");
      } else if (e instanceof ApiError && e.status === 409) {
        toast(e.message, "error");
      } else toast(errorMessage(e, "Couldn't save."), "error");
      return null;
    } finally {
      setSaving(false);
    }
  }, [doc, form, slug]); // eslint-disable-line react-hooks/exhaustive-deps

  // Keyboard: Ctrl+S saves; Ctrl+Z / Ctrl+Shift+Z undo and redo outside text boxes.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const mod = e.ctrlKey || e.metaKey;
      if (!mod) return;
      if (e.key.toLowerCase() === "s") {
        e.preventDefault();
        if (dirty && !saving) void save().then((r) => r && toast("Saved."));
        return;
      }
      const t = e.target as HTMLElement;
      if (t.closest("input, textarea, select, [contenteditable], .cm-editor")) return;
      if (e.key.toLowerCase() === "z") {
        e.preventDefault();
        if (e.shiftKey) redo();
        else undo();
      } else if (e.key.toLowerCase() === "y") {
        e.preventDefault();
        redo();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [dirty, saving, save, undo, redo, toast]);

  useEffect(() => {
    if (!dirty) return;
    const warn = (e: BeforeUnloadEvent) => e.preventDefault();
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, [dirty]);

  async function setCatalog(categoryId: string | null) {
    try {
      adopt(await builderApi.setCatalog(form.id, categoryId));
      await qc.invalidateQueries({ queryKey: ["forms"] });
      toast(categoryId ? "Listed on the Forms screen." : "Taken off the Forms screen.");
    } catch (e) {
      toast(errorMessage(e, "Couldn't change the listing."), "error");
    }
  }

  const access = doc.settings.access?.mode;
  const h = history.current;

  return (
    <div className="flex h-full min-h-0 flex-col bg-appbg">
      {/* Top bar */}
      <div className="flex flex-none flex-wrap items-center gap-2 border-b border-hairline bg-surface px-3 py-2 pt-safe-top md:px-4">
        <Link to="/admin/builder" className="inline-flex items-center gap-1 rounded-input px-1.5 py-1 text-[13px] font-semibold text-accent hover:bg-subtle dark:text-white" aria-label="All forms">
          <ChevronLeft className="h-4 w-4" /> <span className="hidden sm:inline">Forms</span>
        </Link>
        <input
          value={doc.title}
          onChange={(e) => commit({ ...doc, title: e.target.value })}
          aria-label="Form title"
          className="min-w-[120px] max-w-[360px] flex-1 rounded-input border border-transparent bg-transparent px-2 py-1 font-heading text-[16px] font-extrabold text-ink hover:border-hairline focus:border-navy focus:outline-none"
        />
        <StatusBadge status={form.status} unpublished={form.unpublishedChanges || (dirty && form.status !== "draft")} />
        <div className="flex-1" />
        <Button variant="ghost" size="icon" onClick={undo} disabled={!h.past.length} aria-label="Undo" title="Undo (Ctrl+Z)"><Undo2 className="h-4 w-4" /></Button>
        <Button variant="ghost" size="icon" onClick={redo} disabled={!h.future.length} aria-label="Redo" title="Redo (Ctrl+Shift+Z)"><Redo2 className="h-4 w-4" /></Button>
        {problems.length > 0 && (
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button variant="outlineDanger" size="sm"><AlertTriangle className="h-3.5 w-3.5" /> {problems.length}</Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="max-w-sm">
              <DropdownMenuLabel>Fix before publishing</DropdownMenuLabel>
              {problems.map((p, i) => (
                <DropdownMenuItem key={i} onSelect={() => { const m = /^fields\[(\d+)\]/.exec(p.path); if (m) { setSelected(doc.fields[Number(m[1])]?.id ?? null); setTab("build"); } }}>
                  <span className="text-[12.5px]"><code className="text-muted">{p.path}</code> {p.message}</span>
                </DropdownMenuItem>
              ))}
            </DropdownMenuContent>
          </DropdownMenu>
        )}
        <a href={formPath(form.slug, access)} target="_blank" rel="noreferrer"><Button variant="secondary" size="sm"><ExternalLink className="h-3.5 w-3.5" /> <span className="hidden md:inline">Open</span></Button></a>
        <Button variant="secondary" size="sm" onClick={() => void save().then((r) => r && toast("Saved."))} disabled={!dirty || saving}>
          {saving ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Save className="h-3.5 w-3.5" />} {dirty ? "Save" : "Saved"}
        </Button>
        <Button size="sm" onClick={() => setPublishing(true)} disabled={problems.length > 0}>
          <Rocket className="h-3.5 w-3.5" /> Publish
        </Button>
      </div>

      {/* Tabs */}
      <div className="flex flex-none gap-1 overflow-x-auto border-b border-hairline bg-surface px-3 md:px-4">
        {([["build", "Build", Wrench], ["code", "Code", Braces], ["settings", "Settings", Settings2], ["preview", "Preview", Eye], ["history", "Versions", History]] as const).map(([k, label, Icon]) => (
          <button key={k} onClick={() => setTab(k)} className={cn("-mb-px inline-flex items-center gap-1.5 whitespace-nowrap border-b-2 px-3 py-2.5 text-[13px] font-semibold", tab === k ? "border-navy text-accent dark:border-white dark:text-white" : "border-transparent text-muted hover:text-ink")}>
            <Icon className="h-3.5 w-3.5" /> {label}
          </button>
        ))}
        <div className="flex-1" />
        <span className="hidden items-center font-mono text-micro text-muted md:flex">{formPath(slug, access)}</span>
      </div>

      {serverProblems.length > 0 && (
        <div className="flex-none px-4 pt-2">
          <ProblemList problems={serverProblems} />
        </div>
      )}

      <div className="min-h-0 flex-1">
        {tab === "build" && <BuildTab doc={doc} commit={commit} selected={selected} setSelected={setSelected} />}
        {tab === "code" && <CodeTab doc={doc} commit={commit} />}
        {tab === "settings" && (
          <div className="h-full overflow-y-auto scroll-thin">
            <SettingsPanel doc={doc} onChange={commit} slug={slug} onSlug={setSlug} reference={reference} form={form} onCatalog={setCatalog} />
          </div>
        )}
        {tab === "preview" && <PreviewTab doc={doc} slug={form.slug} />}
        {tab === "history" && <VersionsTab form={form} dirty={dirty} onRestored={(row) => { adopt(row); setDoc(row.draft); }} />}
      </div>

      <PublishDialog
        open={publishing}
        onClose={() => setPublishing(false)}
        form={form}
        dirty={dirty}
        save={save}
        onDone={(row) => { adopt(row); toast(`Published version ${row.liveVersion}.`); }}
      />
    </div>
  );
}

// ─────────────────────────── Build ───────────────────────────

function BuildTab({ doc, commit, selected, setSelected }: { doc: FormDoc; commit: (d: FormDoc | ((d: FormDoc) => FormDoc)) => void; selected: string | null; setSelected: (id: string | null) => void }) {
  const toast = useToast();
  const [drop, setDrop] = useState<number | null>(null);
  const field = doc.fields.find((f) => f.id === selected) ?? null;

  const insertAt = (type: FieldType, index?: number) => {
    const f = newField(type, doc.fields.map((x) => x.id));
    const at = index ?? (field ? doc.fields.indexOf(field) + 1 : doc.fields.length);
    commit((d) => ({ ...d, fields: [...d.fields.slice(0, at), f, ...d.fields.slice(at)] }));
    setSelected(f.id);
  };

  const updateField = (id: string, next: Field) => commit((d) => ({ ...d, fields: d.fields.map((f) => (f.id === id ? next : f)) }));

  const remove = (f: Field) => {
    const refs = referencesTo(doc, f.id);
    if (refs.length && !confirm(`“${f.label || f.id}” is used by ${refs.join(", ")}. Delete it anyway? Those rules will stop working.`)) return;
    commit((d) => ({ ...d, fields: d.fields.filter((x) => x.id !== f.id) }));
    if (selected === f.id) setSelected(null);
  };

  const duplicate = (f: Field) => {
    const copy = { ...JSON.parse(JSON.stringify(f)), id: makeFieldId(`${f.id}_copy`, doc.fields.map((x) => x.id)), label: f.label ? `${f.label} (copy)` : f.label } as Field;
    const at = doc.fields.indexOf(f) + 1;
    commit((d) => ({ ...d, fields: [...d.fields.slice(0, at), copy, ...d.fields.slice(at)] }));
    setSelected(copy.id);
  };

  const onDrop = (e: React.DragEvent, index: number) => {
    e.preventDefault();
    setDrop(null);
    const type = e.dataTransfer.getData(DRAG_TYPE) as FieldType;
    const moving = e.dataTransfer.getData(DRAG_FIELD);
    if (type) insertAt(type, index);
    else if (moving) {
      const from = doc.fields.findIndex((f) => f.id === moving);
      if (from >= 0 && from !== index && from + 1 !== index) commit((d) => ({ ...d, fields: moveItem(d.fields, from, index) }));
    }
  };

  const groups = useMemo(() => {
    const g = new Map<string, typeof FIELD_TYPES>();
    for (const t of FIELD_TYPES) g.set(t.group, [...(g.get(t.group) ?? []), t]);
    return [...g.entries()];
  }, []);

  return (
    <div className="grid h-full min-h-0 grid-cols-1 md:grid-cols-[200px_1fr] xl:grid-cols-[210px_1fr_360px]">
      {/* Palette */}
      <aside className="hidden min-h-0 overflow-y-auto border-r border-hairline bg-surface p-3 scroll-thin md:block">
        {groups.map(([group, types]) => (
          <div key={group} className="mb-4">
            <p className="mb-1.5 px-1 text-micro font-bold uppercase tracking-[0.04em] text-muted">{group}</p>
            <div className="grid grid-cols-1 gap-1">
              {types.map((t) => (
                <button
                  key={t.type}
                  draggable
                  onDragStart={(e) => { e.dataTransfer.setData(DRAG_TYPE, t.type); e.dataTransfer.effectAllowed = "copy"; }}
                  onClick={() => insertAt(t.type)}
                  title={t.description}
                  className="flex items-center gap-2 rounded-input border border-hairline bg-surface px-2.5 py-1.5 text-left text-[12.5px] font-semibold text-ink hover:border-navy hover:bg-navsel/50 active:cursor-grabbing"
                >
                  <Plus className="h-3 w-3 text-muted" /> {t.label}
                </button>
              ))}
            </div>
          </div>
        ))}
        <p className="px-1 text-micro text-muted">Click to add below the selected field, or drag onto the form.</p>
      </aside>

      {/* Canvas */}
      <div className="min-h-0 overflow-y-auto scroll-thin" onClick={() => setSelected(null)}>
        <div className="mx-auto max-w-[760px] p-3 md:p-6">
          <div className="mb-3 md:hidden">
            <DropdownMenu>
              <DropdownMenuTrigger asChild><Button className="w-full"><Plus className="h-4 w-4" /> Add field</Button></DropdownMenuTrigger>
              <DropdownMenuContent className="max-h-80 overflow-y-auto">
                {FIELD_TYPES.map((t) => <DropdownMenuItem key={t.type} onSelect={() => insertAt(t.type)}>{t.group} · {t.label}</DropdownMenuItem>)}
              </DropdownMenuContent>
            </DropdownMenu>
          </div>
          <div className="rounded-card border border-hairline bg-surface p-4 shadow-sm md:p-6">
            <h2 className="font-heading text-[21px] font-extrabold text-ink">{doc.title || "Untitled form"}</h2>
            {doc.description && <div className="prose-form mt-1 text-[13.5px] text-muted" dangerouslySetInnerHTML={{ __html: doc.description }} />}
            <div
              className="mt-5"
              onDragOver={(e) => { if (!doc.fields.length) { e.preventDefault(); setDrop(0); } }}
              onDrop={(e) => !doc.fields.length && onDrop(e, 0)}
            >
              {!doc.fields.length && (
                <div className={cn("rounded-card border-2 border-dashed p-10 text-center text-[13.5px] text-muted", drop === 0 ? "border-navy bg-navsel/40" : "border-hairline")}>
                  Drag a field here, or click one on the left.
                </div>
              )}
              {doc.fields.map((f, i) => (
                <div key={f.id}>
                  <DropLine active={drop === i} />
                  <FieldCard
                    field={f}
                    doc={doc}
                    index={i}
                    count={doc.fields.length}
                    selected={selected === f.id}
                    onSelect={() => setSelected(f.id)}
                    onDragOver={(e) => {
                      e.preventDefault();
                      const r = e.currentTarget.getBoundingClientRect();
                      setDrop(e.clientY < r.top + r.height / 2 ? i : i + 1);
                    }}
                    onDrop={(e) => onDrop(e, drop ?? i)}
                    onDragEnd={() => setDrop(null)}
                    onMove={(d) => commit((x) => ({ ...x, fields: moveItem(x.fields, i, d < 0 ? i - 1 : i + 2) }))}
                    onDuplicate={() => duplicate(f)}
                    onRemove={() => remove(f)}
                  />
                </div>
              ))}
              <DropLine active={drop === doc.fields.length && doc.fields.length > 0} />
            </div>
            {doc.fields.length > 0 && (
              <div className="mt-6 border-t border-hairline pt-4">
                <Button disabled>{doc.settings.submitLabel || "Submit"}</Button>
              </div>
            )}
          </div>
        </div>
      </div>

      {/* Properties */}
      <aside className={cn("min-h-0 border-l border-hairline bg-surface", field ? "fixed inset-x-0 bottom-0 z-40 h-[70vh] rounded-t-card shadow-modal xl:static xl:h-auto xl:rounded-none xl:shadow-none" : "hidden xl:block")}>
        {field ? (
          <div className="flex h-full flex-col">
            <button onClick={() => setSelected(null)} className="flex-none border-b border-hairline py-1.5 text-center text-micro font-semibold text-muted xl:hidden">Done</button>
            <div className="min-h-0 flex-1">
              <FieldProperties
                key={field.id}
                field={field}
                siblings={doc.fields}
                onChange={(nf) => updateField(field.id, nf)}
                onRename={(newId) => {
                  if (doc.fields.some((f) => f.id === newId)) return toast("Another field already uses that id.", "error");
                  commit((d) => renameFieldId(d, field.id, newId));
                  setSelected(newId);
                  toast(`Renamed to ${newId} everywhere it was used.`);
                }}
              />
            </div>
          </div>
        ) : (
          <div className="p-5 text-[13px] text-muted">
            <p className="font-heading text-[15px] font-extrabold text-ink">Nothing selected</p>
            <p className="mt-1">Click a field to edit its label, choices, rules and more. Form-wide options — who can fill it in, limits, notifications, the confirmation — are under Settings.</p>
            <p className="mt-3">Shortcuts: Ctrl+S save · Ctrl+Z undo · Ctrl+Shift+Z redo.</p>
          </div>
        )}
      </aside>
    </div>
  );
}

function DropLine({ active }: { active: boolean }) {
  return <div className={cn("mx-2 h-1 rounded-pill transition-colors", active ? "bg-navy" : "bg-transparent")} />;
}

function FieldCard({
  field: f, doc, index, count, selected, onSelect, onDragOver, onDrop, onDragEnd, onMove, onDuplicate, onRemove,
}: {
  field: Field;
  doc: FormDoc;
  index: number;
  count: number;
  selected: boolean;
  onSelect: () => void;
  onDragOver: (e: React.DragEvent<HTMLDivElement>) => void;
  onDrop: (e: React.DragEvent) => void;
  onDragEnd: () => void;
  onMove: (d: -1 | 1) => void;
  onDuplicate: () => void;
  onRemove: () => void;
}) {
  const noop = () => undefined;
  return (
    <div
      draggable
      onDragStart={(e) => { e.dataTransfer.setData(DRAG_FIELD, f.id); e.dataTransfer.effectAllowed = "move"; }}
      onDragOver={onDragOver}
      onDrop={onDrop}
      onDragEnd={onDragEnd}
      onClick={(e) => { e.stopPropagation(); onSelect(); }}
      className={cn(
        "group relative my-1 cursor-pointer rounded-card border p-3 transition-colors",
        selected ? "border-navy bg-navsel/30 ring-2 ring-navy/20" : "border-transparent hover:border-hairline hover:bg-subtle/40",
        f.type === "page" && "border-dashed border-strongline bg-subtle/60"
      )}
    >
      <div className="absolute -left-1 top-3 hidden cursor-grab text-strongline group-hover:block md:-left-5"><GripVertical className="h-4 w-4" /></div>
      <div className="mb-1 flex flex-wrap items-center gap-1.5">
        <span className="rounded bg-subtle2 px-1.5 py-0.5 text-[10.5px] font-bold uppercase tracking-[0.03em] text-muted">{typeInfo(f.type)?.label ?? f.type}</span>
        <code className="text-[11px] text-muted">{f.id}</code>
        {f.conditional && <span className="inline-flex items-center gap-0.5 rounded bg-status-violetBg px-1.5 py-0.5 text-[10.5px] font-semibold text-status-violetText"><GitBranch className="h-3 w-3" /> {f.conditional.action} if…</span>}
        {f.adminOnly && <span className="inline-flex items-center gap-0.5 rounded bg-status-amberBg px-1.5 py-0.5 text-[10.5px] font-semibold text-status-amberText"><EyeOff className="h-3 w-3" /> admin only</span>}
        {f.readOnly && <span className="inline-flex items-center gap-0.5 rounded bg-subtle2 px-1.5 py-0.5 text-[10.5px] font-semibold text-muted"><Lock className="h-3 w-3" /> read-only</span>}
        {f.width && f.width !== "full" && <span className="rounded bg-subtle2 px-1.5 py-0.5 text-[10.5px] font-semibold text-muted">{f.width}</span>}
        <div className={cn("ml-auto flex gap-0.5", selected ? "flex" : "hidden group-hover:flex")}>
          <IconBtn label="Move up" disabled={index === 0} onClick={() => onMove(-1)}><ArrowUp className="h-3.5 w-3.5" /></IconBtn>
          <IconBtn label="Move down" disabled={index === count - 1} onClick={() => onMove(1)}><ArrowDown className="h-3.5 w-3.5" /></IconBtn>
          <IconBtn label="Duplicate" onClick={onDuplicate}><Copy className="h-3.5 w-3.5" /></IconBtn>
          <IconBtn label="Delete" onClick={onRemove}><Trash2 className="h-3.5 w-3.5 text-status-redText" /></IconBtn>
        </div>
      </div>
      {f.type === "page" ? (
        <p className="py-1 text-center text-[13px] font-semibold text-ink">— Page break · {f.label || "Next page"} —</p>
      ) : f.type === "hidden" ? (
        <p className="text-[13px] text-muted">Hidden field “{f.label}”{typeof f.defaultValue === "string" && f.defaultValue ? ` = ${f.defaultValue}` : ""}</p>
      ) : (
        // A live picture of the field, inert: clicks select the card instead.
        <div className={cn("pointer-events-none select-none", f.width === "half" && "md:max-w-[50%]", f.width === "third" && "md:max-w-[33%]")} aria-hidden>
          <FieldView field={f} value={f.defaultValue} values={{}} errors={{}} onChange={noop} disabled user={null} formSite={null} doc={doc} />
        </div>
      )}
    </div>
  );
}

function IconBtn({ label, onClick, disabled, children }: { label: string; onClick: () => void; disabled?: boolean; children: React.ReactNode }) {
  return (
    <button type="button" aria-label={label} title={label} disabled={disabled} onClick={(e) => { e.stopPropagation(); onClick(); }} className="rounded p-1 text-muted hover:bg-surface hover:text-ink disabled:opacity-30">
      {children}
    </button>
  );
}

// ─────────────────────────── Code ───────────────────────────

function CodeTab({ doc, commit }: { doc: FormDoc; commit: (d: FormDoc) => void }) {
  const [text, setText] = useState(() => JSON.stringify(doc, null, 2));
  const [problems, setProblems] = useState<DocProblem[]>([]);
  const [state, setState] = useState<"synced" | "checking" | "invalid">("synced");
  const toast = useToast();
  const applied = useRef(JSON.stringify(doc));

  // Changes made elsewhere (undo) show up here unless you're mid-edit.
  useEffect(() => {
    const json = JSON.stringify(doc);
    if (json !== applied.current && state === "synced") {
      applied.current = json;
      setText(JSON.stringify(doc, null, 2));
    }
  }, [doc]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch (e) {
      setState("invalid");
      setProblems([{ path: "", message: `Not valid JSON yet: ${e instanceof Error ? e.message : e}` }]);
      return;
    }
    setState("checking");
    const t = setTimeout(async () => {
      try {
        const res = await builderApi.validate(parsed);
        if (res.ok && res.doc) {
          setProblems([]);
          setState("synced");
          const json = JSON.stringify(res.doc);
          if (json !== applied.current) {
            applied.current = json;
            commit(res.doc);
          }
        } else {
          setProblems(res.problems);
          setState("invalid");
        }
      } catch (e) {
        setProblems([{ path: "", message: errorMessage(e, "Couldn't check it.") }]);
        setState("invalid");
      }
    }, 450);
    return () => clearTimeout(t);
  }, [text]); // eslint-disable-line react-hooks/exhaustive-deps

  const download = () => {
    const blob = new Blob([JSON.stringify({ $schema: `${location.origin}/api/builder/json-schema`, ...doc }, null, 2)], { type: "application/json" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = `${doc.title.toLowerCase().replace(/[^a-z0-9]+/g, "-") || "form"}.lcsform.json`;
    a.click();
  };

  return (
    <div className="grid h-full min-h-0 grid-cols-1 lg:grid-cols-[1fr_320px]">
      <div className="min-h-0 overflow-y-auto p-3 scroll-thin md:p-4">
        <div className="mb-2 flex flex-wrap items-center gap-2">
          <span className={cn("text-[12.5px] font-semibold", state === "synced" ? "text-status-greenText" : state === "checking" ? "text-muted" : "text-status-redText")}>
            {state === "synced" ? "✓ In sync with the builder" : state === "checking" ? "Checking…" : "Not applied — fix the problems below"}
          </span>
          <div className="flex-1" />
          <Button variant="secondary" size="sm" onClick={() => setText(JSON.stringify(doc, null, 2))}><RotateCcw className="h-3.5 w-3.5" /> Reset to builder</Button>
          <Button variant="secondary" size="sm" onClick={() => navigator.clipboard.writeText(text).then(() => toast("Copied."))}><Copy className="h-3.5 w-3.5" /> Copy</Button>
          <Button variant="secondary" size="sm" onClick={download}><Download className="h-3.5 w-3.5" /> Download</Button>
        </div>
        <CodeEditor value={text} onChange={setText} minHeight={520} />
        {problems.length > 0 && state === "invalid" && <ProblemList problems={problems} />}
      </div>
      <aside className="hidden min-h-0 overflow-y-auto border-l border-hairline bg-surface p-4 text-[12.5px] text-muted scroll-thin lg:block">
        <p className="font-heading text-[14px] font-extrabold text-ink">Form as code</p>
        <p className="mt-1">This is the whole form — the builder, exports, the CLI and AI assistants all read and write exactly this. Valid edits apply to the builder as you type; Save when you're done.</p>
        <p className="mt-3 font-semibold text-ink">Field types</p>
        <ul className="mt-1 space-y-0.5">
          {FIELD_TYPES.map((t) => <li key={t.type}><code className="text-ink">{t.type}</code> — {t.label}</li>)}
        </ul>
        <p className="mt-3">Full reference: <Link to="/admin/ai" className="font-semibold text-accent">Admin → AI form builder</Link>. JSON Schema for your editor: <a className="font-semibold text-accent" href="/api/builder/json-schema" target="_blank" rel="noreferrer">/api/builder/json-schema</a>.</p>
      </aside>
    </div>
  );
}

// ─────────────────────────── Preview ───────────────────────────

/**
 * The form in real device frames: each is the app itself at /f/<slug>/preview,
 * so phone and iPad get the app's real layout (tab bar, folded sidebar). The
 * working document is posted into every frame on each change — unsaved edits
 * show at once.
 */
function PreviewTab({ doc, slug }: { doc: FormDoc; slug: string }) {
  const [result, setResult] = useState<{ values: Values; errors: Record<string, string> } | null>(null);
  const [live, setLive] = useState<Values>({});
  const frames = useRef(new Set<Window>());
  const docRef = useRef(doc);
  docRef.current = doc;

  const post = (win: Window, msg: Record<string, unknown>) => {
    try {
      win.postMessage(msg, window.location.origin);
    } catch {
      frames.current.delete(win);
    }
  };

  useEffect(() => {
    const onMessage = (e: MessageEvent) => {
      if (e.origin !== window.location.origin || !e.data?.lcsPreview || !e.source) return;
      const win = e.source as Window;
      if (e.data.lcsPreview === "ready") {
        frames.current.add(win);
        post(win, { lcsPreview: "doc", doc: docRef.current });
      }
      if (e.data.lcsPreview === "values") {
        setLive(e.data.values as Values);
        setResult(null);
      }
      if (e.data.lcsPreview === "submitted") setResult({ values: e.data.values as Values, errors: e.data.errors as Record<string, string> });
    };
    window.addEventListener("message", onMessage);
    return () => window.removeEventListener("message", onMessage);
  }, []);

  // Every edit goes straight into the frames.
  useEffect(() => {
    for (const w of frames.current) post(w, { lcsPreview: "doc", doc });
  }, [doc]);

  return (
    <div className="grid h-full min-h-0 grid-cols-1 lg:grid-cols-[1fr_300px]">
      <DevicePreview
        src={`/f/${slug}/preview`}
        toolbarExtra={
          <Button variant="ghost" size="sm" onClick={() => { for (const w of frames.current) post(w, { lcsPreview: "reset" }); setResult(null); setLive({}); }}>
            <RotateCcw className="h-3.5 w-3.5" /> Start over
          </Button>
        }
      />
      <aside className="hidden min-h-0 overflow-y-auto border-l border-hairline bg-surface p-4 scroll-thin lg:block">
        <p className="font-heading text-[14px] font-extrabold text-ink">{result ? "What would be saved" : "Answers so far"}</p>
        <p className="mb-2 text-micro text-muted">{result ? "Nothing is saved from Preview." : "Live, with calculations, from whichever device you're filling in. Hidden fields' answers are dropped on submit."}</p>
        {result && Object.keys(result.errors).length > 0 && (
          <p className="mb-2 rounded-input bg-status-amberBg px-2 py-1.5 text-micro text-status-amberText">{Object.keys(result.errors).length} answer(s) would be refused: {Object.keys(result.errors).join(", ")}</p>
        )}
        <pre className="whitespace-pre-wrap break-all rounded-input bg-subtle p-2 font-mono text-[11px] text-ink">{JSON.stringify(result ? result.values : live, null, 2)}</pre>
      </aside>
    </div>
  );
}

// ─────────────────────────── Versions ───────────────────────────

function VersionsTab({ form, dirty, onRestored }: { form: BuiltFormDetail; dirty: boolean; onRestored: (row: BuiltFormDetail) => void }) {
  const { data: versions, isLoading } = useFormVersions(form.id, true);
  const [viewing, setViewing] = useState<{ version: number; doc: FormDoc } | null>(null);
  const toast = useToast();
  return (
    <div className="h-full overflow-y-auto p-4 scroll-thin md:p-6">
      <div className="mx-auto max-w-[720px]">
        <p className="mb-3 text-[13px] text-muted">Every publish is kept. Entries always show with the labels and choices of the version they were filled in on. Restoring copies a version into the draft; publish to make it live.</p>
        {isLoading ? <LoadingState /> : !versions?.length ? (
          <div className="rounded-card border border-dashed border-hairline p-8 text-center text-[13.5px] text-muted">Not published yet.</div>
        ) : (
          <ul className="rounded-card border border-hairline bg-surface">
            {versions.map((v) => (
              <li key={v.version} className="flex flex-wrap items-center gap-3 border-b border-hairline px-4 py-3 last:border-0">
                <span className="grid h-8 w-8 place-items-center rounded-full bg-navsel text-[12px] font-bold text-accent">v{v.version}</span>
                <div className="min-w-0 flex-1">
                  <p className="text-[13.5px] font-semibold text-ink">{v.note || (v.version === form.liveVersion ? "Current live version" : `Version ${v.version}`)}</p>
                  <p className="text-micro text-muted">{v.publishedByName} · {formatDateTime(v.createdAt)}{v.version === form.liveVersion ? " · live" : ""}</p>
                </div>
                <Button variant="secondary" size="sm" onClick={async () => setViewing({ version: v.version, doc: await builderApi.versionDoc(form.id, v.version) })}>View</Button>
                <Button variant="secondary" size="sm" onClick={async () => {
                  if (dirty && !confirm("You have unsaved changes. Restoring replaces the draft with this version. Continue?")) return;
                  try {
                    onRestored(await builderApi.restoreVersion(form.id, v.version));
                    toast(`Version ${v.version} is now the draft.`);
                  } catch (e) {
                    toast(errorMessage(e, "Couldn't restore."), "error");
                  }
                }}>Restore</Button>
              </li>
            ))}
          </ul>
        )}
      </div>
      <Dialog open={Boolean(viewing)} onOpenChange={(o) => !o && setViewing(null)}>
        <DialogContent aria-describedby={undefined} className="w-[min(820px,calc(100vw-2rem))]">
          <DialogHeader title={`Version ${viewing?.version}`} />
          <DialogBody className="max-h-[75vh] overflow-y-auto">
            {viewing && <FormRenderer doc={viewing.doc} mode="preview" user={null} />}
          </DialogBody>
        </DialogContent>
      </Dialog>
    </div>
  );
}

// ─────────────────────────── Publish ───────────────────────────

function PublishDialog({ open, onClose, form, dirty, save, onDone }: { open: boolean; onClose: () => void; form: BuiltFormDetail; dirty: boolean; save: () => Promise<BuiltFormDetail | null>; onDone: (row: BuiltFormDetail) => void }) {
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  const toast = useToast();
  async function go() {
    setBusy(true);
    try {
      if (dirty && !(await save())) return;
      const row = await builderApi.publish(form.id, note.trim() || undefined);
      onDone(row);
      setNote("");
      onClose();
    } catch (e) {
      toast(errorMessage(e, "Couldn't publish."), "error");
    } finally {
      setBusy(false);
    }
  }
  return (
    <Dialog open={open} onOpenChange={(o) => !o && onClose()}>
      <DialogContent aria-describedby={undefined}>
        <DialogHeader title={form.liveVersion ? `Publish version ${form.liveVersion + 1}` : "Publish this form"} subtitle={form.liveVersion ? "People filling it in get the new version from their next visit. Entries already made keep the version they were made on." : "It starts taking entries straight away."} />
        <DialogBody>
          <label className="mb-1 block text-[12px] font-semibold text-muted">What changed? (optional, for the version history)</label>
          <Input autoFocus value={note} onChange={(e) => setNote(e.target.value)} placeholder="e.g. Added a question about pets" onKeyDown={(e) => e.key === "Enter" && void go()} />
          {dirty && <p className="mt-2 text-micro text-muted">Your unsaved changes are saved first.</p>}
        </DialogBody>
        <DialogFooter>
          <Button variant="secondary" onClick={onClose}>Cancel</Button>
          <Button onClick={go} disabled={busy}>{busy && <Loader2 className="h-4 w-4 animate-spin" />} Publish</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
