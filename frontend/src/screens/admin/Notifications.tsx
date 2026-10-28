import { useEffect, useMemo, useRef, useState } from "react";
import { Link, NavLink, Outlet, useNavigate, useParams, useSearchParams } from "react-router-dom";
import { useInfiniteQuery, useQuery, useQueryClient } from "@tanstack/react-query";
import { Copy, Eye, EyeOff, Lock, Plus, RotateCcw, Trash2 } from "lucide-react";
import { lookApi, whiteContrast, type EmailLook } from "@/lib/emailTemplates";
import { DesktopBackLink, Page, PageHeader } from "@/components/shell/AppShell";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input, Textarea } from "@/components/ui/input";
import { Field } from "@/components/ui/label";
import { Select } from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { Tag } from "@/components/ui/badge";
import { CheckboxList } from "@/components/ui/checkbox";
import { EmptyState, LoadingState } from "@/components/ui/misc";
import { useToast } from "@/components/ui/toast";
import { api } from "@/lib/api";
import {
  listWords, templateKeys, templatesApi, useEmailTemplates,
  type EmailPreview, type EmailTemplate, type TemplateDraft, type TemplateKind, type TemplateUse,
} from "@/lib/emailTemplates";
import { cn, errorMessage, formatDateTime, relativeTime } from "@/lib/utils";
import { RoutingFormsList } from "./Routing";

/**
 * Admin → Notifications: everything about who's told and what the emails say,
 * in one place. Forms (each form's routes, follow-up and weekly reports: the
 * same editor as the form's own Notifications tab), the organization's email
 * Templates (Super Admins make and change them; Admins pick them on routes
 * and reports), and every email Sent.
 */

export function NotificationsLayout() {
  const tabs = [
    { to: "/admin/notifications", label: "Forms", end: true },
    { to: "/admin/notifications/templates", label: "Templates", end: false },
    { to: "/admin/notifications/system", label: "System emails", end: false },
    { to: "/admin/notifications/look", label: "Look", end: false },
    { to: "/admin/notifications/sent", label: "Sent emails", end: false },
  ];
  return (
    <Page className="max-w-[960px]">
      <PageHeader title="Notifications" subtitle="Who each form tells and when, what the emails say, and every email sent." help={{ article: "admin-notifications", text: "Every form's notifications in one place, the organization's email templates, the site's own emails, how emails look, and every email sent." }} />
      <nav className="-mx-1 mb-5 flex gap-1 overflow-x-auto border-b border-hairline px-1" aria-label="Notifications">
        {tabs.map((t) => (
          <NavLink
            key={t.to}
            to={t.to}
            end={t.end}
            className={({ isActive }) =>
              cn(
                "-mb-px flex min-h-[42px] shrink-0 items-center whitespace-nowrap border-b-2 px-3 text-[13.5px] font-semibold",
                isActive ? "border-navy text-accent dark:border-white dark:text-white" : "border-transparent text-muted hover:text-ink"
              )
            }
          >
            {t.label}
          </NavLink>
        ))}
      </nav>
      <Outlet />
    </Page>
  );
}

export function NotificationsFormsTab() {
  return <RoutingFormsList />;
}

// ── Templates ────────────────────────────────────────────────────────────

const usesLine = (uses: TemplateUse[]) => {
  const routes = uses.filter((u) => u.kind === "route").length;
  const reports = uses.filter((u) => u.kind === "report").length;
  const site = uses.filter((u) => u.kind === "site").length;
  const parts = [
    routes ? `${routes} route${routes === 1 ? "" : "s"}` : null,
    reports ? `${reports} report${reports === 1 ? "" : "s"}` : null,
    site ? "the site itself" : null,
  ].filter(Boolean) as string[];
  return parts.length ? `Used by ${listWords(parts)}` : "Not used yet";
};

