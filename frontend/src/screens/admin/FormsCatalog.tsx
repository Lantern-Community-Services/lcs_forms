import { useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { ArrowDown, ArrowUp, ExternalLink, EyeOff, Lock, Pencil, Plus, Trash2, UsersRound } from "lucide-react";
import { Page, PageHeader } from "@/components/shell/AppShell";
import { Tag } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Dialog, DialogBody, DialogContent, DialogFooter, DialogHeader } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Field } from "@/components/ui/label";
import { EmptyState, LoadingState } from "@/components/ui/misc";
import { Switch } from "@/components/ui/switch";
import { useToast } from "@/components/ui/toast";
import { api } from "@/lib/api";
import { useDeviceKind } from "@/lib/device";
import { useJobTitles, useStaffGroups } from "@/lib/groups";
import { GroupChecklist, PositionsDropdown, Segmented } from "@/components/AccessPickers";
import { formIcon, isInternalForm, type FormIconKey } from "@/lib/formIcons";
import { formsApi, useBuiltFormOptions, useForms, useRoles } from "@/lib/queries";
import type { FormCategory, FormLink } from "@/lib/types";
import { cn } from "@/lib/utils";
import { builtEditorPath } from "./CatalogCard";
import { FormSection, IconField, messageOf } from "./catalogParts";

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
  const roleNames = (keys: string[]) => keys.map((k) => allRoles?.find((r) => r.key === k)?.name ?? k).join(", ");
  const qc = useQueryClient();
  const toast = useToast();
  const navigate = useNavigate();
  const desktop = useDeviceKind() === "desktop";
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


  /** A form built here is edited in its own editor (on a computer); any other card on its own page. */
  function editCard(f: FormLink) {
    const b = builtByUrl.get(f.url);
    navigate(b && desktop ? builtEditorPath(b) : `/admin/forms/card/${f.id}`);
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
            <Button onClick={() => navigate("/admin/forms/card/new")} disabled={categories.length === 0}>
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
                    <IconButton label={builtByUrl.has(f.url) && desktop ? "Edit the form" : "Edit card"} onClick={() => editCard(f)}>
                      <Pencil className="h-4 w-4" />
                    </IconButton>
                    <IconButton label="Delete form" onClick={() => setPending({ kind: "form", form: f })}><Trash2 className="h-4 w-4" /></IconButton>
                  </li>
                ))}
                <li>
                  <button onClick={() => navigate(`/admin/forms/card/new?category=${cat.id}`)} className="flex min-h-[40px] w-full items-center gap-2 px-4 text-[13px] font-semibold text-accent hover:bg-rowhover dark:text-white">
                    <Plus className="h-4 w-4" /> Add a form to {cat.name}
                  </button>
                </li>
              </ul>
            </Card>
          );
        })}
      </div>

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




