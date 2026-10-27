import { useState } from "react";
import { Link } from "react-router-dom";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { ArrowDown, ArrowUp, ExternalLink, EyeOff, Lock, Pencil, Plus, Trash2, UsersRound } from "lucide-react";
import { Page, PageHeader } from "@/components/shell/AppShell";
import { Tag } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { CheckboxList } from "@/components/ui/checkbox";
import { Dialog, DialogBody, DialogContent, DialogFooter, DialogHeader } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Field } from "@/components/ui/label";
import { EmptyState, LoadingState } from "@/components/ui/misc";
import { Select } from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { useToast } from "@/components/ui/toast";
import { ApiError, api } from "@/lib/api";
import { useJobTitles, useStaffGroups } from "@/lib/groups";
import { GroupChecklist, PeoplePicker, PositionsDropdown, Segmented } from "@/components/AccessPickers";
import { IconPicker } from "@/components/IconPicker";
import { formIcon, isInternalForm, type FormIconKey } from "@/lib/formIcons";
import { formsApi, useBuiltFormOptions, useForms, useRoles, useUsers, type BuiltFormOption } from "@/lib/queries";
import type { FormCategory, FormLink } from "@/lib/types";
import { cn, errorMessage } from "@/lib/utils";

type FormDraft = {
  id?: string;
  /** "built": opens a form made in Form builder / Code forms; "link": any URL or app path. */
  source: "built" | "link";
  /** What's typed under "A link", kept while "A form built here" is picked so switching back doesn't lose it. */
  link: string;
  /** Everyone, or only the groups, positions, people and roles picked below. */
  limited: boolean;
  categoryId: string;
  title: string;
  description: string;
  url: string;
  keywords: string;
  badge: string;
  /** Null = the category's icon. */
  icon: FormIconKey | null;
  active: boolean;
  /** Role keys that may see it; empty = every role. */
  roles: string[];
  /** Who it's open to: staff groups, positions (job titles) and named people. All empty = everyone. */
  groupIds: string[];
  titles: string[];
  userIds: string[];
};
/** Where a new link starts, and what an emptied one goes back to. */
const LINK_DOMAIN = "https://forms.lanterncommunity.org/";

type CategoryDraft = {
  id?: string;
  name: string;
  icon: FormIconKey;
  description: string;
  /** Everyone, or only these groups and positions (and anyone named before, kept as is). */
  limited: boolean;
  groupIds: string[];
  titles: string[];
  userIds: string[];
};
type Pending = { kind: "form"; form: FormLink } | { kind: "category"; category: FormCategory };

/**
 * What staff see on the Forms screen. Every change is live for everyone as
 * soon as it saves, and each one lands in the Activity log.
 */