export function NotificationsTemplatesTab() {
  const { data, isLoading } = useEmailTemplates();
  const navigate = useNavigate();
  if (isLoading || !data) return <LoadingState />;
  const groups: { kind: TemplateKind; title: string; hint: string }[] = [
    { kind: "message", title: "For routes and messages", hint: "A route picks one for its emails; the site's follow-up emails use theirs; code forms send with one by key." },
    { kind: "report", title: "For weekly reports", hint: "A weekly summary report picks one for its subject, heading and What to do." },
  ];
  return (
    <div className="space-y-6">
      <Card className="flex flex-wrap items-center gap-3 p-4 text-[13px] text-muted">
        <p className="min-w-0 flex-1">
          The organization's email wording. Each route and weekly report picks a template, or keeps its own wording. Changing a template changes every email that uses it.
          {data.canEdit ? " Presets ship with the site: change one and you can always put it back." : " Only Super Admins make or change templates."}
        </p>
        {data.canEdit ? (
          <Button onClick={() => navigate("/admin/notifications/templates/new")}><Plus className="h-4 w-4" /> New template</Button>
        ) : (
          <Tag tone="neutral"><Lock className="h-3 w-3" /> Super Admins only</Tag>
        )}
      </Card>
      {groups.map((g) => {
        const rows = data.templates.filter((t) => t.kind === g.kind);
        return (
          <section key={g.kind}>
            <div className="mb-2 px-1">
              <p className="font-heading text-[15px] font-extrabold text-ink">{g.title}</p>
              <p className="text-[12.5px] text-muted">{g.hint}</p>
            </div>
            <Card className="p-0">
              <ul className="divide-y divide-hairline">
                {rows.map((t) => (
                  <li key={t.id}>
                    <Link to={`/admin/notifications/templates/${t.key}`} className={cn("flex items-center gap-3 px-5 py-3 hover:bg-rowhover", t.hidden && "opacity-60")}>
                      <span className="min-w-0 flex-1">
                        <span className="flex flex-wrap items-center gap-2">
                          <span className="truncate text-[14px] font-semibold text-ink">{t.name}</span>
                          {t.preset && <Tag tone="accent">{t.changed ? "Preset, changed" : "Preset"}</Tag>}
                          {t.urgent && <Tag tone="red">Urgent</Tag>}
                          {t.hidden && <Tag tone="neutral"><EyeOff className="h-3 w-3" /> Hidden</Tag>}
                          {(t.key === data.defaults.message || t.key === data.defaults.report) && <Tag tone="neutral">New {t.kind === "report" ? "reports" : "routes"} start here</Tag>}
                        </span>
                        <span className="mt-0.5 block truncate text-[12.5px] text-muted">{t.description || t.subject || "No subject"}</span>
                        <span className="mt-0.5 block text-[12px] text-muted">
                          {usesLine(t.uses)} · <span className="font-mono">{t.key}</span>
                          {t.revision > 1 && t.updatedByName ? ` · changed ${relativeTime(t.updatedAt)} by ${t.updatedByName}` : ""}
                        </span>
                      </span>
                      <span className="text-[13px] font-semibold text-accent dark:text-white">{data.canEdit ? "Edit" : "View"}</span>
                    </Link>
                  </li>
                ))}
              </ul>
            </Card>
          </section>
        );
      })}
    </div>
  );
}

const EMPTY: TemplateDraft = { name: "", description: null, kind: "message", subject: null, heading: null, intro: null, whatToDo: null, details: [], buttonLabel: null, urgent: false };
const draftOf = (t: EmailTemplate): TemplateDraft => ({
  name: t.name, description: t.description, kind: t.kind, subject: t.subject, heading: t.heading, intro: t.intro, whatToDo: t.whatToDo, details: t.details, buttonLabel: t.buttonLabel, urgent: t.urgent,
});
type TextKey = "subject" | "heading" | "intro" | "whatToDo" | "buttonLabel";

/**
 * One template, on its own page: the wording on the left, the email it makes
 * on the right (made-up values, or a form's latest entry), and where it's used.
 * Read-only for anyone but Super Admins.
 */
