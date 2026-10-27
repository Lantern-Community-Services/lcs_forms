import { useEffect, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Plus, Trash2 } from "lucide-react";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input, Textarea } from "@/components/ui/input";
import { Select } from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { CheckboxList } from "@/components/ui/checkbox";
import { CodeEditor } from "@/components/formkit/CodeEditor";
import { ConditionalEditor } from "./ConditionalEditor";
import { IconPicker } from "@/components/IconPicker";
import { useForms, useUsers } from "@/lib/queries";
import { builderApi, type Audience, type BuilderReference, type BuiltFormDetail } from "@/lib/builder";
import { useJobTitles, useStaffGroups, type StaffGroup } from "@/lib/groups";
import { GroupChecklist, PeoplePicker, PositionsDropdown, Segmented } from "@/components/AccessPickers";
import { useToast } from "@/components/ui/toast";
import { errorMessage } from "@/lib/utils";
import { EMAIL_FIELD_TYPES, type FormDoc, type FormSettings, type Notification } from "@/lib/formEngine";
import { cn } from "@/lib/utils";
import { CatalogCardFields } from "@/components/CatalogCardFields";
import { WhoSeesEntries } from "@/components/WhoSeesEntries";

export function Section({ title, hint, children }: { title: string; hint?: string; children: React.ReactNode }) {
  return (
    <Card className="p-5">
      <p className="font-heading text-[15px] font-extrabold text-ink">{title}</p>
      {hint && <p className="mt-0.5 text-[13px] text-muted">{hint}</p>}
      <div className="mt-4 space-y-4">{children}</div>
    </Card>
  );
}

export function Row({ label, hint, children }: { label: string; hint?: string; children: React.ReactNode }) {
  return (
    <div>
      <label className="mb-1 block text-[12px] font-semibold text-muted">{label}</label>
      {children}
      {hint && <p className="mt-1 text-micro text-muted">{hint}</p>}
    </div>
  );
}

export function Toggle({ label, hint, checked, onChange }: { label: string; hint?: string; checked: boolean; onChange: (v: boolean) => void }) {
  return (
    <label className="flex cursor-pointer items-start justify-between gap-4">
      <span>
        <span className="block text-[13.5px] font-semibold text-ink">{label}</span>
        {hint && <span className="block text-[12px] text-muted">{hint}</span>}
      </span>
      <Switch checked={checked} onCheckedChange={onChange} className="mt-0.5" />
    </label>
  );
}

/** ISO ⇄ the value a datetime-local input wants (local time). */
const toLocal = (iso?: string) => {
  if (!iso) return "";
  const d = new Date(iso);
  return new Date(d.getTime() - d.getTimezoneOffset() * 60000).toISOString().slice(0, 16);
};
const fromLocal = (v: string) => (v ? new Date(v).toISOString() : undefined);