export function AdminFormsCatalog() {
  const { data, isLoading } = useForms(true);
  const { data: allRoles } = useRoles();
  const { data: built } = useBuiltFormOptions();
  const { data: groups } = useStaffGroups();
  const { data: people } = useUsers();
  const { data: jobTitles } = useJobTitles();
  const groupName = (id: string) => groups?.find((g) => g.id === id)?.name ?? "A deleted group";
  const audienceLabel = (a: FormLink["audience"]) =>
    a && (a.groupIds.length || a.userIds.length || a.titles?.length)
      ? [
          ...a.groupIds.map(groupName),
          ...(a.titles ?? []),
          ...(a.userIds.length ? [`${a.userIds.length} ${a.userIds.length === 1 ? "person" : "people"}`] : []),
        ].join(", ")
      : null;
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
    const url = form.source === "built" ? form.url : form.link.trim();
    const limited = form.limited;
    const body = {
      categoryId: form.categoryId,
      title: form.title,
      description: form.description,
      url,
      keywords: form.keywords,
      badge: form.badge,
      icon: form.icon,
      active: form.active,
      roles: limited ? form.roles : [],
    };
    const ok = await run(async () => {
      const saved = (await (form.id ? formsApi.update(form.id, body) : formsApi.create(body))) as { id: string };
      // Who it's open to is saved on its own (on the form it opens, when it's built here).
      await api.put(
        `/forms/${form.id ?? saved.id}/audience`,
        limited ? { groupIds: form.groupIds, titles: form.titles, userIds: form.userIds } : { groupIds: [], titles: [], userIds: [] }
      );
    }, form.id ? "Form saved." : "Form added.");
    if (ok) setForm(null);
  }

  async function saveCategory() {
    if (!category) return;
    const body = { name: category.name, icon: category.icon, description: category.description.trim() };
    const ok = await run(async () => {
      const saved = (await (category.id ? formsApi.updateCategory(category.id, body) : formsApi.createCategory(body))) as { id: string };
      await api.put(
        `/forms/categories/${category.id ?? saved.id}/audience`,
        category.limited ? { groupIds: category.groupIds, titles: category.titles, userIds: category.userIds } : { groupIds: [], titles: [], userIds: [] }
      );
    }, category.id ? "Category saved." : "Category added.");
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
    setForm({
      source: "link", link: LINK_DOMAIN, limited: false, categoryId, title: "", description: "", url: "", keywords: "", badge: "", icon: null, active: true,
      roles: [], groupIds: [], titles: [], userIds: [],
    });

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
    if (!b) return "Made in Form builder or Code forms. The card stays tied to it.";
    if (!b.live) return "Not published yet: staff who click it are told it isn't available.";
    return `Opens ${b.url}.`;
  }

  if (isLoading) return <LoadingState />;

  return (
    <Page className="max-w-[960px]">
      <PageHeader
        title="Forms catalog"
        subtitle="What staff see on the Forms screen. Changes are live for everyone as soon as they save."
        actions={
          <>
            <Button variant="secondary" onClick={() => setCategory({ name: "", icon: "folder", description: "", limited: false, groupIds: [], titles: [], userIds: [] })}>
              <Plus className="h-4 w-4" /> Category
            </Button>
            <Button onClick={() => newForm(categories[0]?.id ?? "")} disabled={categories.length === 0}>
              <Plus className="h-4 w-4" /> Add form
            </Button>
          </>
        }
      />

      <EntryAccessNotice />

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
                {audienceLabel(cat.audience) && (
                  <Tag tone="accent" title={`Only ${audienceLabel(cat.audience)} (and Admins) see this category and its forms`} className="max-w-[45%] truncate">
                    <UsersRound className="h-3 w-3 shrink-0" /> <span className="truncate">Only {audienceLabel(cat.audience)}</span>
                  </Tag>
                )}
                <IconButton label="Move category up" disabled={busy || ci === 0} onClick={() => moveCategory(ci, -1)}><ArrowUp className="h-4 w-4" /></IconButton>
                <IconButton label="Move category down" disabled={busy || ci === categories.length - 1} onClick={() => moveCategory(ci, 1)}><ArrowDown className="h-4 w-4" /></IconButton>
                <IconButton
                  label="Edit category"
                  onClick={() =>
                    setCategory({
                      id: cat.id,
                      name: cat.name,
                      icon: cat.icon || "folder",
                      description: cat.description ?? "",
                      limited: Boolean(audienceLabel(cat.audience)),
                      groupIds: cat.audience?.groupIds ?? [],
                      titles: cat.audience?.titles ?? [],
                      userIds: cat.audience?.userIds ?? [],
                    })
                  }
                >
                  <Pencil className="h-4 w-4" />
                </IconButton>
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
                        {audienceLabel(f.audience) && (
                          <Tag tone="accent" title={`Only ${audienceLabel(f.audience)} (and Admins) can see this form`}>
                            <UsersRound className="h-3 w-3" /> {audienceLabel(f.audience)}
                          </Tag>
                        )}
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
                          link: builtByUrl.has(f.url) ? LINK_DOMAIN : f.url,
                          limited: Boolean(f.roles.length || f.audience?.groupIds.length || f.audience?.titles?.length || f.audience?.userIds.length),
                          categoryId: f.categoryId,
                          title: f.title,
                          description: f.description ?? "",
                          url: f.url,
                          keywords: f.keywords ?? "",
                          badge: f.badge ?? "",
                          icon: f.icon || null,
                          active: f.active,
                          roles: f.roles,
                          groupIds: f.audience?.groupIds ?? [],
                          titles: f.audience?.titles ?? [],
                          userIds: f.audience?.userIds ?? [],
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
        <DialogContent className="w-[min(940px,calc(100vw-2rem))]">
          <DialogHeader title={form?.id ? "Edit form" : "Add a form"} subtitle="A form built here, a form on WordPress, or any screen in this app." />
          {form && (
            <form onSubmit={(e) => { e.preventDefault(); void saveForm(); }}>
              <DialogBody className="grid max-h-[72vh] gap-x-8 gap-y-6 overflow-y-auto scroll-thin lg:grid-cols-[minmax(0,1fr)_minmax(0,1fr)]">
                {/* Left: what it is and how its card looks */}
                <div className="space-y-6">
                  <FormSection title="The form">
                    <Field label="Title">
                      <Input value={form.title} onChange={(e) => setForm({ ...form, title: e.target.value })} maxLength={120} required autoFocus />
                    </Field>
                    <Field label="Opens">
                      <Segmented
                        value={form.source}
                        options={[["built", "A form built here"], ["link", "A link"]]}
                        onChange={(source) => setForm(source === "link" ? { ...form, source } : { ...form, source, url: builtByUrl.has(form.url) ? form.url : "" })}
                      />
                    </Field>
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
                      <Field label="Link" hint="Add the page after the domain, or paste any address. An app path such as /roster works too.">
                        <Input
                          value={form.link}
                          onChange={(e) => setForm({ ...form, link: e.target.value })}
                          onBlur={() => !form.link.trim() && setForm({ ...form, link: LINK_DOMAIN })}
                          maxLength={2000}
                          required
                          inputMode="url"
                        />
                      </Field>
                    )}
                    <Field label="Category">
                      <Select value={form.categoryId} onChange={(e) => setForm({ ...form, categoryId: e.target.value })} options={categories.map((c) => ({ value: c.id, label: c.name }))} />
                    </Field>
                  </FormSection>

                  <FormSection title="On the card">
                    <Field label="Description" hint="One short line under the title.">
                      <Input value={form.description} onChange={(e) => setForm({ ...form, description: e.target.value })} maxLength={300} />
                    </Field>
                    <div className="grid gap-4 sm:grid-cols-[minmax(0,1fr)_170px]">
                      <Field label="Search words" hint="Comma-separated, e.g. an old name.">
                        <Input value={form.keywords} onChange={(e) => setForm({ ...form, keywords: e.target.value })} maxLength={255} />
                      </Field>
                      <Field label="Tag" hint="e.g. “New”.">
                        <Input value={form.badge} onChange={(e) => setForm({ ...form, badge: e.target.value })} maxLength={30} />
                      </Field>
                    </div>
                    <IconField
                      value={form.icon}
                      onChange={(icon) => setForm({ ...form, icon })}
                      inherit={formIcon(categories.find((c) => c.id === form.categoryId)?.icon ?? "folder")}
                    />
                  </FormSection>
                </div>

                {/* Right: who sees it */}
                <div className="space-y-6 lg:border-l lg:border-hairline lg:pl-8">
                  <FormSection title="Who can see it">
                    {(() => {
                      const cat = categories.find((c) => c.id === form.categoryId);
                      const limit = audienceLabel(cat?.audience);
                      return (
                        <>
                          {limit && (
                            <p className="rounded-input bg-navsel px-3 py-2 text-[12.5px] leading-snug text-ink">
                              <span className="font-semibold">{cat!.name}</span> is only for {limit}, so this form is too. Below, you can narrow it further.
                            </p>
                          )}
                          <Segmented
                            value={form.limited ? "limited" : "everyone"}
                            options={[["everyone", limit ? `Everyone who can see ${cat!.name}` : "Everyone"], ["limited", "Only some people"]]}
                            onChange={(v) => setForm({ ...form, limited: v === "limited" })}
                          />
                          <p className="text-[12.5px] leading-snug text-muted">
                            {form.limited
                              ? `Only the groups, positions and people you pick see it, open it or read its entries${limit ? `, and they also need to be able to see ${cat!.name}` : ""}. Roles narrow it further. Admins always see every form.`
                              : limit
                                ? `Everyone who can see ${cat!.name}. Admins always see every form.`
                                : "Every staff member can see and open it. Admins always see every form."}
                          </p>
                        </>
                      );
                    })()}
                    {form.limited && (
                      <>
                        <Field label="Groups">
                          {groups?.length ? (
                            <GroupChecklist groups={groups} titles={jobTitles ?? []} value={form.groupIds} onChange={(groupIds) => setForm({ ...form, groupIds })} />
                          ) : (
                            <p className="rounded-input bg-subtle px-3 py-2 text-[12.5px] text-muted">No groups yet. Add them in People &amp; roles → Groups.</p>
                          )}
                        </Field>
                        <Field label="Positions">
                          <PositionsDropdown groups={groups ?? []} titles={jobTitles ?? []} value={form.titles} onChange={(titles) => setForm({ ...form, titles })} />
                        </Field>
                        <Field label="People">
                          <PeoplePicker people={people ?? []} value={form.userIds} onChange={(userIds) => setForm({ ...form, userIds })} />
                        </Field>
                        <Field label="Roles" hint={form.roles.length ? "And only these roles." : "Optional, e.g. only Site Managers."}>
                          <CheckboxList options={limitable.map((r) => ({ value: r.key, label: r.name }))} value={form.roles} onChange={(roles) => setForm({ ...form, roles })} />
                        </Field>
                      </>
                    )}
                  </FormSection>
                </div>
              </DialogBody>
              <DialogFooter>
                <label className="mr-auto flex items-center gap-2.5 text-[13.5px] text-ink">
                  <Switch checked={form.active} onCheckedChange={(active) => setForm({ ...form, active })} />
                  Visible to staff
                </label>
                <Button type="button" variant="secondary" onClick={() => setForm(null)}>Cancel</Button>
                <Button
                  type="submit"
                  disabled={busy || !form.title.trim() || !(form.source === "built" ? form.url : form.link.trim()) || !form.categoryId}
                >
                  {form.id ? "Save" : "Add form"}
                </Button>
              </DialogFooter>
            </form>
          )}
        </DialogContent>
      </Dialog>

      {/* ── Category editor ─────────────────────────────────────── */}
      <Dialog open={category !== null} onOpenChange={(o) => !o && setCategory(null)}>
        <DialogContent className="w-[min(640px,calc(100vw-2rem))]">
          <DialogHeader title={category?.id ? "Edit category" : "Add a category"} />
          {category && (
            <form onSubmit={(e) => { e.preventDefault(); void saveCategory(); }}>
              <DialogBody className="max-h-[72vh] space-y-6 overflow-y-auto scroll-thin">
                <FormSection title="The category">
                  <Field label="Name">
                    <Input value={category.name} onChange={(e) => setCategory({ ...category, name: e.target.value })} maxLength={80} required autoFocus />
                  </Field>
                  <Field label="Description" hint="Optional. One line on the Forms page saying what kind of forms are in it.">
                    <Input value={category.description} onChange={(e) => setCategory({ ...category, description: e.target.value })} maxLength={200} placeholder="e.g. Meals, pantry and food distribution" />
                  </Field>
                  <IconField value={category.icon} onChange={(icon) => icon && setCategory({ ...category, icon })} inherit={formIcon(category.icon)} canInherit={false} />
                </FormSection>
                <FormSection title="Who can see it">
                  <Segmented
                    value={category.limited ? "limited" : "everyone"}
                    options={[["everyone", "Everyone"], ["limited", "Only some groups and positions"]]}
                    onChange={(v) => setCategory({ ...category, limited: v === "limited" })}
                  />
                  <p className="text-[12.5px] leading-snug text-muted">
                    {category.limited
                      ? "Only the groups and positions you pick see this category and open the forms in it. Each form's own limit still applies on top. Admins always see everything."
                      : "Everyone sees this category. Each form can still be limited on its own."}
                  </p>
                  {category.limited && (
                    <>
                      <Field label="Groups">
                        {groups?.length ? (
                          <GroupChecklist groups={groups} titles={jobTitles ?? []} value={category.groupIds} onChange={(groupIds) => setCategory({ ...category, groupIds })} />
                        ) : (
                          <p className="rounded-input bg-subtle px-3 py-2 text-[12.5px] text-muted">No groups yet. Add them in People &amp; roles → Groups.</p>
                        )}
                      </Field>
                      <Field label="Positions">
                        <PositionsDropdown groups={groups ?? []} titles={jobTitles ?? []} value={category.titles} onChange={(titles) => setCategory({ ...category, titles })} />
                      </Field>
                    </>
                  )}
                </FormSection>
              </DialogBody>
              <DialogFooter>
                <Button type="button" variant="secondary" onClick={() => setCategory(null)}>Cancel</Button>
                <Button
                  type="submit"
                  disabled={busy || !category.name.trim() || (category.limited && !category.groupIds.length && !category.titles.length && !category.userIds.length)}
                  title={category.limited && !category.groupIds.length && !category.titles.length && !category.userIds.length ? "Pick at least one group or position" : undefined}
                >
                  {category.id ? "Save" : "Add category"}
                </Button>
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

/** A titled block of the form editor. */
function FormSection({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="space-y-4">
      <h3 className="kicker">{title}</h3>
      {children}
    </section>
  );
}


/** The card's icon, with the full picker tucked away until asked for. */
function IconField({ value, onChange, inherit: Inherit, canInherit = true }: {
  value: FormIconKey | null;
  onChange: (icon: FormIconKey | null) => void;
  inherit: React.ElementType;
  /** False for a category, which always has its own icon. */
  canInherit?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const Current = value ? formIcon(value) : Inherit;
  return (
    <Field label="Icon">
      <div className="flex items-center gap-3">
        <span className="flex h-10 w-10 items-center justify-center rounded-[9px] bg-navsel text-accent dark:text-white">
          <Current className="h-5 w-5" />
        </span>
        <span className="min-w-0 flex-1 text-[13px] text-muted">{!canInherit ? "Shown on the Forms page" : value ? "Its own icon" : "The category's icon"}</span>
        {value && canInherit && (
          <Button type="button" size="sm" variant="ghost" onClick={() => onChange(null)}>
            Use the category's
          </Button>
        )}
        <Button type="button" size="sm" variant="secondary" onClick={() => setOpen(!open)} aria-expanded={open}>
          {open ? "Done" : "Change"}
        </Button>
      </div>
      {open && (
        <div className="mt-3">
          <IconPicker value={value} onChange={(icon) => onChange(icon as FormIconKey | null)} inherit={canInherit ? Inherit : undefined} />
        </div>
      )}
    </Field>
  );
}

/** Forms still on their old entry readers (before "Who sees entries"), each with a link to review it in its editor. */
function EntryAccessNotice() {
  const { data } = useQuery({
    queryKey: ["forms", "entry-access-review"],
    queryFn: () => api.get<{ forms: { id: string; title: string; kind: string; reviewed: boolean; legacyReaders: string[] }[] }>("/forms/entry-access"),
  });
  const { data: allRoles } = useRoles();
  const old = (data?.forms ?? []).filter((f) => !f.reviewed);
  if (!old.length) return null;
  const roleName = (k: string) => allRoles?.find((r) => r.key === k)?.name ?? k;
  // A form may name a role the site doesn't have (an old "site_admin"): it reaches nobody, so it isn't shown.
  const known = (keys: string[]) => keys.filter((k) => allRoles?.some((r) => r.key === k));
  return (
    <Card className="mb-4 border-status-amberText/40 p-4">
      <p className="text-[14px] font-semibold text-ink">
        {old.length} form{old.length === 1 ? " still uses its" : "s still use their"} old rule for who sees entries
      </p>
      <p className="mt-0.5 text-[12.5px] text-muted">The roles listed see every entry; everyone else sees only their own. Review each in its editor, under Who sees entries.</p>
      <ul className="mt-2 divide-y divide-hairline">
        {old.map((f) => (
          <li key={f.id} className="flex flex-wrap items-center gap-x-3 gap-y-1 py-1.5">
            <span className="min-w-0 flex-1 truncate text-[13px] font-semibold text-ink">{f.title}</span>
            <span className="text-[12px] text-muted">{known(f.legacyReaders).map(roleName).join(", ") || "Only Admins"} see every entry</span>
            <Link to={f.kind === "code" ? `/admin/apps/${f.id}` : `/admin/builder/${f.id}`} className="text-[12.5px] font-semibold text-accent dark:text-white">Review</Link>
          </li>
        ))}
      </ul>
    </Card>
  );
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