export function TemplateEditorPage() {
  const { id = "new" } = useParams();
  const [search] = useSearchParams();
  const navigate = useNavigate();
  const qc = useQueryClient();
  const toast = useToast();
  const isNew = id === "new";
  const { data: all } = useEmailTemplates();
  const { data: saved, isLoading, error } = useQuery({ queryKey: templateKeys.one(id), queryFn: () => templatesApi.get(id), enabled: !isNew });
  const [draft, setDraft] = useState<TemplateDraft | null>(null);
  const [busy, setBusy] = useState(false);
  const focused = useRef<TextKey>("subject");

  useEffect(() => {
    if (isNew) setDraft({ ...EMPTY, kind: search.get("kind") === "report" ? "report" : "message" });
    else if (saved) setDraft(draftOf(saved));
  }, [isNew, saved?.id, saved?.revision]); // eslint-disable-line react-hooks/exhaustive-deps

  if (!isNew && error) return <Page><DesktopBackLink to="/admin/notifications/templates">Templates</DesktopBackLink><Card><EmptyState title={errorMessage(error, "Couldn't open this template.")} /></Card></Page>;
  if (!all || !draft || (!isNew && (isLoading || !saved))) return <LoadingState />;

  const canEdit = all.canEdit;
  const dirty = isNew ? Boolean(draft.name.trim()) : JSON.stringify(draft) !== JSON.stringify(draftOf(saved!));
  const set = (patch: Partial<TemplateDraft>) => setDraft({ ...draft, ...patch });
  const setText = (k: TextKey, v: string) => set({ [k]: v || null } as Partial<TemplateDraft>);
  const isSystem = draft.kind === "system";
  const tags = isSystem ? all.systemTags[saved?.key ?? ""] ?? [] : all.tags[draft.kind];
  const back = isSystem ? { to: "/admin/notifications/system", label: "System emails" } : { to: "/admin/notifications/templates", label: "Templates" };
  const isDefault = !isNew && (saved!.key === all.defaults.message || saved!.key === all.defaults.report);

  function insertTag(tag: string) {
    const k = focused.current;
    setText(k, `${draft![k] ?? ""}${tag}`);
  }

  async function run(fn: () => Promise<unknown>, done: string, after?: () => void) {
    setBusy(true);
    try {
      await fn();
      await qc.invalidateQueries({ queryKey: ["email"] });
      await qc.invalidateQueries({ queryKey: ["routing"] });
      toast(done);
      after?.();
    } catch (e) {
      toast(errorMessage(e, "Couldn't do that."), "error");
    } finally {
      setBusy(false);
    }
  }

  const save = () =>
    isNew
      ? run(async () => {
          const made = await templatesApi.create(draft!);
          navigate(`/admin/notifications/templates/${made.key}`, { replace: true });
        }, "Template made. Pick it on any route or report.")
      : run(() => templatesApi.update(saved!.id, draft!, saved!.revision), saved!.uses.length ? `Saved. ${usesLine(saved!.uses).replace("Used by", "It changes")} from now on.` : "Saved.");

  return (
    <Page className="max-w-[1180px]">
      <DesktopBackLink to={back.to}>{back.label}</DesktopBackLink>
      <PageHeader
        title={isNew ? "New template" : saved!.name}
        subtitle={isNew ? "Wording any route or weekly report can use." : `${isSystem ? (saved!.changed ? "One of the site's own emails, changed here" : "One of the site's own emails") : saved!.preset ? (saved!.changed ? "A preset, changed here" : "A preset") : `Made by ${saved!.createdByName ?? "someone"}`} · key ${saved!.key}${saved!.revision > 1 && saved!.updatedByName ? ` · changed ${relativeTime(saved!.updatedAt)} by ${saved!.updatedByName}` : ""}`}
        actions={
          canEdit ? (
            <div className="flex flex-wrap gap-2">
              {!isNew && !isSystem && <Button variant="secondary" disabled={busy} onClick={() => void run(async () => { const c = await templatesApi.copy(saved!.id); navigate(`/admin/notifications/templates/${c.key}`); }, "Copied. Change the copy as you like.")}><Copy className="h-4 w-4" /> Copy</Button>}
              <Button onClick={() => void save()} disabled={busy || !dirty || !draft.name.trim()}>{busy ? "Saving…" : isNew ? "Make it" : "Save"}</Button>
            </div>
          ) : (
            <Tag tone="neutral"><Lock className="h-3 w-3" /> Only Super Admins change templates</Tag>
          )
        }
      />

      <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_minmax(0,1fr)]">
        <div className="space-y-4">
          <Card className="space-y-4 p-5">
            <Field label="Name" hint="What people see when they pick it.">
              <Input value={draft.name} onChange={(e) => set({ name: e.target.value })} maxLength={120} disabled={!canEdit} autoFocus={isNew} aria-label="Name" />
            </Field>
            <Field label="When to use it" hint="One line, shown next to the name.">
              <Input value={draft.description ?? ""} onChange={(e) => set({ description: e.target.value || null })} maxLength={300} disabled={!canEdit} aria-label="When to use it" />
            </Field>
            {isNew && (
              <Field label="For">
                <Select aria-label="For" value={draft.kind} onChange={(e) => set({ kind: e.target.value as TemplateKind, details: [] })} options={[{ value: "message", label: "Routes and messages" }, { value: "report", label: "Weekly reports" }]} />
              </Field>
            )}
          </Card>

          <Card className="space-y-4 p-5">
            <p className="kicker">The email</p>
            {([
              ["subject", "Subject", "Also the title in the bell. Never a resident's name or an answer.", false, 200],
              ["heading", "Heading", "The big line at the top. Empty = the subject.", false, 200],
              ["intro", "Line under it", draft.kind === "report" ? "Shown under the count of entries." : "Empty = “There's something for you in <form>.”", true, 500],
              ["whatToDo", "What to do", "In the highlighted box, so people know what's expected of them.", true, 500],
              ["buttonLabel", "Button", "Empty = “Open it in Lantern Forms”.", false, 60],
            ] as const).map(([k, label, hint, long, max]) => (
              <Field key={k} label={label} hint={hint}>
                {long ? (
                  <Textarea value={draft[k] ?? ""} onChange={(e) => setText(k, e.target.value)} onFocus={() => (focused.current = k)} rows={2} maxLength={max} disabled={!canEdit} aria-label={label} />
                ) : (
                  <Input value={draft[k] ?? ""} onChange={(e) => setText(k, e.target.value)} onFocus={() => (focused.current = k)} maxLength={max} disabled={!canEdit} aria-label={label} />
                )}
              </Field>
            ))}
            <div>
              <p className="mb-1.5 text-[12.5px] font-semibold text-muted">Tags {canEdit ? "(click one to add it where you were typing)" : ""}</p>
              <div className="flex flex-wrap gap-1.5">
                {tags.map((t) => (
                  <button
                    key={t.tag}
                    type="button"
                    disabled={!canEdit}
                    onClick={() => insertTag(t.tag)}
                    title={t.means}
                    aria-label={`Add ${t.tag}: ${t.means}`}
                    className="rounded-pill border border-hairline bg-subtle px-2.5 py-1 font-mono text-[12px] text-ink hover:border-strongline disabled:cursor-default"
                  >
                    {t.tag}
                  </button>
                ))}
              </div>
              <ul className="mt-2 space-y-0.5 text-[12px] text-muted">
                {tags.map((t) => <li key={t.tag}><span className="font-mono text-ink">{t.tag}</span> {t.means}</li>)}
              </ul>
            </div>
          </Card>

          {draft.kind === "message" && (
            <Card className="space-y-4 p-5">
              <Field label="Details it always shows" hint="Above the answers each route chooses. Shown to Lantern addresses only.">
                <fieldset disabled={!canEdit}>
                  <CheckboxList options={all.details.map((d) => ({ value: d.id, label: d.label }))} value={draft.details} onChange={(v) => set({ details: v })} />
                </fieldset>
              </Field>
              <label className="flex items-start gap-2 text-[13px] text-ink">
                <Switch checked={draft.urgent} onCheckedChange={(v) => set({ urgent: v })} disabled={!canEdit} className="mt-0.5" aria-label="Always urgent" />
                <span>
                  Always urgent
                  <span className="block text-[12px] text-muted">Red in the bell, at the top of their notifications until read, and emailed straight away, whatever the route says.</span>
                </span>
              </label>
            </Card>
          )}

          {!isNew && (
            <Card className="space-y-3 p-5">
              <p className="kicker">Where it's used</p>
              {saved!.uses.length ? (
                <ul className="divide-y divide-hairline text-[13px]">
                  {saved!.uses.map((u, i) => (
                    <li key={i} className="flex flex-wrap items-center gap-x-2 py-1.5">
                      <span className="min-w-0 flex-1 text-ink">{u.form}: <span className="text-muted">{u.kind === "report" ? "weekly report" : u.kind === "route" ? "route" : ""} “{u.name}”</span></span>
                      {u.formId && <Link to={`/admin/notifications/forms/${u.formId}`} className="text-[12.5px] font-semibold text-accent dark:text-white">Open</Link>}
                    </li>
                  ))}
                </ul>
              ) : (
                <p className="text-[13px] text-muted">Nothing uses it yet. Pick it under Wording on a route{draft.kind === "report" ? " or weekly report" : ""}.</p>
              )}
              {canEdit && (
                <div className="flex flex-wrap gap-2 border-t border-hairline pt-3">
                  {saved!.preset && saved!.changed && (
                    <Button size="sm" variant="secondary" disabled={busy} onClick={() => window.confirm(`Put “${saved!.name}” back to the wording the site ships with?${saved!.uses.length ? ` ${usesLine(saved!.uses).replace("Used by", "It changes back for")}.` : ""}`) && void run(() => templatesApi.reset(saved!.id), "Back to the preset.")}>
                      <RotateCcw className="h-3.5 w-3.5" /> Back to preset
                    </Button>
                  )}
                  {!isDefault && !isSystem && (
                    <Button size="sm" variant="secondary" disabled={busy} onClick={() => void run(() => templatesApi.setHidden(saved!.id, !saved!.hidden), saved!.hidden ? "Shown again." : "Hidden: not offered for new routes. What uses it keeps working.")}>
                      {saved!.hidden ? <><Eye className="h-3.5 w-3.5" /> Show it again</> : <><EyeOff className="h-3.5 w-3.5" /> Hide</>}
                    </Button>
                  )}
                  {!saved!.preset && (
                    <Button
                      size="sm"
                      variant="ghost"
                      disabled={busy || saved!.uses.some((u) => u.kind !== "site")}
                      title={saved!.uses.length ? "Move what uses it to another template first" : undefined}
                      onClick={() => window.confirm(`Delete “${saved!.name}”?`) && void run(() => templatesApi.remove(saved!.id), "Deleted.", () => navigate("/admin/notifications/templates"))}
                    >
                      <Trash2 className="h-3.5 w-3.5" /> Delete
                    </Button>
                  )}
                </div>
              )}
            </Card>
          )}
        </div>

        <div className="lg:sticky lg:top-4 lg:self-start">
          <TemplatePreview draft={draft} systemKey={isSystem ? saved?.key : undefined} />
        </div>
      </div>
    </Page>
  );
}

