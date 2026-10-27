import { useEffect, useState } from "react";
import { Link, useNavigate, useParams, useSearchParams } from "react-router-dom";
import { useQueryClient } from "@tanstack/react-query";
import { PencilRuler } from "lucide-react";
import { DesktopBackLink, Page, PageHeader } from "@/components/shell/AppShell";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { CheckboxList } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Field } from "@/components/ui/label";
import { EmptyState, LoadingState } from "@/components/ui/misc";
import { Select } from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { useToast } from "@/components/ui/toast";
import { api } from "@/lib/api";
import { useDeviceKind } from "@/lib/device";
import { useJobTitles, useStaffGroups } from "@/lib/groups";
import { GroupChecklist, PeoplePicker, PositionsDropdown, Segmented } from "@/components/AccessPickers";
import { formIcon, type FormIconKey } from "@/lib/formIcons";
import { formsApi, useBuiltFormOptions, useForms, useRoles, useUsers, type BuiltFormOption } from "@/lib/queries";
import type { FormLink } from "@/lib/types";
import { FormSection, IconField, LINK_DOMAIN, messageOf } from "./catalogParts";

type CardDraft = {
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

/** Where the form a card opens is edited: Form builder or Code forms. */
export function builtEditorPath(b: Pick<BuiltFormOption, "id" | "kind">, tab = "settings") {
  return b.kind === "code" ? `/admin/apps/${b.id}?panel=${tab}` : `/admin/builder/${b.id}?tab=${tab}`;
}

const draftOf = (f: FormLink, built: boolean): CardDraft => ({
  id: f.id,
  source: built ? "built" : "link",
  link: built ? LINK_DOMAIN : f.url,
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
});

/**
 * Forms catalog → a card, on its own page (/admin/forms/card/:id, or
 * /admin/forms/card/new?category=…): what it opens, how it looks on the Forms
 * screen and who can see it. A card for a form built here is usually edited
 * in that form's editor instead; this page still covers every card.
 */
export function CatalogCardPage() {
  const { id = "new" } = useParams();
  const [search] = useSearchParams();
  const navigate = useNavigate();
  const qc = useQueryClient();
  const toast = useToast();
  const desktop = useDeviceKind() === "desktop";
  const { data, isLoading } = useForms(true);
  const { data: allRoles } = useRoles();
  const { data: built } = useBuiltFormOptions();
  const { data: groups } = useStaffGroups();
  const { data: people } = useUsers();
  const { data: jobTitles } = useJobTitles();
  const [form, setForm] = useState<CardDraft | null>(null);
  const [busy, setBusy] = useState(false);
  const categories = data?.categories ?? [];
  const builtByUrl = new Map((built ?? []).map((b) => [b.url, b]));
  const existing = id === "new" ? null : categories.flatMap((c) => c.forms).find((f) => f.id === id) ?? null;
  const groupName = (gid: string) => groups?.find((g) => g.id === gid)?.name ?? "A deleted group";
  const audienceLabel = (a: FormLink["audience"]) =>
    a && (a.groupIds.length || a.userIds.length || a.titles?.length)
      ? [...a.groupIds.map(groupName), ...(a.titles ?? []), ...(a.userIds.length ? [`${a.userIds.length} ${a.userIds.length === 1 ? "person" : "people"}`] : [])].join(", ")
      : null;
  // Admins see every form regardless, so they aren't offered as a choice.
  const limitable = (allRoles ?? []).filter((r) => r.key !== "admin");

  // Start once the catalog (and, for an existing card, the built forms) are in.
  useEffect(() => {
    if (form || !data || (id !== "new" && !built)) return;
    if (id === "new") {
      const wanted = search.get("category");
      setForm({
        source: "link", link: LINK_DOMAIN, limited: false, categoryId: categories.find((c) => c.id === wanted)?.id ?? categories[0]?.id ?? "",
        title: "", description: "", url: "", keywords: "", badge: "", icon: null, active: true, roles: [], groupIds: [], titles: [], userIds: [],
      });
    } else if (existing) {
      setForm(draftOf(existing, builtByUrl.has(existing.url)));
    }
  }, [data, built, id]); // eslint-disable-line react-hooks/exhaustive-deps

  /** Fill a card from a built form: its address, title, icon, blurb and who can open it. */
  function pickBuilt(f: CardDraft, b: BuiltFormOption): CardDraft {
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

  function builtHint(url: string) {
    const b = builtByUrl.get(url);
    if (!b) return "Made in Form builder or Code forms. The card stays tied to it.";
    if (!b.live) return "Not published yet: staff who click it are told it isn't available.";
    return `Opens ${b.url}.`;
  }

  async function save() {
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
    setBusy(true);
    try {
      const saved = (await (form.id ? formsApi.update(form.id, body) : formsApi.create(body))) as { id: string };
      // Who it's open to is saved on its own (on the form it opens, when it's built here).
      await api.put(
        `/forms/${form.id ?? saved.id}/audience`,
        limited ? { groupIds: form.groupIds, titles: form.titles, userIds: form.userIds } : { groupIds: [], titles: [], userIds: [] }
      );
      await Promise.all([qc.invalidateQueries({ queryKey: ["forms"] }), qc.invalidateQueries({ queryKey: ["builder"] }), qc.invalidateQueries({ queryKey: ["apps"] })]);
      toast(form.id ? "Card saved." : "Form added.");
      navigate("/admin/forms");
    } catch (e) {
      toast(messageOf(e), "error");
    } finally {
      setBusy(false);
    }
  }

  if (isLoading || (!form && (id === "new" || existing))) return <LoadingState />;
  if (!form) {
    return (
      <Page className="max-w-[960px]">
        <DesktopBackLink to="/admin/forms">Forms catalog</DesktopBackLink>
        <Card><EmptyState title="That card isn't on the catalog any more." /></Card>
      </Page>
    );
  }
  if (!categories.length) {
    return (
      <Page className="max-w-[960px]">
        <DesktopBackLink to="/admin/forms">Forms catalog</DesktopBackLink>
        <Card><EmptyState title="No categories yet" hint="Add a category on the Forms catalog first, then put forms in it." /></Card>
      </Page>
    );
  }

  const opens = form.source === "built" ? builtByUrl.get(form.url) : undefined;
  const cat = categories.find((c) => c.id === form.categoryId);
  const limit = audienceLabel(cat?.audience);
  const canSave = !busy && form.title.trim() && (form.source === "built" ? form.url : form.link.trim()) && form.categoryId;

  return (
    <Page className="max-w-[1000px]">
      <DesktopBackLink to="/admin/forms">Forms catalog</DesktopBackLink>
      <PageHeader
        title={form.id ? form.title || "Edit card" : "Add a form"}
        subtitle="A card on the Forms screen: a form built here, a form on WordPress, or any screen in this app. Live for everyone as soon as it saves."
      />

      {opens && desktop && (
        <Card className="mb-4 flex flex-wrap items-center gap-3 p-4">
          <p className="min-w-0 flex-1 text-[13px] text-muted">
            This card opens <b className="text-ink">{opens.title}</b>, made in {opens.kind === "code" ? "Code forms" : "Form builder"}. Its questions, notifications and who sees entries are in its editor.
          </p>
          <Link to={builtEditorPath(opens)}><Button variant="secondary" size="sm"><PencilRuler className="h-4 w-4" /> Open its editor</Button></Link>
        </Card>
      )}

      <form id="catalog-card" onSubmit={(e) => { e.preventDefault(); void save(); }} className="grid gap-4 lg:grid-cols-2">
        <Card className="space-y-6 p-5">
          <FormSection title="The form">
            <Field label="Title">
              <Input value={form.title} onChange={(e) => setForm({ ...form, title: e.target.value })} maxLength={120} required autoFocus={!form.id} />
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
            <IconField value={form.icon} onChange={(icon) => setForm({ ...form, icon })} inherit={formIcon(cat?.icon ?? "folder")} />
          </FormSection>
        </Card>

        <Card className="space-y-6 p-5">
          <FormSection title="Who can see it">
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
        </Card>
      </form>

      <div className="sticky bottom-0 z-10 -mx-4 mt-5 flex flex-wrap items-center gap-2 border-t border-hairline bg-surface px-4 py-3 md:-mx-7 md:px-7">
        <label className="mr-auto flex items-center gap-2.5 text-[13.5px] text-ink">
          <Switch checked={form.active} onCheckedChange={(active) => setForm({ ...form, active })} />
          Visible to staff
        </label>
        <Button type="button" variant="secondary" onClick={() => navigate("/admin/forms")}>Cancel</Button>
        <Button type="submit" form="catalog-card" disabled={!canSave}>{form.id ? "Save" : "Add form"}</Button>
      </div>
    </Page>
  );
}