export function SettingsPanel({
  doc,
  onChange,
  slug,
  onSlug,
  reference,
  form,
  onCatalog,
}: {
  doc: FormDoc;
  onChange: (d: FormDoc) => void;
  slug: string;
  onSlug: (s: string) => void;
  reference?: BuilderReference;
  form: BuiltFormDetail;
  onCatalog: (categoryId: string | null) => void;
}) {
  const s = doc.settings;
  const set = (patch: Partial<FormSettings>) => onChange({ ...doc, settings: clean({ ...s, ...patch }) });
  const roles = (reference?.roles ?? []).filter((r) => r.key !== "admin").map((r) => ({ value: r.key, label: r.name }));
  const { data: catalog } = useForms(true);
  const currentCategory = catalog?.categories.find((c) => c.forms.some((f) => f.id === form.catalogLinkId))?.id ?? "";
  const access = s.access?.mode ?? "signed_in";

  return (
    <div className="mx-auto max-w-[760px] space-y-4 p-4 md:p-6">
      <Section title="General">
        <Row label="Title"><Input value={doc.title} onChange={(e) => onChange({ ...doc, title: e.target.value })} /></Row>
        <Row label="Description (HTML)" hint="Shown above the form.">
          <CodeEditor language="html" value={doc.description ?? ""} onChange={(v) => onChange({ ...doc, description: v })} minHeight={70} />
        </Row>
        <Row label="URL name" hint={`The form opens at /${access === "public" ? "p" : "f"}/${slug}. Changing it breaks links people saved.`}>
          <Input value={slug} onChange={(e) => onSlug(e.target.value.toLowerCase().replace(/[^a-z0-9-]/g, "-"))} className="font-mono text-[13px]" />
        </Row>
        <Row label="Submit button"><Input value={s.submitLabel ?? ""} onChange={(e) => set({ submitLabel: e.target.value })} placeholder="Submit" className="max-w-xs" /></Row>
        <Row label="Icon" hint="On the Forms screen and in the sidebar.">
          <IconPicker value={s.icon ?? null} onChange={(icon) => set({ icon: icon ?? undefined })} />
        </Row>
        <Toggle label="Progress bar" hint="On forms with page breaks." checked={s.progressBar !== false} onChange={(v) => set({ progressBar: v ? undefined : false })} />
        <Toggle label="Keep unfinished answers" hint="Saved on the device, so a reload or a dropped connection doesn't lose them." checked={s.saveDrafts !== false} onChange={(v) => set({ saveDrafts: v ? undefined : false })} />
      </Section>

      <Section title="Who can fill it in">
        <div className="grid gap-2 sm:grid-cols-3">
          {([["signed_in", "Anyone signed in", "Every staff account."], ["roles", "Some roles", "Only the roles you pick."], ["public", "Public", "Anyone with the link, no sign-in."]] as const).map(([k, l, h]) => (
            <button key={k} onClick={() => set({ access: { mode: k, roles: k === "roles" ? s.access?.roles ?? [] : undefined } })} className={cn("rounded-card border p-3 text-left", access === k ? "border-navy bg-navsel" : "border-hairline hover:border-strongline")}>
              <p className="text-[13.5px] font-semibold text-ink">{l}</p>
              <p className="text-[12px] text-muted">{h}</p>
            </button>
          ))}
        </div>
        {access === "roles" && <CheckboxList options={roles} value={s.access?.roles ?? []} onChange={(v) => set({ access: { mode: "roles", roles: v } })} />}
        {access === "public" && <p className="rounded-input bg-status-amberBg px-3 py-2 text-[12.5px] text-status-amberText">Public forms can't use Site or Resident fields, and have spam protection (a hidden trap field and a rate limit).</p>}
        <Toggle label="Ask which site this is for" hint="Entries are then only visible to people assigned to that site." checked={Boolean(s.requireSite)} onChange={(v) => set({ requireSite: v || undefined })} />
      </Section>

      <FormsScreenAccess form={form} currentCategory={currentCategory} categories={catalog?.categories ?? []} onCatalog={onCatalog} />

      <Section title="Who sees entries" hint="Saved straight away, not with Publish. Admins always see every entry.">
        <WhoSeesEntries formId={form.id} />
      </Section>

      <Section title="Limits & schedule">
        <div className="grid gap-4 sm:grid-cols-2">
          <Row label="Most entries in total" hint="Empty = no limit."><Input type="number" min={1} value={s.limits?.maxEntries ?? ""} onChange={(e) => set({ limits: { ...s.limits, maxEntries: e.target.value ? Number(e.target.value) : undefined } })} /></Row>
          <Row label="Per person">
            <div className="flex gap-1.5">
              <Input type="number" min={1} placeholder="—" value={s.limits?.perUser?.count ?? ""} onChange={(e) => set({ limits: { ...s.limits, perUser: e.target.value ? { count: Number(e.target.value), period: s.limits?.perUser?.period ?? "day" } : undefined } })} className="w-20" />
              <Select value={s.limits?.perUser?.period ?? "day"} disabled={!s.limits?.perUser} onChange={(e) => s.limits?.perUser && set({ limits: { ...s.limits, perUser: { ...s.limits.perUser, period: e.target.value as "day" } } })} options={[{ value: "day", label: "a day" }, { value: "week", label: "a week" }, { value: "month", label: "a month" }, { value: "ever", label: "ever" }]} />
            </div>
          </Row>
          <Row label="Opens"><Input type="datetime-local" value={toLocal(s.limits?.opensAt)} onChange={(e) => set({ limits: { ...s.limits, opensAt: fromLocal(e.target.value) } })} /></Row>
          <Row label="Closes"><Input type="datetime-local" value={toLocal(s.limits?.closesAt)} onChange={(e) => set({ limits: { ...s.limits, closesAt: fromLocal(e.target.value) } })} /></Row>
        </div>
        <Row label="Message when closed or full"><Input value={s.limits?.closedMessage ?? ""} onChange={(e) => set({ limits: { ...s.limits, closedMessage: e.target.value || undefined } })} placeholder="This form isn't taking entries right now." /></Row>
      </Section>

      <Section title="After submitting">
        <div className="inline-flex rounded-input border border-hairline p-0.5">
          {(["message", "redirect"] as const).map((t) => (
            <button key={t} onClick={() => set({ confirmation: { ...s.confirmation, type: t } })} className={cn("rounded-[5px] px-3 py-1 text-[12.5px] font-semibold", (s.confirmation?.type ?? "message") === t ? "bg-navy text-white" : "text-muted")}>{t === "message" ? "Show a message" : "Go to a page"}</button>
          ))}
        </div>
        {(s.confirmation?.type ?? "message") === "message" ? (
          <>
            <Row label="Message (HTML)" hint="Merge tags: {field_id}, {user:name}, {entry:id}, {all_fields}.">
              <CodeEditor language="html" value={s.confirmation?.message ?? ""} onChange={(v) => set({ confirmation: { type: "message", ...s.confirmation, message: v } })} minHeight={80} />
            </Row>
            <Toggle label="Show their answers under the message" checked={Boolean(s.confirmation?.showSummary)} onChange={(v) => set({ confirmation: { type: "message", ...s.confirmation, showSummary: v || undefined } })} />
          </>
        ) : (
          <Row label="Page address" hint="Merge tags work, e.g. https://example.org/thanks?id={entry:id}"><Input value={s.confirmation?.url ?? ""} onChange={(e) => set({ confirmation: { type: "redirect", ...s.confirmation, url: e.target.value } })} /></Row>
        )}
      </Section>


      <Section title="Custom CSS" hint="Applies to this form only — write rules as if inside the form, e.g. .big { font-size: 20px } or label { color: navy }.">
        <CodeEditor language="css" value={s.customCss ?? ""} onChange={(v) => set({ customCss: v })} minHeight={120} />
      </Section>
    </div>
  );
}

/** Drop empty settings so the JSON stays tidy (and the strict schema is happy). */
const NOBODY: Audience = { groupIds: [], titles: [], userIds: [] };
const isSet = (a: Audience | undefined) => Boolean(a && (a.groupIds.length || a.titles.length || a.userIds.length));

/** "HR, Financial Analyst and 2 people", for a limit. */
function audienceWords(a: Audience, groups: StaffGroup[]) {
  const parts = [
    ...a.groupIds.map((id) => groups.find((g) => g.id === id)?.name ?? "a deleted group"),
    ...a.titles,
    ...(a.userIds.length ? [`${a.userIds.length} ${a.userIds.length === 1 ? "person" : "people"}`] : []),
  ];
  return parts.length <= 1 ? parts.join("") : `${parts.slice(0, -1).join(", ")} and ${parts[parts.length - 1]}`;
}

/**
 * The form's category on the Forms screen and who can see and open it. A
 * limited category limits its forms too (backend canUseBuiltForm), so it's
 * shown here as where the form starts from; the form's own groups, positions
 * and people can only narrow it. Saved straight away, not with Publish.
 */
function FormsScreenAccess({ form, currentCategory, categories, onCatalog }: {
  form: BuiltFormDetail;
  currentCategory: string;
  categories: { id: string; name: string }[];
  onCatalog: (categoryId: string | null) => void;
}) {
  const qc = useQueryClient();
  const toast = useToast();
  const key = ["builder", "audience", form.id];
  const { data } = useQuery({ queryKey: [...key, form.catalogLinkId], queryFn: () => builderApi.audience(form.id) });
  const { data: groups } = useStaffGroups();
  const { data: titles } = useJobTitles();
  const { data: people } = useUsers();
  const [draft, setDraft] = useState<Audience | null>(null);
  const [limited, setLimited] = useState(false);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    if (!data) return;
    setDraft(data.audience);
    setLimited(isSet(data.audience));
  }, [data]);

  const category = data?.category && data.category.id === currentCategory ? data.category : null;
  const categoryLimit = category && isSet(category.audience) ? audienceWords(category.audience, groups ?? []) : null;
  const wanted = limited ? draft ?? NOBODY : NOBODY;
  const changed = data ? JSON.stringify(wanted) !== JSON.stringify(data.audience) : false;

  async function save() {
    if (limited && !isSet(draft ?? undefined)) return toast("Pick at least one group, position or person, or choose Everyone.", "error");
    setBusy(true);
    try {
      await builderApi.setAudience(form.id, wanted);
      await Promise.all([qc.invalidateQueries({ queryKey: key }), qc.invalidateQueries({ queryKey: ["forms"] })]);
      toast(isSet(wanted) ? "Saved: only those people can see and open it." : "Saved: open to everyone who can see its category.");
    } catch (e) {
      toast(errorMessage(e, "Couldn't save who can see it."), "error");
    } finally {
      setBusy(false);
    }
  }

  return (
    <Section title="Forms screen and who can see it" hint="Saved straight away, not with Publish. Admins always see every form.">
      <Row label="Category" hint="Lists the form on the Forms screen and in the sidebar.">
        <Select
          value={currentCategory}
          onChange={(e) => onCatalog(e.target.value || null)}
          options={[{ value: "", label: "Not listed" }, ...categories.map((c) => ({ value: c.id, label: c.name }))]}
          className="max-w-sm"
        />
        {form.status === "draft" && currentCategory && <p className="mt-1 text-micro text-muted">The card stays hidden until the form is published.</p>}
      </Row>
      {form.catalogLinkId && currentCategory && <CatalogCardFields linkId={form.catalogLinkId} />}
      {categoryLimit && (
        <p className="rounded-input bg-navsel px-3 py-2 text-[12.5px] leading-snug text-ink">
          <span className="font-semibold">{category!.name}</span> is only for {categoryLimit}, so this form is too: nobody else sees it or can open it, even with a link.
          Change that on the category (Forms catalog). Below, you can narrow it further.
        </p>
      )}
      <Segmented
        value={limited ? "limited" : "everyone"}
        options={[["everyone", categoryLimit ? `Everyone who can see ${category!.name}` : "Everyone"], ["limited", "Only some groups, positions or people"]]}
        onChange={(v) => setLimited(v === "limited")}
      />
      {limited && draft && (
        <div className="space-y-4">
          <Row label="Groups">
            {groups?.length ? (
              <GroupChecklist groups={groups} titles={titles ?? []} value={draft.groupIds} onChange={(groupIds) => setDraft({ ...draft, groupIds })} />
            ) : (
              <p className="rounded-input bg-subtle px-3 py-2 text-[12.5px] text-muted">No groups yet. Add them in People &amp; roles → Groups.</p>
            )}
          </Row>
          <Row label="Positions">
            <PositionsDropdown groups={groups ?? []} titles={titles ?? []} value={draft.titles} onChange={(t) => setDraft({ ...draft, titles: t })} />
          </Row>
          <Row label="People">
            <PeoplePicker people={people ?? []} value={draft.userIds} onChange={(userIds) => setDraft({ ...draft, userIds })} />
          </Row>
          {categoryLimit && <p className="text-micro text-muted">They also need to be able to see {category!.name}.</p>}
        </div>
      )}
      <div className="flex justify-end">
        <Button size="sm" onClick={() => void save()} disabled={busy || !changed}>
          Save who can see it
        </Button>
      </div>
    </Section>
  );
}