/** The email the template makes, redrawn as it's typed. */
function TemplatePreview({ draft, systemKey }: { draft: TemplateDraft; systemKey?: string }) {
  const [form, setForm] = useState("");
  const [who, setWho] = useState<"inside" | "outside">("inside");
  const [preview, setPreview] = useState<EmailPreview | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const { data: forms } = useQuery({ queryKey: ["routing"], queryFn: () => api.get<{ items: { id: string; title: string }[] }>("/routing") });
  const key = JSON.stringify([draft, form]);
  useEffect(() => {
    const t = window.setTimeout(() => {
      templatesApi
        .preview({ ...draft, name: draft.name || "Preview" }, form || undefined, systemKey)
        .then((p) => {
          setPreview(p);
          setProblem(null);
        })
        .catch((e) => setProblem(errorMessage(e, "Couldn't make the preview.")));
    }, 400);
    return () => window.clearTimeout(t);
  }, [key]); // eslint-disable-line react-hooks/exhaustive-deps

  return (
    <Card className="space-y-3 p-4">
      <div className="flex flex-wrap items-center gap-2">
        <p className="kicker mr-auto">What it looks like</p>
        <div className="inline-flex rounded-input border border-hairline p-0.5" role="radiogroup" aria-label="Who gets it">
          {([["inside", "A Lantern address"], ["outside", "Anyone else"]] as const).map(([k, label]) => (
            <button key={k} type="button" role="radio" aria-checked={who === k} onClick={() => setWho(k)} className={cn("rounded-[5px] px-2.5 py-1 text-[12.5px] font-semibold", who === k ? "bg-navy text-white" : "text-muted hover:text-ink")}>
              {label}
            </button>
          ))}
        </div>
      </div>
      {draft.kind === "message" && (
        <Select
          value={form}
          onChange={(e) => setForm(e.target.value)}
          aria-label="Fill it in from"
          options={[{ value: "", label: "Made-up values" }, ...(forms?.items ?? []).map((f) => ({ value: f.id, label: `${f.title}'s latest entry` }))]}
        />
      )}
      {problem ? (
        <p className="rounded-input bg-status-amberBg px-3 py-2 text-[12.5px] text-status-amberText">{problem}</p>
      ) : preview ? (
        <>
          <p className="text-[13px] text-ink"><span className="font-semibold">Subject:</span> {preview.subject}</p>
          <iframe title="Email preview" sandbox="" srcDoc={who === "inside" ? preview.inside : preview.outside} className="h-[620px] w-full rounded-input border border-hairline bg-white" />
          <p className="text-[12px] text-muted">{preview.from}. {who === "outside" ? "Anyone outside Lantern gets it without the details." : "Lantern addresses see the details and chosen answers."}</p>
        </>
      ) : (
        <LoadingState />
      )}
    </Card>
  );
}

