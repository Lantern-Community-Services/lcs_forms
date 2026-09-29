import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Link, useParams } from "react-router-dom";
import { useQueryClient } from "@tanstack/react-query";
import {
  AlertTriangle, ArrowDown, ArrowUp, ChevronLeft, Copy, Download, ExternalLink, Eye, GripVertical, History, Loader2, Monitor,
  Plus, Redo2, RotateCcw, Rocket, Save, Search, Settings2, Smartphone, Tablet, Trash2, Undo2, Wrench, Braces, EyeOff, GitBranch, Lock,
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
import { FIELD_BLURBS, FieldThumb } from "./FieldThumb";
import { EASE, prefersReducedMotion, useFieldDnd, useListMotion } from "./fieldDnd";
import { readStorage, writeStorage } from "@/lib/storage";
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
import { useMediaQuery } from "@/lib/useMediaQuery";

type Tab = "build" | "code" | "settings" | "preview" | "history";

/** The editor/preview split, as the editor's share of the width; kept per device. */
const SPLIT_KEY = "ln.builder.split";
const SPLIT_DEFAULT = 0.5;
const MIN_EDITOR = 560;
const MIN_PREVIEW = 360;

/**
 * Admin → Form builder → one form. Like the code form editor: the editor on
 * the left (Build, Code, Settings, Versions), the live device preview on the
 * right. Below lg, or with the preview hidden, Preview is a tab instead.
 */
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
  const [showPreview, setShowPreview] = useState(true);
  const wide = useMediaQuery("(min-width: 1024px)");
  const split = wide && showPreview;
  const splitRef = useRef<HTMLDivElement>(null);
  const [ratio, setRatio] = useState(() => {
    const v = Number(readStorage(SPLIT_KEY));
    return v >= 0.15 && v <= 0.85 ? v : SPLIT_DEFAULT;
  });
  const [resizing, setResizing] = useState(false);
  useEffect(() => { if (!resizing) writeStorage(SPLIT_KEY, ratio === SPLIT_DEFAULT ? null : String(ratio)); }, [ratio, resizing]);
  // The preview is its own half now; don't leave the left side on a hidden tab.
  const view: Tab = split && tab === "preview" ? "build" : tab;
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
        <Button variant="secondary" size="sm" onClick={() => setShowPreview((v) => !v)} className="hidden lg:inline-flex">
          {showPreview ? <EyeOff className="h-3.5 w-3.5" /> : <Eye className="h-3.5 w-3.5" />} {showPreview ? "Hide preview" : "Preview"}
        </Button>
        <a href={formPath(form.slug, access)} target="_blank" rel="noreferrer"><Button variant="secondary" size="sm"><ExternalLink className="h-3.5 w-3.5" /> <span className="hidden md:inline">Open</span></Button></a>
        <Button variant="secondary" size="sm" onClick={() => void save().then((r) => r && toast("Saved."))} disabled={!dirty || saving}>
          {saving ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Save className="h-3.5 w-3.5" />} {dirty ? "Save" : "Saved"}
        </Button>
        <Button size="sm" onClick={() => setPublishing(true)} disabled={problems.length > 0}>
          <Rocket className="h-3.5 w-3.5" /> Publish
        </Button>
      </div>

      <div ref={splitRef} className="flex min-h-0 flex-1">
        {/* Editor half */}
        <section
          className={cn("flex min-h-0 min-w-0 flex-col", split ? "flex-none" : "flex-1")}
          style={split ? { width: `clamp(${MIN_EDITOR}px, ${ratio * 100}%, calc(100% - ${MIN_PREVIEW + 9}px))`, transition: resizing || prefersReducedMotion() ? undefined : `width 300ms ${EASE}` } : undefined}
        >
          <div className="flex flex-none gap-1 overflow-x-auto border-b border-hairline bg-surface px-3 md:px-4">
            {([["build", "Build", Wrench], ["code", "Code", Braces], ["settings", "Settings", Settings2], ["preview", "Preview", Eye], ["history", "Versions", History]] as const)
              .filter(([k]) => !(split && k === "preview"))
              .map(([k, label, Icon]) => (
                <button key={k} onClick={() => setTab(k)} className={cn("-mb-px inline-flex items-center gap-1.5 whitespace-nowrap border-b-2 px-3 py-2.5 text-[13px] font-semibold", view === k ? "border-navy text-accent dark:border-white dark:text-white" : "border-transparent text-muted hover:text-ink")}>
                  <Icon className="h-3.5 w-3.5" /> {label}
                </button>
              ))}
            <div className="flex-1" />
            <span className={cn("hidden items-center truncate font-mono text-micro text-muted", split ? "2xl:flex" : "md:flex")}>{formPath(slug, access)}</span>
          </div>

          {serverProblems.length > 0 && (
            <div className="flex-none px-4 pt-2">
              <ProblemList problems={serverProblems} />
            </div>
          )}

          <div className="min-h-0 flex-1">
            {view === "build" && <BuildTab doc={doc} commit={commit} selected={selected} setSelected={setSelected} compact={split} />}
            {view === "code" && <CodeTab doc={doc} commit={commit} compact={split} />}
            {view === "settings" && (
              <div className="h-full overflow-y-auto scroll-thin">
                <SettingsPanel doc={doc} onChange={commit} slug={slug} onSlug={setSlug} reference={reference} form={form} onCatalog={setCatalog} />
              </div>
            )}
            {view === "preview" && <PreviewPane doc={doc} slug={form.slug} />}
            {view === "history" && <VersionsTab form={form} dirty={dirty} onRestored={(row) => { adopt(row); setDoc(row.draft); }} />}
          </div>
        </section>

        {/* Preview half: stays mounted across tabs so the frames don't reload. */}
        {split && <SplitHandle containerRef={splitRef} ratio={ratio} onRatio={setRatio} onResizing={setResizing} />}
        {split && (
          <section className="flex min-h-0 min-w-0 flex-1 flex-col">
            <PreviewPane doc={doc} slug={form.slug} side />
          </section>
        )}
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

/**
 * Full width: palette | canvas | properties. Next to the preview (compact):
 * canvas | one column showing the palette, or the selected field's properties.
 * Fields drag in from the palette and reorder on the canvas (fieldDnd.tsx).
 */
function BuildTab({ doc, commit, selected, setSelected, compact = false }: { doc: FormDoc; commit: (d: FormDoc | ((d: FormDoc) => FormDoc)) => void; selected: string | null; setSelected: (id: string | null) => void; compact?: boolean }) {
  const toast = useToast();
  const field = doc.fields.find((f) => f.id === selected) ?? null;
  const ids = useMemo(() => doc.fields.map((f) => f.id), [doc.fields]);
  const listRef = useRef<HTMLDivElement>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const motion = useListMotion(listRef, ids);

  const insertAt = (type: FieldType, index?: number) => {
    const f = newField(type, doc.fields.map((x) => x.id));
    const at = index ?? (field ? doc.fields.indexOf(field) + 1 : doc.fields.length);
    commit((d) => ({ ...d, fields: [...d.fields.slice(0, at), f, ...d.fields.slice(at)] }));
    setSelected(f.id);
    return f.id;
  };

  const dnd = useFieldDnd({
    listRef,
    scrollRef,
    ids,
    onDrop: (src, index) => {
      if (src.kind === "new") {
        const f = newField(src.type, doc.fields.map((x) => x.id));
        motion.dropped(f.id);
        commit((d) => ({ ...d, fields: [...d.fields.slice(0, index), f, ...d.fields.slice(index)] }));
        setSelected(f.id);
        return;
      }
      const from = doc.fields.findIndex((f) => f.id === src.id);
      if (from < 0 || from === index || from + 1 === index) return;
      motion.dropped(src.id);
      commit((d) => ({ ...d, fields: moveItem(d.fields, from, index) }));
    },
  });

  const updateField = (id: string, next: Field) => commit((d) => ({ ...d, fields: d.fields.map((f) => (f.id === id ? next : f)) }));

  const remove = async (f: Field) => {
    const refs = referencesTo(doc, f.id);
    if (refs.length && !confirm(`“${f.label || f.id}” is used by ${refs.join(", ")}. Delete it anyway? Those rules will stop working.`)) return;
    await motion.collapse(f.id);
    commit((d) => ({ ...d, fields: d.fields.filter((x) => x.id !== f.id) }));
    if (selected === f.id) setSelected(null);
  };

  const duplicate = (f: Field) => {
    const copy = { ...JSON.parse(JSON.stringify(f)), id: makeFieldId(`${f.id}_copy`, doc.fields.map((x) => x.id)), label: f.label ? `${f.label} (copy)` : f.label } as Field;
    const at = doc.fields.indexOf(f) + 1;
    commit((d) => ({ ...d, fields: [...d.fields.slice(0, at), copy, ...d.fields.slice(at)] }));
    setSelected(copy.id);
  };

  const palette = (
    <Palette
      compact={compact}
      onAdd={(type) => { if (!dnd.consumeClick()) insertAt(type); }}
      dragSource={(t) => dnd.start({ kind: "new", type: t.type, label: t.label })}
    />
  );

  return (
    <div className={cn("grid h-full min-h-0", compact ? "grid-cols-[minmax(0,1fr)_minmax(280px,340px)]" : "grid-cols-1 md:grid-cols-[250px_1fr] xl:grid-cols-[250px_1fr_360px]")}>
      {/* Palette */}
      {!compact && (
        <aside className="hidden min-h-0 border-r border-hairline bg-surface md:flex md:flex-col">
          {palette}
        </aside>
      )}

      {/* Canvas */}
      <div
        ref={scrollRef}
        className={cn("min-h-0 overflow-y-auto transition-colors duration-150 scroll-thin", dnd.over && "bg-navsel/40")}
        onClick={() => { if (!dnd.consumeClick()) setSelected(null); }}
      >
        <div className={cn("mx-auto max-w-[760px]", compact ? "p-3 xl:p-4" : "p-3 md:p-6")}>
          <div className={cn("mb-3", compact ? "hidden" : "md:hidden")}>
            <DropdownMenu>
              <DropdownMenuTrigger asChild><Button className="w-full"><Plus className="h-4 w-4" /> Add field</Button></DropdownMenuTrigger>
              <DropdownMenuContent className="max-h-80 overflow-y-auto">
                {FIELD_TYPES.map((t) => <DropdownMenuItem key={t.type} onSelect={() => insertAt(t.type)}>{t.group} · {t.label}</DropdownMenuItem>)}
              </DropdownMenuContent>
            </DropdownMenu>
          </div>
          <div className={cn("rounded-card border bg-surface p-4 shadow-sm transition-[border-color,box-shadow] duration-150 md:p-6", dnd.over ? "border-navy/40 ring-4 ring-navy/10 dark:border-accent/50" : "border-hairline")}>
            <h2 className="font-heading text-[21px] font-extrabold text-ink">{doc.title || "Untitled form"}</h2>
            {doc.description && <div className="prose-form mt-1 text-[13.5px] text-muted" dangerouslySetInnerHTML={{ __html: doc.description }} />}
            <div ref={listRef} className="relative mt-5" style={dnd.listStyle}>
              {!doc.fields.length && (
                <div
                  data-drop-empty
                  className={cn(
                    "rounded-card border-2 border-dashed p-10 text-center text-[13.5px] transition-colors duration-150",
                    dnd.overNew ? "border-navy bg-navsel/40 font-semibold text-accent dark:border-accent" : "border-hairline text-muted"
                  )}
                >
                  {dnd.overNew ? `Release to add ${dnd.overNew}` : `Drag a field here, or click one on the ${compact ? "right" : "left"}.`}
                </div>
              )}
              {doc.fields.map((f, i) => (
                <div
                  key={f.id}
                  data-field-row={f.id}
                  className="py-1"
                  style={dnd.rowStyle(f.id)}
                  onPointerDown={dnd.start({ kind: "move", id: f.id, label: f.label || typeInfo(f.type)?.label || f.id })}
                >
                  <FieldCard
                    field={f}
                    doc={doc}
                    index={i}
                    count={doc.fields.length}
                    selected={selected === f.id && !dnd.dragging}
                    held={dnd.heldId === f.id}
                    onSelect={() => { if (!dnd.consumeClick()) setSelected(f.id); }}
                    onMove={(d) => commit((x) => ({ ...x, fields: moveItem(x.fields, i, d < 0 ? i - 1 : i + 2) }))}
                    onDuplicate={() => duplicate(f)}
                    onRemove={() => void remove(f)}
                  />
                </div>
              ))}
              {dnd.slotStyle && (
                <div data-drop-slot aria-hidden className="lcs-slot pointer-events-none absolute inset-x-0 rounded-card border-[1.5px] border-dashed border-navy bg-navsel/50 dark:border-accent" style={dnd.slotStyle} />
              )}
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
      <aside className={cn("min-h-0 border-l border-hairline bg-surface", compact ? "block" : field ? "fixed inset-x-0 bottom-0 z-40 h-[70vh] rounded-t-card shadow-modal xl:static xl:h-auto xl:rounded-none xl:shadow-none" : "hidden xl:block")}>
        {field ? (
          <div className="flex h-full flex-col">
            {compact ? (
              <div className="flex flex-none items-center border-b border-hairline px-2 py-1">
                <button onClick={() => setSelected(null)} className="inline-flex items-center gap-1 rounded-input px-1.5 py-1 text-[12.5px] font-semibold text-accent hover:bg-subtle dark:text-white">
                  <Plus className="h-3.5 w-3.5" /> Add field
                </button>
                <div className="flex-1" />
                <button onClick={() => setSelected(null)} className="rounded-input px-1.5 py-1 text-micro font-semibold text-muted hover:bg-subtle hover:text-ink">Done</button>
              </div>
            ) : (
              <button onClick={() => setSelected(null)} className="flex-none border-b border-hairline py-1.5 text-center text-micro font-semibold text-muted xl:hidden">Done</button>
            )}
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
        ) : compact ? (
          <div className="flex h-full min-h-0 flex-col">{palette}</div>
        ) : (
          <div className="p-5 text-[13px] text-muted">
            <p className="font-heading text-[15px] font-extrabold text-ink">Nothing selected</p>
            <p className="mt-1">Click a field to edit its label, choices, rules and more. Form-wide options — who can fill it in, limits, notifications, the confirmation — are under Settings.</p>
            <p className="mt-3">Shortcuts: Ctrl+S save · Ctrl+Z undo · Ctrl+Shift+Z redo.</p>
          </div>
        )}
      </aside>
      {dnd.ghost}
    </div>
  );
}

/** Add a field: a searchable grid of pictures of each field type, with a plain description of the one under the pointer. */
function Palette({ compact, onAdd, dragSource }: {
  compact: boolean;
  onAdd: (type: FieldType) => void;
  dragSource: (t: (typeof FIELD_TYPES)[number]) => (e: React.PointerEvent<HTMLElement>) => void;
}) {
  const [query, setQuery] = useState("");
  const [hovered, setHovered] = useState<FieldType>("text");
  const q = query.trim().toLowerCase();
  const groups = useMemo(() => {
    const g = new Map<string, typeof FIELD_TYPES>();
    for (const t of FIELD_TYPES) {
      if (q && !`${t.label} ${t.type} ${FIELD_BLURBS[t.type]}`.toLowerCase().includes(q)) continue;
      g.set(t.group, [...(g.get(t.group) ?? []), t]);
    }
    return [...g.entries()];
  }, [q]);
  const info = typeInfo(hovered);

  return (
    <>
      <div className="flex-none space-y-2 border-b border-hairline p-3 pb-2.5">
        {compact && <p className="px-0.5 font-heading text-[14px] font-extrabold text-ink">Add a field</p>}
        <label className="flex h-8 items-center gap-2 rounded-input border border-hairline bg-subtle px-2.5 focus-within:border-navy dark:focus-within:border-accent">
          <Search className="h-3.5 w-3.5 flex-none text-muted" aria-hidden />
          <input
            type="search"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search fields"
            aria-label="Search fields"
            className="min-w-0 flex-1 bg-transparent text-[13px] text-ink placeholder:text-muted focus:outline-none"
          />
        </label>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto px-3 pb-3 scroll-thin">
        {groups.map(([group, types]) => (
          <div key={group}>
            <p className="px-0.5 pb-1.5 pt-3 text-micro font-bold uppercase tracking-[0.04em] text-muted">{group}</p>
            <div className="grid grid-cols-2 gap-2">
              {types.map((t) => (
                <button
                  key={t.type}
                  type="button"
                  onPointerDown={dragSource(t)}
                  onClick={() => onAdd(t.type)}
                  onMouseEnter={() => setHovered(t.type)}
                  onFocus={() => setHovered(t.type)}
                  title={FIELD_BLURBS[t.type]}
                  className="lcs-tile group/tile flex min-w-0 cursor-grab select-none flex-col gap-1.5 rounded-card border border-hairline bg-surface p-1.5 pb-2 text-left transition-[border-color,box-shadow,transform] duration-150 hover:-translate-y-px hover:border-navy hover:shadow-card focus-visible:border-navy focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-navy/25 active:scale-[.98] dark:hover:border-accent dark:focus-visible:border-accent"
                >
                  <span className="block overflow-hidden rounded-input bg-subtle transition-colors group-hover/tile:bg-navsel/60">
                    <FieldThumb type={t.type} />
                  </span>
                  <span className="truncate px-0.5 text-[12.5px] font-semibold text-ink">{t.label}</span>
                </button>
              ))}
            </div>
          </div>
        ))}
        {!groups.length && <p className="px-1 py-6 text-center text-[13px] text-muted">No fields match “{query}”.</p>}
      </div>
      <div className="min-h-[76px] flex-none border-t border-hairline bg-subtle/60 px-3 py-2.5">
        <p className="text-[13px] font-semibold text-ink">{info?.label}</p>
        <p className="text-[12.5px] leading-snug text-muted">{FIELD_BLURBS[hovered]}</p>
        <p className="mt-1 text-micro text-muted">Drag onto the form, or click to add below the selected field.</p>
      </div>
    </>
  );
}

function FieldCard({
  field: f, doc, index, count, selected, held, onSelect, onMove, onDuplicate, onRemove,
}: {
  field: Field;
  doc: FormDoc;
  index: number;
  count: number;
  selected: boolean;
  /** Being dragged: this card is the placeholder the rows slide around. */
  held: boolean;
  onSelect: () => void;
  onMove: (d: -1 | 1) => void;
  onDuplicate: () => void;
  onRemove: () => void;
}) {
  const noop = () => undefined;
  return (
    <div
      onClick={(e) => { e.stopPropagation(); onSelect(); }}
      className={cn(
        "group relative cursor-pointer rounded-card border p-3 transition-[background-color,border-color,box-shadow] duration-150",
        held
          ? "border-dashed border-navy/50 bg-navsel/40 dark:border-accent/50 [&>*]:opacity-0"
          : selected ? "border-navy bg-navsel/30 ring-2 ring-navy/20" : "border-transparent hover:border-hairline hover:bg-subtle/40",
        !held && f.type === "page" && "border-dashed border-strongline bg-subtle/60"
      )}
    >
      <div
        data-drag-handle
        title="Drag to move"
        className={cn("absolute -left-1 top-2.5 cursor-grab touch-none rounded p-0.5 text-strongline hover:bg-subtle hover:text-muted md:-left-6", selected ? "block" : "hidden group-hover:block")}
      >
        <GripVertical className="h-4 w-4" />
      </div>
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

/**
 * The divider between the editor and the preview. Drag it, nudge it with the
 * arrow keys (Shift for bigger steps), double-click to put it back in the middle.
 */
function SplitHandle({ containerRef, ratio, onRatio, onResizing }: {
  containerRef: React.RefObject<HTMLDivElement | null>;
  ratio: number;
  onRatio: (r: number) => void;
  onResizing: (on: boolean) => void;
}) {
  const start = useRef<{ x: number; ratio: number } | null>(null);
  const [readout, setReadout] = useState<{ editor: number; preview: number } | null>(null);

  const clampTo = (v: number) => {
    const w = containerRef.current?.getBoundingClientRect().width ?? 0;
    if (!w) return v;
    const min = Math.min(0.5, MIN_EDITOR / w), max = Math.max(0.5, 1 - (MIN_PREVIEW + 9) / w);
    return Math.min(max, Math.max(min, v));
  };
  const stop = () => {
    start.current = null;
    setReadout(null);
    onResizing(false);
    document.documentElement.classList.remove("lcs-resizing");
  };

  return (
    <div
      role="separator"
      aria-orientation="vertical"
      aria-label="Resize the editor and preview"
      aria-valuemin={15}
      aria-valuemax={85}
      aria-valuenow={Math.round(ratio * 100)}
      tabIndex={0}
      title="Drag to resize · double-click to reset"
      onPointerDown={(e) => {
        if (e.button !== 0) return;
        e.preventDefault();
        // Captured, so the pointer isn't lost to the preview's iframes.
        try { e.currentTarget.setPointerCapture(e.pointerId); } catch { /* no active pointer */ }
        start.current = { x: e.clientX, ratio };
        onResizing(true);
        document.documentElement.classList.add("lcs-resizing");
      }}
      onPointerMove={(e) => {
        const s = start.current, w = containerRef.current?.getBoundingClientRect().width;
        if (!s || !w) return;
        const v = clampTo(s.ratio + (e.clientX - s.x) / w);
        onRatio(v);
        setReadout({ editor: Math.round(v * w), preview: Math.round(w - v * w - 9) });
      }}
      onPointerUp={stop}
      onPointerCancel={stop}
      onLostPointerCapture={() => start.current && stop()}
      onDoubleClick={() => onRatio(SPLIT_DEFAULT)}
      onKeyDown={(e) => {
        const step = e.shiftKey ? 0.1 : 0.02;
        const next = e.key === "ArrowLeft" ? ratio - step : e.key === "ArrowRight" ? ratio + step : e.key === "Home" ? 0 : e.key === "End" ? 1 : null;
        if (next === null) return;
        e.preventDefault();
        onRatio(clampTo(next));
      }}
      className="group relative flex w-[9px] flex-none cursor-col-resize touch-none justify-center outline-none"
    >
      <span className={cn(
        "h-full w-px bg-hairline transition-[width,background-color] duration-150 group-hover:w-[3px] group-hover:bg-navy group-focus-visible:w-[3px] group-focus-visible:bg-navy dark:group-hover:bg-accent dark:group-focus-visible:bg-accent",
        readout && "w-[3px] bg-navy dark:bg-accent"
      )} />
      <span className={cn(
        "absolute left-1/2 top-1/2 flex h-11 w-3.5 -translate-x-1/2 -translate-y-1/2 flex-col items-center justify-center gap-[3px] rounded-pill border bg-surface shadow-card transition-colors duration-150 group-hover:border-navy group-focus-visible:border-navy dark:group-hover:border-accent",
        readout ? "border-navy dark:border-accent" : "border-strongline"
      )}>
        {[0, 1, 2].map((i) => (
          <span key={i} className={cn("h-[3px] w-[3px] rounded-full transition-colors group-hover:bg-navy dark:group-hover:bg-accent", readout ? "bg-navy dark:bg-accent" : "bg-muted")} />
        ))}
      </span>
      {readout && (
        <span className="pointer-events-none absolute left-1/2 top-3 z-10 -translate-x-1/2 whitespace-nowrap rounded-input bg-navy px-2 py-1 font-mono text-micro text-white shadow-modal">
          {readout.editor} ⟷ {readout.preview}
        </span>
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

function CodeTab({ doc, commit, compact = false }: { doc: FormDoc; commit: (d: FormDoc) => void; compact?: boolean }) {
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
    <div className={cn("grid h-full min-h-0 grid-cols-1", !compact && "lg:grid-cols-[1fr_320px]")}>
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
        {compact && (
          <p className="mt-3 text-micro text-muted">
            The whole form as JSON; valid edits apply as you type. Field types and the full reference: <Link to="/admin/ai" className="font-semibold text-accent">Admin → AI form builder</Link> · <a className="font-semibold text-accent" href="/api/builder/json-schema" target="_blank" rel="noreferrer">JSON Schema</a>.
          </p>
        )}
      </div>
      <aside className={cn("hidden min-h-0 overflow-y-auto border-l border-hairline bg-surface p-4 text-[12.5px] text-muted scroll-thin", !compact && "lg:block")}>
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
function PreviewPane({ doc, slug, side = false }: { doc: FormDoc; slug: string; side?: boolean }) {
  const [showAnswers, setShowAnswers] = useState(false);
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

  const reset = () => {
    for (const w of frames.current) post(w, { lcsPreview: "reset" });
    setResult(null);
    setLive({});
  };

  const answers = (
    <>
      <p className="font-heading text-[14px] font-extrabold text-ink">{result ? "What would be saved" : "Answers so far"}</p>
      <p className="mb-2 text-micro text-muted">{result ? "Nothing is saved from Preview." : "Live, with calculations, from whichever device you're filling in. Hidden fields' answers are dropped on submit."}</p>
      {result && Object.keys(result.errors).length > 0 && (
        <p className="mb-2 rounded-input bg-status-amberBg px-2 py-1.5 text-micro text-status-amberText">{Object.keys(result.errors).length} answer(s) would be refused: {Object.keys(result.errors).join(", ")}</p>
      )}
      <pre className="whitespace-pre-wrap break-all rounded-input bg-subtle p-2 font-mono text-[11px] text-ink">{JSON.stringify(result ? result.values : live, null, 2)}</pre>
    </>
  );

  const toolbar = (
    <>
      {side && (
        <Button variant={showAnswers ? "secondary" : "ghost"} size="sm" onClick={() => setShowAnswers((v) => !v)} title="What's been filled in, and what would be saved">
          <Braces className="h-3.5 w-3.5" /> Answers
        </Button>
      )}
      <Button variant="ghost" size="sm" onClick={reset}>
        <RotateCcw className="h-3.5 w-3.5" /> Start over
      </Button>
    </>
  );

  // Beside the editor: answers open in a drawer under the frames.
  if (side) {
    return (
      <div className="flex h-full min-h-0 flex-col">
        <div className="min-h-0 flex-1">
          <DevicePreview src={`/f/${slug}/preview`} toolbarExtra={toolbar} />
        </div>
        {showAnswers && <div className="h-[34%] min-h-[160px] flex-none overflow-y-auto border-t border-hairline bg-surface p-3 scroll-thin">{answers}</div>}
        <p className="flex-none border-t border-hairline bg-surface px-3 py-1 text-micro text-muted">Live preview of your unsaved edits, in the app on each device. Nothing is submitted.</p>
      </div>
    );
  }

  return (
    <div className="grid h-full min-h-0 grid-cols-1 lg:grid-cols-[1fr_300px]">
      <DevicePreview src={`/f/${slug}/preview`} toolbarExtra={toolbar} />
      <aside className="hidden min-h-0 overflow-y-auto border-l border-hairline bg-surface p-4 scroll-thin lg:block">{answers}</aside>
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
