import { useState } from "react";
import { Plus, Trash2 } from "lucide-react";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Select } from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { CheckboxList } from "@/components/ui/checkbox";
import { CodeEditor } from "@/components/formkit/CodeEditor";
import { ConditionalEditor } from "./ConditionalEditor";
import { IconPicker } from "@/components/IconPicker";
import { useForms } from "@/lib/queries";
import type { BuilderReference, BuiltFormDetail } from "@/lib/builder";
import type { FormDoc, FormSettings, Notification } from "@/lib/formEngine";
import { cn } from "@/lib/utils";

function Section({ title, hint, children }: { title: string; hint?: string; children: React.ReactNode }) {
  return (
    <Card className="p-5">
      <p className="font-heading text-[15px] font-extrabold text-ink">{title}</p>
      {hint && <p className="mt-0.5 text-[13px] text-muted">{hint}</p>}
      <div className="mt-4 space-y-4">{children}</div>
    </Card>
  );
}

function Row({ label, hint, children }: { label: string; hint?: string; children: React.ReactNode }) {
  return (
    <div>
      <label className="mb-1 block text-[12px] font-semibold text-muted">{label}</label>
      {children}
      {hint && <p className="mt-1 text-micro text-muted">{hint}</p>}
    </div>
  );
}

function Toggle({ label, hint, checked, onChange }: { label: string; hint?: string; checked: boolean; onChange: (v: boolean) => void }) {
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

      <Section title="Who can read entries" hint="Admins always can.">
        <CheckboxList options={roles} value={s.entriesRoles ?? ["main_office", "site_admin", "site_manager"]} onChange={(v) => set({ entriesRoles: v })} />
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

      <Notifications doc={doc} set={set} mailConfigured={reference?.mailConfigured ?? false} />

      <Section title="Forms screen" hint="List this form on the Forms screen and in the sidebar, under a category. Who sees the card follows “Who can fill it in”.">
        <Select value={currentCategory} onChange={(e) => onCatalog(e.target.value || null)} options={[{ value: "", label: "Not listed" }, ...(catalog?.categories ?? []).map((c) => ({ value: c.id, label: c.name }))]} className="max-w-sm" />
        {form.status === "draft" && currentCategory && <p className="text-micro text-muted">The card stays hidden until the form is published.</p>}
      </Section>

      <Section title="Custom CSS" hint="Applies to this form only — write rules as if inside the form, e.g. .big { font-size: 20px } or label { color: navy }.">
        <CodeEditor language="css" value={s.customCss ?? ""} onChange={(v) => set({ customCss: v })} minHeight={120} />
      </Section>
    </div>
  );
}

/** Drop empty settings so the JSON stays tidy (and the strict schema is happy). */
function clean(s: FormSettings): FormSettings {
  const out = { ...s } as Record<string, unknown>;
  if (out.limits) {
    const l = Object.fromEntries(Object.entries(out.limits as object).filter(([, v]) => v !== undefined && v !== ""));
    out.limits = Object.keys(l).length ? l : undefined;
  }
  for (const k of Object.keys(out)) if (out[k] === undefined || out[k] === "") delete out[k];
  return out as FormSettings;
}

function Notifications({ doc, set, mailConfigured }: { doc: FormDoc; set: (p: Partial<FormSettings>) => void; mailConfigured: boolean }) {
  const list = doc.settings.notifications ?? [];
  const [open, setOpen] = useState<string | null>(null);
  const update = (id: string, patch: Partial<Notification>) => set({ notifications: list.map((n) => (n.id === id ? cleanN({ ...n, ...patch }) : n)) });
  const add = (kind: "email" | "webhook") => {
    const id = `n${Date.now().toString(36)}`;
    set({ notifications: [...list, kind === "email" ? { id, name: "New email", enabled: true, kind, to: "", subject: "New entry: {form:title}", body: "<p>{all_fields}</p><p><a href=\"{entry:url}\">Open the entry</a></p>" } : { id, name: "New webhook", enabled: true, kind, url: "https://" }] });
    setOpen(id);
  };
  return (
    <Section title="Notifications" hint="Sent after each entry, optionally only when rules match. The outcome is written on the entry's notes.">
      {!mailConfigured && <p className="rounded-input bg-status-amberBg px-3 py-2 text-[12.5px] text-status-amberText">Email isn't set up on this server yet (MAIL_FROM), so emails are noted on the entry but not sent. Webhooks work.</p>}
      {list.map((n) => (
        <div key={n.id} className="rounded-card border border-hairline">
          <div className="flex items-center gap-2 px-3 py-2">
            <Switch checked={n.enabled} onCheckedChange={(v) => update(n.id, { enabled: v })} />
            <button onClick={() => setOpen(open === n.id ? null : n.id)} className="min-w-0 flex-1 text-left">
              <span className="block truncate text-[13.5px] font-semibold text-ink">{n.name}</span>
              <span className="block truncate text-micro text-muted">{n.kind === "email" ? `Email to ${n.to || "—"}` : `Webhook to ${n.url}`}{n.conditional ? " · with rules" : ""}</span>
            </button>
            <Button variant="ghost" size="icon" onClick={() => set({ notifications: list.filter((x) => x.id !== n.id) })} aria-label="Remove notification"><Trash2 className="h-4 w-4" /></Button>
          </div>
          {open === n.id && (
            <div className="space-y-3 border-t border-hairline p-3">
              <Row label="Name"><Input value={n.name} onChange={(e) => update(n.id, { name: e.target.value })} /></Row>
              {n.kind === "email" ? (
                <>
                  <Row label="To" hint="Comma-separated. {email_field_id} sends to an address someone typed."><Input value={n.to ?? ""} onChange={(e) => update(n.id, { to: e.target.value })} /></Row>
                  <Row label="Subject"><Input value={n.subject ?? ""} onChange={(e) => update(n.id, { subject: e.target.value })} /></Row>
                  <Row label="Body (HTML)" hint="{all_fields} lists every answer; {entry:url} links to the entry.">
                    <CodeEditor language="html" value={n.body ?? ""} onChange={(v) => update(n.id, { body: v })} minHeight={90} />
                  </Row>
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
        <Button variant="secondary" size="sm" onClick={() => add("email")}><Plus className="h-3.5 w-3.5" /> Email</Button>
        <Button variant="secondary" size="sm" onClick={() => add("webhook")}><Plus className="h-3.5 w-3.5" /> Webhook</Button>
      </div>
    </Section>
  );
}

function cleanN(n: Notification): Notification {
  const out = { ...n } as Record<string, unknown>;
  for (const k of Object.keys(out)) if (out[k] === undefined) delete out[k];
  return out as unknown as Notification;
}