// ── System emails ────────────────────────────────────────────────────────

/** The site's own emails: always sent, worded here. */
export function NotificationsSystemTab() {
  const { data, isLoading } = useEmailTemplates();
  if (isLoading || !data) return <LoadingState />;
  const rows = data.templates.filter((t) => t.kind === "system");
  return (
    <div className="space-y-4">
      <Card className="p-4 text-[13px] text-muted">
        The emails the site sends by itself: access requests and approvals, follow-ups, problems and the daily summary. They're always sent; this is what they say.
        {data.canEdit ? " Change one and you can always put it back." : " Only Super Admins change them."}
      </Card>
      <Card className="p-0">
        <ul className="divide-y divide-hairline">
          {rows.map((t) => (
            <li key={t.id}>
              <Link to={`/admin/notifications/templates/${t.key}`} className="flex items-center gap-3 px-5 py-3 hover:bg-rowhover">
                <span className="min-w-0 flex-1">
                  <span className="flex flex-wrap items-center gap-2">
                    <span className="truncate text-[14px] font-semibold text-ink">{t.name}</span>
                    {t.changed && <Tag tone="accent">Changed</Tag>}
                    {t.urgent && <Tag tone="red">Urgent</Tag>}
                  </span>
                  <span className="mt-0.5 block truncate text-[12.5px] text-muted">{t.description}</span>
                  <span className="mt-0.5 block truncate text-[12px] text-muted">
                    Subject: {t.subject}
                    {t.revision > 1 && t.updatedByName ? ` · changed ${relativeTime(t.updatedAt)} by ${t.updatedByName}` : ""}
                  </span>
                </span>
                <span className="text-[13px] font-semibold text-accent dark:text-white">{data.canEdit ? "Edit" : "View"}</span>
              </Link>
            </li>
          ))}
        </ul>
      </Card>
    </div>
  );
}