function clean(s: FormSettings): FormSettings {
  const out = { ...s } as Record<string, unknown>;
  if (out.limits) {
    const l = Object.fromEntries(Object.entries(out.limits as object).filter(([, v]) => v !== undefined && v !== ""));
    out.limits = Object.keys(l).length ? l : undefined;
  }
  for (const k of Object.keys(out)) if (out[k] === undefined || out[k] === "") delete out[k];
  return out as FormSettings;
}

/**
 * The form's webhooks, on its Notifications tab: each new entry POSTed as JSON
 * to another system. Saved with the form (publish to apply). Who's told by
 * email and in the app is the form's routing, on the same tab.
 */
export function WebhooksSection({ doc, onChange }: { doc: FormDoc; onChange: (d: FormDoc) => void }) {
  const set = (patch: Partial<FormSettings>) => onChange({ ...doc, settings: clean({ ...doc.settings, ...patch }) });
  return <Notifications doc={doc} set={set} mailConfigured roles={[]} only="webhook" />;
}

function Notifications({ doc, set, mailConfigured, roles, only }: { doc: FormDoc; set: (p: Partial<FormSettings>) => void; mailConfigured: boolean; roles: { value: string; label: string }[]; only?: "webhook" }) {
  const { data: staffGroups } = useStaffGroups();
  const { data: jobTitles } = useJobTitles();
  const groupName = (id: string) => staffGroups?.find((g) => g.id === id)?.name ?? "a deleted group";
  const list = doc.settings.notifications ?? [];
  const [open, setOpen] = useState<string | null>(null);
  const update = (id: string, patch: Partial<Notification>) => set({ notifications: list.map((n) => (n.id === id ? cleanN({ ...n, ...patch }) : n)) });
  const add = (kind: Notification["kind"]) => {
    const id = `n${Date.now().toString(36)}`;
    const fresh: Record<Notification["kind"], Notification> = {
      notify: { id, name: "Notify in the app", enabled: true, kind, roles: [], siteOnly: true, subject: "New entry: {form:title}" },
      email: { id, name: "New email", enabled: true, kind, to: "", subject: "New entry: {form:title}" },
      webhook: { id, name: "New webhook", enabled: true, kind, url: "https://" },
    };
    set({ notifications: [...list, fresh[kind]] });
    setOpen(id);
  };
  const summary = (n: Notification) =>
    n.kind === "notify"
      ? `In the app to ${[...(n.roles ?? []).map((k) => roles.find((r) => r.value === k)?.label ?? k), ...(n.groups ?? []).map(groupName), ...(n.titles ?? []), ...(n.to?.trim() ? [n.to.trim()] : [])].join(", ") || "—"}${n.siteOnly && (n.roles?.length || n.groups?.length || n.titles?.length) ? " at the entry's site" : ""}${n.urgent ? " · urgent" : ""}`
      : n.kind === "email" ? `Email to ${n.to || "—"}` : `Webhook to ${n.url}`;
  return (
    <Section
      title={only ? "Webhooks" : "Notifications"}
      hint={only ? "Each new entry, sent as JSON to another system, optionally only when rules match. Saved with the form: publish to apply. The outcome is written on the entry's notes." : "Sent after each entry, optionally only when rules match. The outcome is written on the entry's notes."}
    >
      {!mailConfigured && !only && <p className="rounded-input bg-status-amberBg px-3 py-2 text-[12.5px] text-status-amberText">Email isn't set up on this server yet (MAIL_FROM), so emails are noted on the entry but not sent. Webhooks work.</p>}
      {list.filter((n) => !only || n.kind === only).map((n) => (
        <div key={n.id} className="rounded-card border border-hairline">
          <div className="flex items-center gap-2 px-3 py-2">
            <Switch checked={n.enabled} onCheckedChange={(v) => update(n.id, { enabled: v })} />
            <button onClick={() => setOpen(open === n.id ? null : n.id)} className="min-w-0 flex-1 text-left">
              <span className="block truncate text-[13.5px] font-semibold text-ink">{n.name}</span>
              <span className="block truncate text-micro text-muted">{summary(n)}{n.conditional ? " · with rules" : ""}</span>
            </button>
            <Button variant="ghost" size="icon" onClick={() => set({ notifications: list.filter((x) => x.id !== n.id) })} aria-label="Remove notification"><Trash2 className="h-4 w-4" /></Button>
          </div>
          {open === n.id && (
            <div className="space-y-3 border-t border-hairline p-3">
              <Row label="Name"><Input value={n.name} onChange={(e) => update(n.id, { name: e.target.value })} /></Row>
              {n.kind === "notify" ? (
                <>
                  <Row label="People with these roles" hint="Everyone who has one of them.">
                    <CheckboxList options={roles} value={n.roles ?? []} onChange={(v) => update(n.id, { roles: v })} />
                  </Row>
                  <Row label="Everyone in these groups" hint="Whoever is in the group when it's sent (People & roles → Groups).">
                    {staffGroups?.length ? (
                      <GroupChecklist groups={staffGroups} titles={jobTitles ?? []} value={n.groups ?? []} onChange={(v) => update(n.id, { groups: v.length ? v : undefined })} />
                    ) : (
                      <p className="text-micro text-muted">No groups yet.</p>
                    )}
                  </Row>
                  <Row label="Everyone with these positions" hint="Exact job titles.">
                    <PositionsDropdown groups={staffGroups ?? []} titles={jobTitles ?? []} value={n.titles ?? []} onChange={(v) => update(n.id, { titles: v.length ? v : undefined })} />
                  </Row>
                  <label className="flex items-start gap-2 text-[13px] text-ink">
                    <Switch checked={n.siteOnly ?? false} onCheckedChange={(v) => update(n.id, { siteOnly: v })} className="mt-0.5" />
                    <span>
                      Only those at the entry's site
                      <span className="block text-micro text-muted">For roles, groups and positions. People who work at every site (Admin, Main Office) always get it.</span>
                    </span>
                  </label>
                  <label className="flex items-start gap-2 text-[13px] text-ink">
                    <Switch checked={n.urgent ?? false} onCheckedChange={(v) => update(n.id, { urgent: v || undefined })} className="mt-0.5" />
                    <span>
                      Urgent
                      <span className="block text-micro text-muted">Red in their bell, kept at the top of their notifications until read, and emailed straight away. For what can't wait.</span>
                    </span>
                  </label>
                  <Row label="And these people" hint="Comma-separated addresses of people with an account. {user:email} is whoever filled it in.">
                    <Input value={n.to ?? ""} onChange={(e) => update(n.id, { to: e.target.value })} placeholder="{user:email}, someone@lanterncommunity.org" />
                  </Row>
                  <Row label="Title" hint="One line. {form:title}, {site:name}, {user:name} and {date:today} work; answers are left out, because it may be emailed.">
                    <Input value={n.subject ?? ""} onChange={(e) => update(n.id, { subject: e.target.value })} />
                  </Row>
                  <RuleEmailParts doc={doc} n={n} update={update} />
                  <Row label="Message (optional)" hint="Shown in the app only, so answers can go in: {field_id}, or {all_fields} for everything.">
                    <Textarea value={n.body ?? ""} onChange={(e) => update(n.id, { body: e.target.value || undefined })} rows={3} />
                  </Row>
                  <Row label="Opens (optional)" hint="A page of this site. Leave empty to open the entry. Merge tags work: /f/my-form/entries/{entry:id}.">
                    <Input value={n.link ?? ""} onChange={(e) => update(n.id, { link: e.target.value || undefined })} placeholder="The entry" />
                  </Row>
                  <p className="text-[12px] text-muted">
                    It appears under the bell for each person. Whether it's emailed too is their choice, on their Profile (new form entries are off by email unless they turn them on). An email is the title and a link, never the message.
                  </p>
                </>
              ) : n.kind === "email" ? (
                <>
                  <Row label="To" hint="Comma-separated. {email_field_id} sends to an address someone typed."><Input value={n.to ?? ""} onChange={(e) => update(n.id, { to: e.target.value })} /></Row>
                  <Row label="Subject" hint="{form:title}, {site:name}, {user:name} and {date:today} work here. Answers don't: they're left out.">
                    <Input value={n.subject ?? ""} onChange={(e) => update(n.id, { subject: e.target.value })} />
                  </Row>
                  <RuleEmailParts doc={doc} n={n} update={update} />
                </>
              ) : (
                <>
                  <Row label="URL" hint="Receives a POST of the entry as JSON."><Input value={n.url ?? ""} onChange={(e) => update(n.id, { url: e.target.value })} /></Row>
                  <Row label="Signing secret (optional)" hint="Sent as X-Lantern-Signature: sha256=HMAC(body)."><Input value={n.secret ?? ""} onChange={(e) => update(n.id, { secret: e.target.value })} className="font-mono text-[12.5px]" /></Row>
                </>
              )}
              <div>
                <p className="mb-1.5 text-[12px] font-semibold text-muted">Only send when…</p>
                <ConditionalEditor value={n.conditional} onChange={(c) => update(n.id, { conditional: c })} fields={doc.fields} noun="send this" />
              </div>
            </div>
          )}
        </div>
      ))}
      <div className="flex gap-2">
        {!only && <Button variant="secondary" size="sm" onClick={() => add("notify")}><Plus className="h-3.5 w-3.5" /> Notify in the app</Button>}
        {!only && <Button variant="secondary" size="sm" onClick={() => add("email")}><Plus className="h-3.5 w-3.5" /> Email</Button>}
        <Button variant="secondary" size="sm" onClick={() => add("webhook")}><Plus className="h-3.5 w-3.5" /> Webhook</Button>
      </div>
    </Section>
  );
}

/** The answers a rule's email may show: where, when, by whom, and this form's fields of the email-safe types. */
function ruleEmailFields(doc: FormDoc) {
  return [
    { value: "_site", label: "Site" },
    { value: "_date", label: "Submitted" },
    { value: "_by", label: "Submitted by" },
    ...doc.fields.filter((f) => EMAIL_FIELD_TYPES.includes(f.type)).map((f) => ({ value: f.id, label: f.label || f.id })),
  ];
}

/** A rule's "What to do" and "Answers in the email" (Lantern addresses only). */
function RuleEmailParts({ doc, n, update }: { doc: FormDoc; n: Notification; update: (id: string, patch: Partial<Notification>) => void }) {
  return (
    <>
      <Row label="What to do (optional)" hint="Shown at the top of the email, e.g. “Review and sign within 24 hours.” No answers or resident details.">
        <Textarea value={n.whatToDo ?? ""} onChange={(e) => update(n.id, { whatToDo: e.target.value || undefined })} rows={2} maxLength={500} />
      </Row>
      <Row label="Answers in the email" hint="Shown to Lantern addresses only; anyone else gets the email without them. Residents, names, contact details, signatures, files and paragraphs can't be chosen.">
        <CheckboxList options={ruleEmailFields(doc)} value={n.fields ?? []} onChange={(v) => update(n.id, { fields: v.length ? v : undefined })} />
      </Row>
    </>
  );
}

function cleanN(n: Notification): Notification {
  const out = { ...n } as Record<string, unknown>;
  for (const k of Object.keys(out)) if (out[k] === undefined) delete out[k];
  return out as unknown as Notification;
}

