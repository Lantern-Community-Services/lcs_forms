import { useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { ArrowDown, ArrowUp, ExternalLink, EyeOff, Lock, Pencil, Plus, Trash2 } from "lucide-react";
import { Page, PageHeader } from "@/components/shell/AppShell";
import { Tag } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { CheckboxList } from "@/components/ui/checkbox";
import { Dialog, DialogBody, DialogContent, DialogFooter, DialogHeader } from "@/components/ui/dialog";
import { Input, Textarea } from "@/components/ui/input";
import { Field } from "@/components/ui/label";
import { EmptyState, LoadingState } from "@/components/ui/misc";
import { Select } from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { useToast } from "@/components/ui/toast";
import { ApiError } from "@/lib/api";
import { IconPicker } from "@/components/IconPicker";
import { formIcon, isInternalForm, type FormIconKey } from "@/lib/formIcons";
import { formsApi, useBuiltFormOptions, useForms, useRoles, type BuiltFormOption } from "@/lib/queries";
import type { FormCategory, FormLink } from "@/lib/types";
import { cn, errorMessage } from "@/lib/utils";

type FormDraft = {
  id?: string;
  /** "built": opens a form made in Form builder / Code forms; "link": any URL or app path. */
  source: "built" | "link";
  categoryId: string;
  title: string;
  description: string;
  url: string;
  keywords: string;
  badge: string;
  /** Null = the category's icon. */
  icon: FormIconKey | null;
  active: boolean;
  /** Role keys that may see it; empty = everyone. */
  roles: string[];
};
type CategoryDraft = { id?: string; name: string; icon: FormIconKey };
type Pending = { kind: "form"; form: FormLink } | { kind: "category"; category: FormCategory };

/**
 * What staff see on the Forms screen. Every change is live for everyone as
 * soon as it saves, and each one lands in the Activity log.
 */
export function AdminFormsCatalog() {
  const { data, isLoading } = useForms(true);
  const { data: allRoles } = useRoles();
  const { data: built } = useBuiltFormOptions();
  const builtByUrl = new Map((built ?? []).map((b) => [b.url, b]));
  // Admins see every form regardless, so they aren't offered as a choice.
  const limitable = (allRoles ?? []).filter((r) => r.key !== "admin");
  const roleNames = (keys: string[]) => keys.map((k) => allRoles?.find((r) => r.key === k)?.name ?? k).join(", ");
  const qc = useQueryClient();
  const toast = useToast();
  const [form, setForm] = useState<FormDraft | null>(null);
  const [category, setCategory] = useState<CategoryDraft | null>(null);
  const [pending, setPending] = useState<Pending | null>(null);
  const [busy, setBusy] = useState(false);
  const categories = data?.categories ?? [];

  async function run(fn: () => Promise<unknown>, done?: string) {
    setBusy(true);
    try {
      await fn();
      await qc.invalidateQueries({ queryKey: ["forms"] });
      await qc.invalidateQueries({ queryKey: ["builder"] });
      await qc.invalidateQueries({ queryKey: ["apps"] });
      if (done) toast(done);
      return true;
    } catch (e) {
      toast(messageOf(e), "error");
      return false;
    } finally {
      setBusy(false);
    }
  }

  function moveCategory(index: number, by: -1 | 1) {
    const ids = categories.map((c) => c.id);
    [ids[index], ids[index + by]] = [ids[index + by], ids[index]];
    void run(() => formsApi.reorderCategories(ids));
  }

  function moveForm(cat: FormCategory, index: number, by: -1 | 1) {
    const ids = cat.forms.map((f) => f.id);
    [ids[index], ids[index + by]] = [ids[index + by], ids[index]];
    void run(() => formsApi.reorder(cat.id, ids));
  }

  async function saveForm() {
    if (!form) return;
    const body = {
      categoryId: form.categoryId,
      title: form.title,
      description: form.description,
      url: form.url,
      keywords: form.keywords,
      badge: form.badge,
      icon: form.icon,
      active: form.active,
      roles: form.roles,
    };
    const ok = await run(
      () => (form.id ? formsApi.update(form.id, body) : formsApi.create(body)),
      form.id ? "Form saved." : "Form added."
    );
    if (ok) setForm(null);
  }

  async function saveCategory() {
    if (!category) return;
    const body = { name: category.name, icon: category.icon };
    const ok = await run(
      () => (category.id ? formsApi.updateCategory(category.id, body) : formsApi.createCategory(body)),
      category.id ? "Category saved." : "Category added."
    );
    if (ok) setCategory(null);
  }

  async function confirmDelete() {
    if (!pending) return;
    const ok =
      pending.kind === "form"
        ? await run(() => formsApi.remove(pending.form.id), `Deleted “${pending.form.title}”.`)
        : await run(() => formsApi.removeCategory(pending.category.id), `Deleted “${pending.category.name}”.`);
    if (ok) setPending(null);
  }

  const newForm = (categoryId: string) =>
    setForm({ source: "link", categoryId, title: "", description: "", url: "https://forms.lanterncommunity.org/", keywords: "", badge: "", icon: null, active: true, roles: [] });

  /** Fill a card from a built form: its address, title, icon, blurb and who can open it. */
  function pickBuilt(f: FormDraft, b: BuiltFormOption): FormDraft {
    const previous = built?.find((x) => x.url === f.url);
    const keepTitle = f.title.trim() && f.title !== previous?.title;
    const keepDescription = f.description.trim() && f.description !== (previous?.description ?? "");
    return {
      ...f,
      url: b.url,
      title: keepTitle ? f.title : b.title,
      description: keepDescription ? f.description : b.description ?? "",
      icon: b.icon ? (b.icon as FormIconKey) : f.icon,
      roles: b.roles,
    };
  }

  /** The hint under the built-form picker. */
  function builtHint(url: string) {
    const b = builtByUrl.get(url);
    if (!b) return "Forms made in Admin → Form builder and Admin → Code forms. The card stays tied to the form, so a new URL name or an archive carries through.";
    if (!b.live) return "This form hasn't been published yet. Staff who click the card are told it isn't available until it is.";
    return `Opens ${b.url}. Who sees the card was filled in from the form's own access settings; change it below if you like.`;
  }

  if (isLoading) return <LoadingState />;

  return (
    <Page className="max-w-[960px]">
      <PageHeader
        title="Forms catalog"
        subtitle="What staff see on the Forms screen. Changes are live for everyone as soon as they save."
        actions={
          <>
            <Button variant="secondary" onClick={() => setCategory({ name: "", icon: "folder" })}>
              <Plus className="h-4 w-4" /> Category
            </Button>
            <Button onClick={() => newForm(categories[0]?.id ?? "")} disabled={categories.length === 0}>
              <Plus className="h-4 w-4" /> Add form
            </Button>
          </>
        }
      />

      {categories.length === 0 && <EmptyState title="No categories yet" hint="Add a category first, then put forms in it." />}

      <div className="space-y-4">
        {categories.map((cat, ci) => {
          const Icon = formIcon(cat.icon);
          return (
            <Card key={cat.id} className="overflow-hidden">
              <div className="flex items-center gap-2 border-b border-hairline bg-subtle/60 px-4 py-2.5">
                <Icon className="h-4 w-4 shrink-0 text-muted" />
                <p className="min-w-0 flex-1 truncate text-[14.5px] font-heading font-extrabold text-ink">
                  {cat.name} <span className="ml-1 text-[12px] font-semibold text-muted tabular">{cat.forms.length}</span>
                </p>
                <IconButton label="Move category up" disabled={busy || ci === 0} onClick={() => moveCategory(ci, -1)}><ArrowUp className="h-4 w-4" /></IconButton>
                <IconButton label="Move category down" disabled={busy || ci === categories.length - 1} onClick={() => moveCategory(ci, 1)}><ArrowDown className="h-4 w-4" /></IconButton>
                <IconButton label="Rename category" onClick={() => setCategory({ id: cat.id, name: cat.name, icon: cat.icon || "folder" })}><Pencil className="h-4 w-4" /></IconButton>
                <IconButton
                  label={cat.forms.length ? "Move or delete its forms first" : "Delete category"}
                  disabled={cat.forms.length > 0}
                  onClick={() => setPending({ kind: "category", category: cat })}
                >
                  <Trash2 className="h-4 w-4" />
                </IconButton>
              </div>

              <ul>
                {cat.forms.map((f, fi) => (
                  <li key={f.id} className={cn("flex items-center gap-2 border-b border-hairline px-4 py-2.5 last:border-0", !f.active && "bg-subtle/40")}>
                    <div className="min-w-0 flex-1">
                      <p className={cn("flex flex-wrap items-center gap-x-2 text-[13.5px] font-semibold", f.active ? "text-ink" : "text-muted")}>
                        {f.title}
                        {f.badge && <Tag>{f.badge}</Tag>}
                        {!f.active && (
                          <Tag tone="neutral">
                            <EyeOff className="h-3 w-3" /> Hidden
                          </Tag>
                        )}
                        {builtByUrl.has(f.url) ? (
                          <Tag tone="accent">{builtByUrl.get(f.url)!.kind === "code" ? "Code form" : "Form builder"}</Tag>
                        ) : (
                          isInternalForm(f.url) && <Tag tone="accent">Built in</Tag>
                        )}
                        {builtByUrl.has(f.url) && !builtByUrl.get(f.url)!.live && <Tag tone="amber" title="Staff can't open it until it's published">Not published</Tag>}
                        {f.roles.length > 0 && (
                          <Tag tone="neutral" title={`Only ${roleNames(f.roles)} (and Admins) can see this form`}>
                            <Lock className="h-3 w-3" /> {roleNames(f.roles)}
                          </Tag>
                        )}
                      </p>
                      <a href={isInternalForm(f.url) ? undefined : f.url} target="_blank" rel="noopener noreferrer" className="mt-0.5 flex items-center gap-1 truncate text-micro text-muted hover:text-ink">
                        <span className="truncate">{f.url}</span>
                        {!isInternalForm(f.url) && <ExternalLink className="h-3 w-3 shrink-0" />}
                      </a>
                    </div>
                    <Switch
                      checked={f.active}
                      disabled={busy}
                      onCheckedChange={(active) => void run(() => formsApi.update(f.id, { active }), active ? `“${f.title}” is visible again.` : `“${f.title}” is hidden from staff.`)}
                      aria-label={f.active ? `Hide ${f.title}` : `Show ${f.title}`}
                      title={f.active ? "Visible to staff" : "Hidden from staff"}
                    />
                    <IconButton label="Move up" disabled={busy || fi === 0} onClick={() => moveForm(cat, fi, -1)}><ArrowUp className="h-4 w-4" /></IconButton>
                    <IconButton label="Move down" disabled={busy || fi === cat.forms.length - 1} onClick={() => moveForm(cat, fi, 1)}><ArrowDown className="h-4 w-4" /></IconButton>
                    <IconButton
                      label="Edit form"
                      onClick={() =>
                        setForm({
                          id: f.id,
                          source: builtByUrl.has(f.url) ? "built" : "link",
                          categoryId: f.categoryId,
                          title: f.title,
                          description: f.description ?? "",
                          url: f.url,
                          keywords: f.keywords ?? "",
                          badge: f.badge ?? "",
                          icon: f.icon || null,
                          active: f.active,
                          roles: f.roles,
                        })
                      }
                    >
                      <Pencil className="h-4 w-4" />
                    </IconButton>
                    <IconButton label="Delete form" onClick={() => setPending({ kind: "form", form: f })}><Trash2 className="h-4 w-4" /></IconButton>
                  </li>
                ))}
                <li>
                  <button onClick={() => newForm(cat.id)} className="flex min-h-[40px] w-full items-center gap-2 px-4 text-[13px] font-semibold text-accent hover:bg-rowhover dark:text-white">
                    <Plus className="h-4 w-4" /> Add a form to {cat.name}
                  </button>
                </li>
              </ul>
            </Card>
          );
        })}
      </div>

      {/* ── Form editor ─────────────────────────────────────────── */}
      <Dialog open={form !== null} onOpenChange={(o) => !o && setForm(null)}>
        <DialogContent>
          <DialogHeader title={form?.id ? "Edit form" : "Add a form"} subtitle="A form built here, a form on WordPress, or any screen in this app." />
          {form && (
            <form onSubmit={(e) => { e.preventDefault(); void saveForm(); }}>
              <DialogBody className="max-h-[65vh] space-y-3.5 overflow-y-auto scroll-thin">
                <Field label="Title">
                  <Input value={form.title} onChange={(e) => setForm({ ...form, title: e.target.value })} maxLength={120} required autoFocus />
                </Field>
                <div className="inline-flex rounded-input border border-hairline p-0.5">
                  {([["built", "A form built here"], ["link", "A link"]] as const).map(([k, label]) => (
                    <button
                      key={k}
                      type="button"
                      onClick={() => setForm(k === "link" ? { ...form, source: k } : { ...form, source: k, url: builtByUrl.has(form.url) ? form.url : "" })}
                      className={cn("rounded-[5px] px-3 py-1.5 text-[13px] font-semibold", form.source === k ? "bg-navy text-white" : "text-muted hover:text-ink")}
                    >
                      {label}
                    </button>
                  ))}
                </div>
                {form.source === "built" ? (
                  <Field label="Form" hint={builtHint(form.url)}>
                    <Select
                      value={builtByUrl.has(form.url) ? form.url : ""}
                      onChange={(e) => {
                        const b = built?.find((x) => x.url === e.target.value);
                        if (b) setForm(pickBuilt(form, b));
                      }}
                      placeholder={built?.length ? "Pick a form…" : "No forms built yet"}
                    >
                      {(["basic", "code"] as const).map((kind) => {
                        const list = (built ?? []).filter((b) => b.kind === kind);
                        if (!list.length) return null;
                        return (
                          <optgroup key={kind} label={kind === "code" ? "Code forms" : "Form builder"}>
                            {list.map((b) => (
                              <option key={b.id} value={b.url}>
                                {b.title}
                                {b.live ? "" : " (draft)"}
                                {b.catalogLinkId && b.url !== form.url ? " · already on the catalog" : ""}
                              </option>
                            ))}
                          </optgroup>
                        );
                      })}
                    </Select>
                  </Field>
                ) : (
                  <Field label="Link" hint="A full address such as https://forms.lanterncommunity.org/incident-reports/, or an app path such as /roster.">
                    <Input value={form.url} onChange={(e) => setForm({ ...form, url: e.target.value })} maxLength={2000} required inputMode="url" />
                  </Field>
                )}
                <Field label="Category">
                  <Select value={form.categoryId} onChange={(e) => setForm({ ...form, categoryId: e.target.value })} options={categories.map((c) => ({ value: c.id, label: c.name }))} />
                </Field>
                <Field label="Description" hint="One short line under the title.">
                  <Textarea value={form.description} onChange={(e) => setForm({ ...form, description: e.target.value })} maxLength={300} className="min-h-[64px]" />
                </Field>
                <Field label="Search words" hint="Other words people might search for, separated by commas (e.g. an old form name).">
                  <Input value={form.keywords} onChange={(e) => setForm({ ...form, keywords: e.target.value })} maxLength={255} />
                </Field>
                <Field label="Icon" hint="Shown on the card and in the collapsed sidebar. The dashed first choice uses the category's icon.">
                  <IconPicker
                    value={form.icon}
                    onChange={(icon) => setForm({ ...form, icon })}
                    inherit={formIcon(categories.find((c) => c.id === form.categoryId)?.icon ?? "folder")}
                  />
                </Field>
                <Field label="Tag" hint="Optional. Shown on the card, e.g. “New” or “Password required”.">
                  <Input value={form.badge} onChange={(e) => setForm({ ...form, badge: e.target.value })} maxLength={30} className="max-w-[220px]" />
                </Field>
                <Field
                  label="Who can see it"
                  hint={form.roles.length
                    ? "Only these roles see the form, in the sidebar, on the Forms screen and in search. Admins always see every form."
                    : "Everyone. Tick roles to limit it to just those; Admins always see every form."}
                >
                  <CheckboxList
                    options={limitable.map((r) => ({ value: r.key, label: r.name }))}
                    value={form.roles}
                    onChange={(roles) => setForm({ ...form, roles })}
                  />
                </Field>
                <label className="flex items-center gap-3 pt-1 text-[13.5px] text-ink">
                  <Switch checked={form.active} onCheckedChange={(active) => setForm({ ...form, active })} />
                  Visible to staff
                </label>
              </DialogBody>
              <DialogFooter>
                <Button type="button" variant="secondary" onClick={() => setForm(null)}>Cancel</Button>
                <Button type="submit" disabled={busy || !form.title.trim() || !form.url.trim() || !form.categoryId}>
                  {form.id ? "Save" : "Add form"}
                </Button>
              </DialogFooter>
            </form>
          )}
        </DialogContent>
      </Dialog>

      {/* ── Category editor ─────────────────────────────────────── */}
      <Dialog open={category !== null} onOpenChange={(o) => !o && setCategory(null)}>
        <DialogContent className="w-[min(460px,calc(100vw-2rem))]">
          <DialogHeader title={category?.id ? "Edit category" : "Add a category"} />
          {category && (
            <form onSubmit={(e) => { e.preventDefault(); void saveCategory(); }}>
              <DialogBody className="space-y-4">
                <Field label="Name">
                  <Input value={category.name} onChange={(e) => setCategory({ ...category, name: e.target.value })} maxLength={80} required autoFocus />
                </Field>
                <Field label="Icon">
                  <IconPicker value={category.icon} onChange={(icon) => icon && setCategory({ ...category, icon })} />
                </Field>
              </DialogBody>
              <DialogFooter>
                <Button type="button" variant="secondary" onClick={() => setCategory(null)}>Cancel</Button>
                <Button type="submit" disabled={busy || !category.name.trim()}>{category.id ? "Save" : "Add category"}</Button>
              </DialogFooter>
            </form>
          )}
        </DialogContent>
      </Dialog>

      {/* ── Delete confirmation ─────────────────────────────────── */}
      <Dialog open={pending !== null} onOpenChange={(o) => !o && setPending(null)}>
        <DialogContent className="w-[min(440px,calc(100vw-2rem))]">
          <DialogHeader
            title={pending?.kind === "form" ? `Delete “${pending.form.title}”?` : pending ? `Delete “${pending.category.name}”?` : ""}
            subtitle={
              pending?.kind === "form"
                ? "It disappears from everyone's Forms screen, favorites included. To take it down for now, hide it instead."
                : "The category is empty, so nothing else changes."
            }
          />
          <DialogFooter>
            <Button variant="secondary" onClick={() => setPending(null)}>Cancel</Button>
            <Button variant="danger" onClick={() => void confirmDelete()} disabled={busy}>Delete</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </Page>
  );
}

/**
 * A validation failure's own words ("Use a full https:// link…") rather than
 * the generic "Validation failed" the API puts on top of them.
 */
function messageOf(e: unknown): string {
  if (e instanceof ApiError) {
    const d = e.details as { formErrors?: string[]; fieldErrors?: Record<string, string[] | undefined> } | undefined;
    const first = d?.formErrors?.[0] ?? Object.values(d?.fieldErrors ?? {}).flat()[0];
    if (first) return first;
  }
  return errorMessage(e, "Could not save.");
}

function IconButton({ label, onClick, disabled, children }: { label: string; onClick: () => void; disabled?: boolean; children: React.ReactNode }) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      title={label}
      aria-label={label}
      className="flex h-9 w-9 shrink-0 items-center justify-center rounded-input text-muted hover:bg-rowhover hover:text-ink disabled:pointer-events-none disabled:opacity-35"
    >
      {children}
    </button>
  );
}