// ── Look ─────────────────────────────────────────────────────────────────

/** How every email looks: the name in the band, the colors, a logo, the footer. */
export function NotificationsLookTab() {
  const qc = useQueryClient();
  const toast = useToast();
  const { data, isLoading } = useQuery({ queryKey: ["email", "look"], queryFn: () => lookApi.get() });
  const [look, setLook] = useState<EmailLook | null>(null);
  const [busy, setBusy] = useState(false);
  const [preview, setPreview] = useState<EmailPreview | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  useEffect(() => {
    if (data) setLook(data.look);
  }, [data]);
  const key = JSON.stringify(look);
  useEffect(() => {
    if (!look) return;
    const t = window.setTimeout(() => {
      lookApi.preview(look).then((p) => { setPreview(p); setProblem(null); }).catch((e) => setProblem(errorMessage(e, "Couldn't make the preview.")));
    }, 400);
    return () => window.clearTimeout(t);
  }, [key]); // eslint-disable-line react-hooks/exhaustive-deps
  if (isLoading || !data || !look) return <LoadingState />;
  const canEdit = data.canEdit;
  const dirty = JSON.stringify(look) !== JSON.stringify(data.look);
  const isDefault = JSON.stringify(look) === JSON.stringify(data.defaults);
  const set = (patch: Partial<EmailLook>) => setLook({ ...look, ...patch });

  async function save() {
    setBusy(true);
    try {
      await lookApi.save(look!);
      await qc.invalidateQueries({ queryKey: ["email", "look"] });
      toast("Saved. Every email from now on looks like this.");
    } catch (e) {
      toast(errorMessage(e, "Couldn't save."), "error");
    } finally {
      setBusy(false);
    }
  }

  const color = (k: "bandColor" | "accentColor" | "buttonColor", label: string, hint: string, needsWhite: boolean) => {
    const ratio = whiteContrast(look[k]);
    const low = needsWhite && ratio > 0 && ratio < 4.5;
    return (
      <Field label={label} hint={hint}>
        <div className="flex items-center gap-2">
          <input type="color" value={/^#[0-9a-f]{6}$/i.test(look[k]) ? look[k] : "#000000"} onChange={(e) => set({ [k]: e.target.value } as Partial<EmailLook>)} disabled={!canEdit} aria-label={`${label}: pick`} className="h-9 w-12 cursor-pointer rounded-input border border-hairline bg-surface p-0.5 disabled:cursor-default" />
          <Input value={look[k]} onChange={(e) => set({ [k]: e.target.value.trim() } as Partial<EmailLook>)} maxLength={7} disabled={!canEdit} aria-label={label} className="w-[120px] font-mono" />
          {needsWhite && ratio > 0 && <span className={cn("text-[12px]", low ? "font-semibold text-status-redText" : "text-muted")}>{low ? `Too light for white text (${ratio.toFixed(1)}:1)` : `White text reads well (${ratio.toFixed(1)}:1)`}</span>}
        </div>
      </Field>
    );
  };

  return (
    <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_minmax(0,1fr)]">
      <div className="space-y-4">
        <Card className="space-y-4 p-5">
          <Field label="Name in the band" hint="At the top of every email, above what it's about.">
            <Input value={look.orgName} onChange={(e) => set({ orgName: e.target.value })} maxLength={80} disabled={!canEdit} aria-label="Name in the band" />
          </Field>
          <Field label="Logo" hint="Optional. The https:// address of an image anyone can open (some mail apps hide images until asked).">
            <Input value={look.logoUrl} onChange={(e) => set({ logoUrl: e.target.value.trim() })} maxLength={500} placeholder="https://…/logo.png" disabled={!canEdit} aria-label="Logo address" />
          </Field>
          {color("bandColor", "Band", "The band at the top, headings and table headers. It carries white text.", true)}
          {color("accentColor", "Stripe", "The thin line under the band and the edge of What to do.", false)}
          {color("buttonColor", "Button", "The button into Lantern Forms. It carries white text.", true)}
          <Field label="Footer" hint="The line at the bottom of every email.">
            <Textarea value={look.footer} onChange={(e) => set({ footer: e.target.value })} rows={2} maxLength={300} disabled={!canEdit} aria-label="Footer" />
          </Field>
          <p className="rounded-input bg-subtle px-3 py-2 text-[12.5px] text-muted">
            Emails go from {data.sender ? <span className="font-mono text-ink">{data.sender}</span> : "the mailbox in MAIL_FROM (not set on this server)"} under that mailbox's own name in Microsoft 365, so the sender is changed there, not here.
          </p>
          {canEdit ? (
            <div className="flex flex-wrap gap-2">
              <Button onClick={() => void save()} disabled={busy || !dirty}>{busy ? "Saving…" : "Save"}</Button>
              {dirty && <Button variant="secondary" onClick={() => setLook(data.look)} disabled={busy}>Undo</Button>}
              {!isDefault && <Button variant="ghost" onClick={() => setLook(data.defaults)} disabled={busy}><RotateCcw className="h-3.5 w-3.5" /> The default look</Button>}
            </div>
          ) : (
            <Tag tone="neutral"><Lock className="h-3 w-3" /> Only Super Admins change how emails look</Tag>
          )}
        </Card>
      </div>
      <div className="lg:sticky lg:top-4 lg:self-start">
        <Card className="space-y-3 p-4">
          <p className="kicker">An email in this look</p>
          {problem ? (
            <p className="rounded-input bg-status-amberBg px-3 py-2 text-[12.5px] text-status-amberText">{problem}</p>
          ) : preview ? (
            <iframe title="Email preview" sandbox="" srcDoc={preview.inside} className="h-[620px] w-full rounded-input border border-hairline bg-white" />
          ) : (
            <LoadingState />
          )}
        </Card>
      </div>
    </div>
  );
}

// ── Sent emails ──────────────────────────────────────────────────────────

interface Sent { id: string; createdAt: string; to: string; subject: string; kind: string; status: string; error: string | null; withAnswers: boolean; formId: string | null; form: string | null }

const KINDS: Record<string, string> = { route: "Routing", notification: "Notification", digest: "Daily summary", report: "Weekly report", rule: "Form rule", code: "Code form" };

export function NotificationsSentTab() {
  const [kind, setKind] = useState("");
  const [status, setStatus] = useState("");
  const [to, setTo] = useState("");
  const [toQuery, setToQuery] = useState("");
  useEffect(() => {
    const t = window.setTimeout(() => setToQuery(to.trim()), 350);
    return () => window.clearTimeout(t);
  }, [to]);
  const params = useMemo(() => ({ ...(kind ? { kind } : {}), ...(status ? { status } : {}), ...(toQuery ? { to: toQuery } : {}) }), [kind, status, toQuery]);
  const q = useInfiniteQuery({
    queryKey: ["email", "sent", params],
    initialPageParam: null as string | null,
    queryFn: ({ pageParam }) => api.get<{ items: Sent[] }>(`/email/sent?${new URLSearchParams({ ...params, limit: "50", ...(pageParam ? { before: pageParam } : {}) })}`),
    getNextPageParam: (last) => (last.items.length === 50 ? last.items[last.items.length - 1].createdAt : null),
  });
  const items = q.data?.pages.flatMap((p) => p.items) ?? [];
  return (
    <div className="space-y-3">
      <div className="flex flex-wrap gap-2">
        <div className="w-[190px]"><Select value={kind} onChange={(e) => setKind(e.target.value)} aria-label="Kind" options={[{ value: "", label: "Every kind" }, ...Object.entries(KINDS).map(([value, label]) => ({ value, label }))]} /></div>
        <div className="w-[160px]"><Select value={status} onChange={(e) => setStatus(e.target.value)} aria-label="Status" options={[{ value: "", label: "Any status" }, { value: "sent", label: "Sent" }, { value: "failed", label: "Failed" }, { value: "skipped", label: "Not sent" }]} /></div>
        <Input value={to} onChange={(e) => setTo(e.target.value)} placeholder="To (part of an address)" aria-label="To" className="w-[240px]" />
      </div>
      <Card className="p-0">
        {q.isLoading ? (
          <LoadingState />
        ) : items.length ? (
          <ul className="divide-y divide-hairline">
            {items.map((e) => (
              <li key={e.id} className="px-4 py-2.5 md:px-5">
                <div className="flex flex-wrap items-baseline gap-x-2">
                  <span className="min-w-0 flex-1 truncate text-[13.5px] font-semibold text-ink">{e.subject}</span>
                  <span className="text-[12px] text-muted" title={formatDateTime(e.createdAt)}>{relativeTime(e.createdAt)}</span>
                </div>
                <div className="mt-0.5 flex flex-wrap items-center gap-1.5 text-[12px] text-muted">
                  <span className="truncate">{e.to}</span>
                  <span>· {KINDS[e.kind] ?? e.kind}</span>
                  {e.form && e.formId && <>· <Link to={`/admin/notifications/forms/${e.formId}`} className="font-semibold text-accent dark:text-white">{e.form}</Link></>}
                  <Tag tone={e.status === "sent" ? "accent" : e.status === "failed" ? "red" : "neutral"}>{e.status === "sent" ? "Sent" : e.status === "failed" ? "Failed" : "Not sent"}</Tag>
                  {e.withAnswers && <Tag tone="neutral">With answers</Tag>}
                </div>
                {e.error && <p className="mt-0.5 text-[12px] text-status-redText">{e.error}</p>}
              </li>
            ))}
          </ul>
        ) : (
          <EmptyState title="No emails" hint={Object.keys(params).length ? "Nothing matches. Try fewer filters." : "Nothing has been emailed yet."} />
        )}
        {q.hasNextPage && (
          <div className="border-t border-hairline px-4 py-3 text-center">
            <Button variant="secondary" size="sm" onClick={() => void q.fetchNextPage()} disabled={q.isFetchingNextPage}>{q.isFetchingNextPage ? "Loading…" : "Older emails"}</Button>
          </div>
        )}
      </Card>
    </div>
  );
}
