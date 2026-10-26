import { useEffect, useMemo, useState } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { ArrowLeft, AtSign, Briefcase, Copy, ExternalLink, Eye, Mail, MoreHorizontal, Plus, RotateCcw, Search, Send, Trash2, User, UserCheck, Users, UsersRound, X } from "lucide-react";
import { GroupChecklist, PositionsDropdown } from "@/components/AccessPickers";
import { useJobTitles, useStaffGroups } from "@/lib/groups";
import { Page, PageHeader } from "@/components/shell/AppShell";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input, SearchInput, Textarea } from "@/components/ui/input";
import { Field } from "@/components/ui/label";
import { Select } from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { Tag } from "@/components/ui/badge";
import { Avatar } from "@/components/ui/avatar";
import { CheckboxList } from "@/components/ui/checkbox";
import { Dialog, DialogBody, DialogContent, DialogFooter, DialogHeader } from "@/components/ui/dialog";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { EmptyState, LoadingState } from "@/components/ui/misc";
import { useToast } from "@/components/ui/toast";
import { api } from "@/lib/api";
import { useSites } from "@/lib/queries";
import type { Site } from "@/lib/types";
import { cn, errorMessage, formatDateTime, relativeTime } from "@/lib/utils";

/**
 * Admin → Notification routing: for each form, who's told about what. A form
 * has events (every form has "A new entry"; code forms declare their own, like
 * "Supervisor signature needed"); each route answers one, optionally only at
 * some sites or for some answers, and names the people to tell. Saved per form,
 * outside the form itself (backend/src/services/routing.ts), so changing a list
 * never needs a new version of the form. The MCP has the same (get_routing…).
 */

type Recipient =
  | { kind: "person"; email: string; name?: string; sites?: string[] }
  | { kind: "role"; role: string; siteOnly?: boolean }
  | { kind: "field"; field: string }
  | { kind: "submitter" }
  /** Everyone in a staff group (People & roles → Groups); siteOnly keeps it to the event's site. */
  | { kind: "group"; group: string; siteOnly?: boolean }
  /** Everyone with a position (an exact job title). */
  | { kind: "title"; title: string; siteOnly?: boolean };

interface Rule { field: string; op: string; value?: string | number | boolean }

interface Route {
  id: string;
  name: string;
  event: string;
  enabled: boolean;
  when?: { match: "all" | "any"; rules: Rule[] };
  sites?: string[];
  to: Recipient[];
  email: "always" | "prefs";
  /** Needs attention now: red in the bell, pinned on their list, emailed at once. */
  urgent?: boolean;
  subject?: string;
  /** What the people on it have to do, shown in the email. */
  whatToDo?: string;
  /** Answers shown in the email, to Lantern addresses only (RoutingView.emailFields). */
  fields?: string[];
}

interface EmailField { id: string; label: string }

interface RoutingEvent {
  id: string;
  label: string;
  description?: string;
  fields?: { id: string; label: string; choices?: string[] }[];
  people?: { id: string; label: string }[];
}

interface Plan { routeId?: string; routeName?: string; people: { id: string; name: string; email: string }[]; emails: string[]; notes: string[] }

interface LogItem { id: string; at: string; event: string; title?: string; entryId?: string | null; site?: string | null; routes: Plan[]; told: number; emailed: number; failures?: string[]; actor?: string }

interface RoutingView {
  form: { id: string; slug: string; title: string; kind: "basic" | "code"; status: string; url: string };
  events: RoutingEvent[];
  /** The answers a route's email may show (never residents, names, contact details, signatures, files or paragraphs). */
  emailFields: EmailField[];
  roles: { key: string; name: string; everySite: boolean }[];
  routes: Route[];
  revision: number;
  usingDefaults: boolean;
  updatedByName: string | null;
  updatedAt: string | null;
  log: LogItem[];
}

interface FormRow { id: string; slug: string; title: string; kind: "basic" | "code"; status: string; routes: number; enabled: number; usingDefaults: boolean; updatedAt: string | null; updatedByName: string | null }

const OPS: { value: string; label: string; needsValue: boolean }[] = [
  { value: "is", label: "is", needsValue: true },
  { value: "is_not", label: "is not", needsValue: true },
  { value: "contains", label: "includes", needsValue: true },
  { value: "not_contains", label: "doesn't include", needsValue: true },
  { value: "not_empty", label: "is filled in", needsValue: false },
  { value: "empty", label: "is empty", needsValue: false },
  { value: "gt", label: "is more than", needsValue: true },
  { value: "lt", label: "is less than", needsValue: true },
];

// ── The list of forms ────────────────────────────────────────────────────

export function AdminRouting() {
  const { data, isLoading } = useQuery({ queryKey: ["routing"], queryFn: () => api.get<{ items: FormRow[] }>("/routing") });
  const [q, setQ] = useState("");
  const rows = (data?.items ?? []).filter((f) => !q.trim() || f.title.toLowerCase().includes(q.trim().toLowerCase()));
  return (
    <Page className="max-w-[920px]">
      <PageHeader title="Notification routing" subtitle="Who each form tells, and when: by email and in the app." />
      <SearchInput value={q} onChange={(e) => setQ(e.target.value)} placeholder="Find a form" wrapperClassName="mb-3 max-w-[360px]" className="!pl-9" />
      {isLoading ? (
        <LoadingState />
      ) : !rows.length ? (
        <EmptyState title="No forms" hint="Forms built here (the form builder or code forms) show up here." />
      ) : (
        <Card className="p-0">
          <ul className="divide-y divide-hairline">
            {rows.map((f) => (
              <li key={f.id}>
                <Link to={`/admin/routing/${f.id}`} className="flex items-center gap-3 px-5 py-3 hover:bg-rowhover">
                  <span className="min-w-0 flex-1">
                    <span className="flex items-center gap-2">
                      <span className="truncate text-[14px] font-semibold text-ink">{f.title}</span>
                      {f.kind === "code" && <Tag tone="neutral">Code form</Tag>}
                      {f.status === "draft" && <Tag tone="amber">Draft</Tag>}
                    </span>
                    <span className="mt-0.5 block text-[12.5px] text-muted">
                      {f.routes ? `${f.routes} route${f.routes === 1 ? "" : "s"}${f.enabled < f.routes ? ` (${f.enabled} on)` : ""}` : "Nobody is told"}
                      {f.usingDefaults ? (f.routes ? " · the form's defaults" : "") : f.updatedAt ? ` · changed ${relativeTime(f.updatedAt)}${f.updatedByName ? ` by ${f.updatedByName}` : ""}` : ""}
                    </span>
                  </span>
                  <span className="text-[13px] font-semibold text-accent">Edit</span>
                </Link>
              </li>
            ))}
          </ul>
        </Card>
      )}
    </Page>
  );
}

// ── One form's routes ────────────────────────────────────────────────────

export function AdminRoutingForm() {
  const { id = "" } = useParams();
  return <RoutingEditor formId={id} />;
}

/**
 * One form's routes. In Admin (`/admin/routing/:id`) with a way back to every
 * form; `inForm` is the same editor as the form's own Notifications tab, where
 * the form is already open around it.
 */
export function RoutingEditor({ formId: id, inForm = false }: { formId: string; inForm?: boolean }) {
  const navigate = useNavigate();
  const qc = useQueryClient();
  const toast = useToast();
  const { data, isLoading, refetch } = useQuery({ queryKey: ["routing", id], queryFn: () => api.get<RoutingView>(`/routing/${id}`) });
  const { data: sites } = useSites(true);
  const [routes, setRoutes] = useState<Route[] | null>(null);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    if (data) setRoutes(data.routes);
  }, [data]);

  if (isLoading || !data || !routes) return <LoadingState />;
  const dirty = JSON.stringify(routes) !== JSON.stringify(data.routes);
  const siteList = (sites ?? []).filter((s) => s.active !== false);

  const change = (rid: string, next: Route | null) => setRoutes(next ? routes.map((r) => (r.id === rid ? next : r)) : routes.filter((r) => r.id !== rid));
  const add = (event: RoutingEvent) => {
    const rid = uniqueId(routes.map((r) => r.id), event.id === "entry.created" ? "new-entry" : event.id);
    setRoutes([...routes, { id: rid, name: "New route", event: event.id, enabled: true, to: [], email: "always" }]);
  };

  async function save() {
    const empty = routes!.find((r) => !r.to.length);
    if (empty) return toast(`“${empty.name}” tells nobody. Add someone, or remove it.`, "error");
    setBusy(true);
    try {
      await api.put(`/routing/${id}`, { routes, revision: data!.revision });
      toast("Saved. The next entries go to these people.");
      await qc.invalidateQueries({ queryKey: ["routing"] });
      await refetch();
    } catch (e) {
      toast(errorMessage(e, "Couldn't save."), "error");
    } finally {
      setBusy(false);
    }
  }

  async function reset() {
    if (!window.confirm("Throw away this form's routing and go back to what the form ships with?")) return;
    try {
      await api.post(`/routing/${id}/reset`, {});
      toast("Back to the form's defaults.");
      await qc.invalidateQueries({ queryKey: ["routing"] });
      await refetch();
    } catch (e) {
      toast(errorMessage(e, "Couldn't reset."), "error");
    }
  }

  return (
    <Page className="max-w-[920px] pb-24">
      {!inForm && (
        <button type="button" onClick={() => navigate("/admin/routing")} className="mb-2 inline-flex items-center gap-1 text-[13px] font-semibold text-accent">
          <ArrowLeft className="h-3.5 w-3.5" /> All forms
        </button>
      )}
      <PageHeader
        title={inForm ? "Notifications" : data.form.title}
        subtitle={inForm ? "Who this form tells, and when: by email and in the app. Only Admins can see or change this." : "Who this form tells, and when."}
        actions={
          <div className="flex gap-2">
            {!inForm && <Button variant="secondary" onClick={() => window.open(data.form.url, "_blank")}><ExternalLink className="h-4 w-4" /> Open form</Button>}
            <Button onClick={save} disabled={!dirty || busy}>{busy ? "Saving…" : "Save"}</Button>
          </div>
        }
      />

      <Card className="mb-5 p-4 text-[13px] text-muted">
        {data.usingDefaults ? (
          <p>{routes.length ? <>These are the routes <b className="text-ink">{data.form.title}</b> ships with. Change anything and save to make them this form's own.</> : <>Nobody is told about this form yet. Add a route under an event below.</>}</p>
        ) : (
          <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
            <p className="min-w-0 flex-1">Changed {data.updatedAt ? relativeTime(data.updatedAt) : ""}{data.updatedByName ? ` by ${data.updatedByName}` : ""}.</p>
            <Button variant="ghost" size="sm" onClick={reset}><RotateCcw className="h-3.5 w-3.5" /> Back to the form's defaults</Button>
          </div>
        )}
        <p className="mt-1.5">
          People with an account are told in the app and by email; anyone else gets the email. Each email says what to do and can show the answers you choose, to Lantern addresses only:
          residents, names, contact details, signatures and files never go in an email. Nobody is told twice about one event.
        </p>
      </Card>

      {data.events.map((ev) => {
        const mine = routes.filter((r) => r.event === ev.id);
        return (
          <section key={ev.id} className="mb-6">
            <div className="mb-2 flex items-end gap-3 px-1">
              <div className="min-w-0 flex-1">
                <p className="font-heading text-[15px] font-extrabold text-ink">{ev.label}</p>
                {ev.description && <p className="text-[12.5px] text-muted">{ev.description}</p>}
              </div>
              <Button variant="secondary" size="sm" onClick={() => add(ev)}><Plus className="h-4 w-4" /> Add a route</Button>
            </div>
            {mine.length ? (
              <div className="space-y-3">
                {mine.map((r) => (
                  <RouteCard
                    key={r.id}
                    route={r}
                    event={ev}
                    roles={data.roles}
                    sites={siteList}
                    formId={id}
                    emailFields={data.emailFields}
                    onChange={(next) => change(r.id, next)}
                    onDuplicate={() => setRoutes([...routes, { ...structuredClone(r), id: uniqueId(routes.map((x) => x.id), r.id), name: `${r.name} (copy)` }])}
                  />
                ))}
              </div>
            ) : (
              <p className="rounded-card border border-dashed border-hairline px-4 py-3 text-[13px] text-muted">Nobody is told.</p>
            )}
          </section>
        );
      })}

      {data.form.kind === "basic" && <FollowUpSection formId={id} roles={data.roles} sites={siteList} />}

      <ReportsSection formId={id} emailFields={data.emailFields} roles={data.roles} sites={siteList} />

      <RecentSends items={data.log} />

      <SentEmails formId={id} />

      {dirty && (
        <div className="sticky bottom-0 z-10 -mx-4 mt-5 flex items-center justify-between gap-3 border-t border-hairline bg-surface px-4 py-3 md:-mx-7 md:px-7">
          <span className="text-[13.5px] font-semibold text-ink">Unsaved changes</span>
          <div className="flex gap-2">
            <Button variant="secondary" onClick={() => setRoutes(data.routes)} disabled={busy}>Undo</Button>
            <Button onClick={save} disabled={busy}>{busy ? "Saving…" : "Save"}</Button>
          </div>
        </div>
      )}
    </Page>
  );
}

function uniqueId(taken: string[], base: string) {
  const b = base.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40) || "route";
  let out = b;
  for (let n = 2; taken.includes(out); n++) out = `${b}-${n}`;
  return out;
}

// ── A route ──────────────────────────────────────────────────────────────

function RouteCard({ route, event, roles, sites, formId, emailFields, onChange, onDuplicate }: {
  route: Route;
  event: RoutingEvent;
  roles: RoutingView["roles"];
  sites: Site[];
  formId: string;
  emailFields: EmailField[];
  onChange: (r: Route | null) => void;
  onDuplicate: () => void;
}) {
  const [picking, setPicking] = useState<null | "sites" | "person" | "role" | "group" | "title">(null);
  const set = (patch: Partial<Route>) => onChange({ ...route, ...patch });
  const siteName = (code: string) => sites.find((s) => s.code === code)?.name ?? code;
  const rules = route.when?.rules ?? [];
  const setRules = (next: Rule[]) => set({ when: next.length ? { match: route.when?.match ?? "all", rules: next } : undefined });
  const fields = [...(event.fields ?? []), { id: "site", label: "Site (code)", choices: sites.map((s) => s.code) }];

  return (
    <Card className={cn("p-0", !route.enabled && "opacity-70")}>
      <div className="flex items-center gap-3 border-b border-hairline px-4 py-3 md:px-5">
        <Switch checked={route.enabled} onCheckedChange={(v) => set({ enabled: v })} aria-label={route.enabled ? "Turn this route off" : "Turn this route on"} />
        <input value={route.name} onChange={(e) => set({ name: e.target.value })} aria-label="Route name" className="min-w-0 flex-1 bg-transparent font-heading text-[15px] font-extrabold text-ink outline-none focus:underline" />
        {route.urgent && <Tag tone="red">Urgent</Tag>}
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button variant="ghost" size="icon" aria-label="More"><MoreHorizontal className="h-4 w-4" /></Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end">
            <DropdownMenuItem onSelect={onDuplicate}><Copy className="h-4 w-4" /> Duplicate</DropdownMenuItem>
            <DropdownMenuSeparator />
            <DropdownMenuItem onSelect={() => onChange(null)} className="text-status-redText"><Trash2 className="h-4 w-4" /> Remove route</DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </div>

      <div className="grid gap-4 px-4 py-4 md:px-5">
        <Row label="At">
          <div className="flex flex-wrap items-center gap-1.5">
            {route.sites?.length ? route.sites.map((c) => <Pill key={c} onRemove={() => set({ sites: route.sites!.filter((x) => x !== c) })}>{siteName(c)}</Pill>) : <span className="text-[13.5px] text-ink">Every site</span>}
            <Button variant="ghost" size="sm" onClick={() => setPicking("sites")}>Choose sites</Button>
          </div>
        </Row>

        <Row label="Only when">
          <div className="space-y-2">
            {rules.length > 1 && (
              <Select value={route.when?.match ?? "all"} onChange={(e) => set({ when: { match: e.target.value as "all" | "any", rules } })} className="w-auto" aria-label="Match">
                <option value="all">All of these are true</option>
                <option value="any">Any of these is true</option>
              </Select>
            )}
            {rules.map((rule, i) => {
              const f = fields.find((x) => x.id === rule.field);
              const op = OPS.find((o) => o.value === rule.op);
              const put = (patch: Partial<Rule>) => setRules(rules.map((r, j) => (j === i ? { ...r, ...patch } : r)));
              return (
                <div key={i} className="flex flex-wrap items-center gap-2">
                  {fields.length > 1 || !event.fields ? (
                    <Select value={rule.field} onChange={(e) => put({ field: e.target.value, value: "" })} className="w-48" aria-label="Value to test">
                      {fields.map((x) => <option key={x.id} value={x.id}>{x.label}</option>)}
                      {!f && <option value={rule.field}>{rule.field}</option>}
                    </Select>
                  ) : null}
                  {!event.fields && rule.field !== "site" && (
                    <Input value={rule.field} onChange={(e) => put({ field: e.target.value })} placeholder="value name" className="w-40" aria-label="Value name" />
                  )}
                  <Select value={rule.op} onChange={(e) => put({ op: e.target.value })} className="w-40" aria-label="Test">
                    {OPS.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
                  </Select>
                  {op?.needsValue !== false && (f?.choices?.length ? (
                    <Select value={String(rule.value ?? "")} onChange={(e) => put({ value: e.target.value })} className="w-56" aria-label="Value" placeholder="Choose…">
                      {f.choices.map((c) => <option key={c} value={c}>{rule.field === "site" ? siteName(c) : c}</option>)}
                    </Select>
                  ) : (
                    <Input value={String(rule.value ?? "")} onChange={(e) => put({ value: e.target.value })} className="w-48" aria-label="Value" />
                  ))}
                  <Button variant="ghost" size="icon" aria-label="Remove condition" onClick={() => setRules(rules.filter((_, j) => j !== i))}><X className="h-4 w-4" /></Button>
                </div>
              );
            })}
            <Button variant="ghost" size="sm" onClick={() => setRules([...rules, { field: fields[0].id, op: "is", value: "" }])}>
              <Plus className="h-3.5 w-3.5" /> {rules.length ? "Another condition" : "Add a condition"}
            </Button>
            {!rules.length && <span className="ml-1 text-[12.5px] text-muted">Always, for every {event.label.toLowerCase()}.</span>}
          </div>
        </Row>

        <Row label="Tell">
          <div>
            {route.to.length ? (
              <ul className="divide-y divide-hairline rounded-input border border-hairline">
                {route.to.map((t, i) => (
                  <RecipientRow key={i} r={t} event={event} roles={roles} siteName={siteName} onChange={(next) => set({ to: next ? route.to.map((x, j) => (j === i ? next : x)) : route.to.filter((_, j) => j !== i) })} />
                ))}
              </ul>
            ) : (
              <p className="text-[13px] font-semibold text-status-amberText">Nobody yet.</p>
            )}
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button variant="ghost" size="sm" className="mt-1.5"><Plus className="h-3.5 w-3.5" /> Add people</Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="start">
                <DropdownMenuItem onSelect={() => setPicking("person")}><User className="h-4 w-4" /> Someone by name or email</DropdownMenuItem>
                <DropdownMenuItem onSelect={() => setPicking("role")}><Users className="h-4 w-4" /> Everyone with a role</DropdownMenuItem>
                <DropdownMenuItem onSelect={() => setPicking("group")}><UsersRound className="h-4 w-4" /> Everyone in a group</DropdownMenuItem>
                <DropdownMenuItem onSelect={() => setPicking("title")}><Briefcase className="h-4 w-4" /> Everyone with a position</DropdownMenuItem>
                {(event.people ?? []).map((p) => (
                  <DropdownMenuItem key={p.id} disabled={route.to.some((t) => t.kind === "field" && t.field === p.id)} onSelect={() => set({ to: [...route.to, { kind: "field", field: p.id }] })}>
                    <AtSign className="h-4 w-4" /> {p.label}
                  </DropdownMenuItem>
                ))}
                <DropdownMenuItem disabled={route.to.some((t) => t.kind === "submitter")} onSelect={() => set({ to: [...route.to, { kind: "submitter" }] })}>
                  <UserCheck className="h-4 w-4" /> The person who filed it
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
          </div>
        </Row>

        <Row label="Email">
          <Select value={route.email} onChange={(e) => set({ email: e.target.value as Route["email"] })} className="max-w-[420px]" aria-label="Email">
            <option value="always">Email everyone on this route</option>
            <option value="prefs">Follow each person's own notification settings</option>
          </Select>
        </Row>

        <Row label="Priority">
          <label className="flex items-start gap-2 pt-1 text-[13px] text-ink">
            <Switch checked={route.urgent ?? false} onCheckedChange={(v) => set({ urgent: v || undefined })} className="mt-0.5" aria-label="Urgent" />
            <span>
              Urgent
              <span className="block text-[12px] text-muted">
                For what can't wait, like an incident. It's red in their bell and stays at the top of their notifications until read, and it's emailed straight away even to people who get a daily summary. Keep it for the few that need it, or people stop noticing.
              </span>
            </span>
          </label>
        </Row>

        <Row label="Subject">
          <Input value={route.subject ?? ""} onChange={(e) => set({ subject: e.target.value || undefined })} placeholder="The form's own subject" className="max-w-[420px]" aria-label="Subject" />
          <p className="mt-1 text-[12px] text-muted">Optional. Can use {"{form}"}, {"{site}"}, {"{title}"} and {"{date}"}. Never put a resident's name here: it's the email subject.</p>
        </Row>

        <EmailParts
          whatToDo={route.whatToDo}
          fields={route.fields}
          emailFields={emailFields}
          onChange={(patch) => set(patch)}
          preview={() => api.post<EmailPreview>(`/routing/${formId}/email-preview`, { route: { ...route, name: route.name || "Route" } })}
        />

        <WhoGetsIt route={route} sites={sites} formId={formId} />
      </div>

      <SitesDialog open={picking === "sites"} sites={sites} value={route.sites ?? []} onClose={() => setPicking(null)} onSave={(v) => set({ sites: v.length ? v : undefined })} title="Only events at these sites" hint="Leave all unticked for every site." />
      <PersonDialog open={picking === "person"} sites={sites} taken={route.to} onClose={() => setPicking(null)} onAdd={(r) => set({ to: [...route.to, r] })} />
      <RoleDialog open={picking === "role"} roles={roles} onClose={() => setPicking(null)} onAdd={(r) => set({ to: [...route.to, r] })} />
      {picking === "group" && <TeamDialog taken={route.to} onClose={() => setPicking(null)} onAdd={(rs) => set({ to: [...route.to, ...rs] })} />}
      {picking === "title" && <PositionDialog taken={route.to} onClose={() => setPicking(null)} onAdd={(rs) => set({ to: [...route.to, ...rs] })} />}
    </Card>
  );
}

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="grid gap-1.5 md:grid-cols-[110px_1fr] md:gap-4">
      <p className="pt-1.5 text-[12px] font-bold uppercase tracking-wide text-muted">{label}</p>
      <div className="min-w-0">{children}</div>
    </div>
  );
}

function Pill({ children, onRemove }: { children: React.ReactNode; onRemove?: () => void }) {
  return (
    <span className="inline-flex items-center gap-1 rounded-pill bg-navsel px-2.5 py-0.5 text-[12.5px] font-semibold text-ink">
      {children}
      {onRemove && <button type="button" onClick={onRemove} aria-label="Remove" className="text-muted hover:text-ink"><X className="h-3 w-3" /></button>}
    </span>
  );
}

function RecipientRow({ r, event, roles, siteName, onChange }: { r: Recipient; event: RoutingEvent; roles: RoutingView["roles"]; siteName: (c: string) => string; onChange: (r: Recipient | null) => void }) {
  const { data: groups } = useStaffGroups(r.kind === "group");
  const { data: titles } = useJobTitles(r.kind === "group");
  let icon = <User className="h-4 w-4" />;
  let title = "";
  let sub = "";
  if (r.kind === "person") {
    title = r.name || r.email;
    sub = [r.name ? r.email : null, r.sites?.length ? `only for ${r.sites.map(siteName).join(", ")}` : null].filter(Boolean).join(" · ");
  } else if (r.kind === "role") {
    icon = <Users className="h-4 w-4" />;
    const role = roles.find((x) => x.key === r.role);
    title = `Every ${role?.name ?? r.role}`;
    sub = role?.everySite ? "They work at every site" : r.siteOnly === false ? "At every site" : "At the event's site";
  } else if (r.kind === "group") {
    icon = <UsersRound className="h-4 w-4" />;
    const g = groups?.find((x) => x.id === r.group);
    const positions = (titles ?? []).filter((t) => t.groupIds.includes(r.group)).map((t) => t.title);
    title = `Everyone in ${g?.name ?? "a deleted group"}`;
    sub = [g ? `${g.members.length} ${g.members.length === 1 ? "person" : "people"}` : null, positions.slice(0, 3).join(", ") + (positions.length > 3 ? `, +${positions.length - 3}` : "")].filter(Boolean).join(" · ");
  } else if (r.kind === "title") {
    icon = <Briefcase className="h-4 w-4" />;
    title = `Every ${r.title}`;
    sub = "Everyone with this job title";
  } else if (r.kind === "field") {
    icon = <AtSign className="h-4 w-4" />;
    title = event.people?.find((p) => p.id === r.field)?.label ?? r.field;
    sub = "Named on the form";
  } else {
    icon = <UserCheck className="h-4 w-4" />;
    title = "The person who filed it";
  }
  return (
    <li className="flex items-center gap-3 px-3 py-2">
      {r.kind === "person" ? <Avatar name={r.name || r.email} size={28} /> : <span className="grid h-7 w-7 place-items-center rounded-full bg-navsel text-accent">{icon}</span>}
      <span className="min-w-0 flex-1">
        <span className="block truncate text-[13.5px] font-semibold text-ink">{title}</span>
        {sub && <span className="block truncate text-[12px] text-muted">{sub}</span>}
      </span>
      {r.kind === "role" && !roles.find((x) => x.key === r.role)?.everySite && (
        <Select value={r.siteOnly === false ? "all" : "site"} onChange={(e) => onChange({ ...r, siteOnly: e.target.value === "site" ? undefined : false })} className="w-40" aria-label="Where">
          <option value="site">At the event's site</option>
          <option value="all">At every site</option>
        </Select>
      )}
      {(r.kind === "group" || r.kind === "title") && (
        <Select value={r.siteOnly ? "site" : "all"} onChange={(e) => onChange({ ...r, siteOnly: e.target.value === "site" || undefined })} className="w-44" aria-label="Where">
          <option value="all">Wherever they work</option>
          <option value="site">At the event's site</option>
        </Select>
      )}
      <Button variant="ghost" size="icon" aria-label={`Remove ${title}`} onClick={() => onChange(null)}><X className="h-4 w-4" /></Button>
    </li>
  );
}

/** Who the route would tell at a site, from the people saved on it now (unsaved changes included). */
function WhoGetsIt({ route, sites, formId }: { route: Route; sites: Site[]; formId: string }) {
  const [site, setSite] = useState(route.sites?.[0] ?? "");
  const [plan, setPlan] = useState<Plan | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const key = JSON.stringify(route.to) + JSON.stringify(route.sites ?? []);
  useEffect(() => setPlan(null), [key, site]);

  async function check() {
    setBusy(true);
    setErr(null);
    try {
      setPlan(await api.post<Plan>(`/routing/${formId}/preview`, { route: { ...route, name: route.name || "Route" }, site: site || undefined }));
    } catch (e) {
      setErr(errorMessage(e, "Couldn't check."));
    } finally {
      setBusy(false);
    }
  }
  const placeholders = route.to.filter((t) => t.kind === "field" || t.kind === "submitter").length;
  return (
    <div className="rounded-input bg-subtle px-3 py-2.5">
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-[12.5px] font-semibold text-ink">Who'd be told for an event at</span>
        <Select value={site} onChange={(e) => setSite(e.target.value)} className="w-56" aria-label="Site">
          <option value="">No site</option>
          {sites.map((s) => <option key={s.code} value={s.code}>{s.name}</option>)}
        </Select>
        <Button variant="secondary" size="sm" onClick={check} disabled={busy || !route.to.length}><Search className="h-3.5 w-3.5" /> {busy ? "Checking…" : "Check"}</Button>
      </div>
      {err && <p className="mt-2 text-[12.5px] text-status-redText">{err}</p>}
      {plan && (
        <div className="mt-2 text-[12.5px] text-ink">
          {plan.people.length + plan.emails.length ? (
            <p>
              {plan.people.map((p) => p.name).join(", ")}
              {plan.emails.length ? `${plan.people.length ? "; " : ""}by email only: ${plan.emails.join(", ")}` : ""}
            </p>
          ) : (
            <p className="text-muted">Nobody listed here{placeholders ? " (besides the people named on each entry)" : ""}.</p>
          )}
          {placeholders > 0 && <p className="mt-0.5 text-muted">Plus whoever each entry names{route.to.some((t) => t.kind === "submitter") ? " and whoever filed it" : ""}.</p>}
          {plan.notes.filter((n) => !/^Nobody in|Nobody filed/.test(n)).map((n) => <p key={n} className="mt-0.5 text-status-amberText">{n}</p>)}
        </div>
      )}
    </div>
  );
}

// ── Pickers ──────────────────────────────────────────────────────────────

function SitesDialog({ open, sites, value, title, hint, onClose, onSave }: { open: boolean; sites: Site[]; value: string[]; title: string; hint: string; onClose: () => void; onSave: (v: string[]) => void }) {
  const [picked, setPicked] = useState<string[]>(value);
  useEffect(() => {
    if (open) setPicked(value);
  }, [open]); // eslint-disable-line react-hooks/exhaustive-deps
  return (
    <Dialog open={open} onOpenChange={(o) => !o && onClose()}>
      <DialogContent aria-describedby={undefined}>
        <DialogHeader title={title} subtitle={hint} />
        <DialogBody>
          <CheckboxList options={sites.map((s) => ({ value: s.code, label: s.name }))} value={picked} onChange={setPicked} className="max-h-[50vh] overflow-y-auto" />
        </DialogBody>
        <DialogFooter>
          <Button variant="secondary" onClick={() => setPicked([])}>Every site</Button>
          <Button onClick={() => { onSave(picked); onClose(); }}>Done</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

interface Person { id: string; name: string; email: string; roleName: string; status: string }

function PersonDialog({ open, sites, taken, onClose, onAdd }: { open: boolean; sites: Site[]; taken: Recipient[]; onClose: () => void; onAdd: (r: Recipient) => void }) {
  const [q, setQ] = useState("");
  const [search, setSearch] = useState("");
  const [only, setOnly] = useState<string[]>([]);
  const [showSites, setShowSites] = useState(false);
  useEffect(() => {
    const t = setTimeout(() => setSearch(q.trim()), 200);
    return () => clearTimeout(t);
  }, [q]);
  useEffect(() => {
    if (open) { setQ(""); setOnly([]); setShowSites(false); }
  }, [open]);
  const { data } = useQuery({ queryKey: ["routing-people", search], queryFn: () => api.get<Person[]>(`/routing/people?q=${encodeURIComponent(search)}`), enabled: open });
  const has = (email: string) => taken.some((t) => t.kind === "person" && t.email.toLowerCase() === email.toLowerCase());
  const typed = /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(q.trim()) ? q.trim().toLowerCase() : "";
  const pick = (email: string, name?: string) => {
    onAdd({ kind: "person", email: email.toLowerCase(), ...(name ? { name } : {}), ...(only.length ? { sites: only } : {}) });
    onClose();
  };
  const people = useMemo(() => data ?? [], [data]);
  return (
    <Dialog open={open} onOpenChange={(o) => !o && onClose()}>
      <DialogContent aria-describedby={undefined}>
        <DialogHeader title="Add someone" subtitle="Staff with an account are told in the app and by email. Anyone else gets an email with a link." />
        <DialogBody>
          <SearchInput value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search staff, or type an email address" className="!pl-9" autoFocus />
          <button type="button" onClick={() => setShowSites(!showSites)} className="mt-2 text-[12.5px] font-semibold text-accent">
            {only.length ? `Only for events at ${only.length} site${only.length === 1 ? "" : "s"}` : "Every site"} · change
          </button>
          {showSites && <CheckboxList options={sites.map((s) => ({ value: s.code, label: s.name }))} value={only} onChange={setOnly} className="mt-2 max-h-[180px] overflow-y-auto" />}
          {typed && !has(typed) && !people.some((p) => p.email.toLowerCase() === typed) && (
            <Button variant="secondary" className="mt-2 w-full" onClick={() => pick(typed)}><Plus className="h-4 w-4" /> Add {typed}</Button>
          )}
          <ul className="mt-2 max-h-[40vh] divide-y divide-hairline overflow-y-auto">
            {people.map((p) => (
              <li key={p.id}>
                <button type="button" disabled={has(p.email)} onClick={() => pick(p.email, p.name)} className="flex w-full items-center gap-3 py-2 text-left hover:bg-rowhover disabled:opacity-50">
                  <Avatar name={p.name} size={30} />
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-[13.5px] font-semibold text-ink">{p.name}</span>
                    <span className="block truncate text-[12px] text-muted">{p.roleName} · {p.email}{p.status !== "active" ? " · hasn't signed in yet" : ""}</span>
                  </span>
                  {has(p.email) ? <span className="text-[12px] text-muted">Added</span> : <Plus className="h-4 w-4 text-muted" />}
                </button>
              </li>
            ))}
          </ul>
        </DialogBody>
      </DialogContent>
    </Dialog>
  );
}

function RoleDialog({ open, roles, onClose, onAdd }: { open: boolean; roles: RoutingView["roles"]; onClose: () => void; onAdd: (r: Recipient) => void }) {
  const [role, setRole] = useState(roles.find((r) => r.key === "site_manager")?.key ?? roles[0]?.key ?? "");
  const [where, setWhere] = useState<"site" | "all">("site");
  const def = roles.find((r) => r.key === role);
  return (
    <Dialog open={open} onOpenChange={(o) => !o && onClose()}>
      <DialogContent aria-describedby={undefined}>
        <DialogHeader title="Everyone with a role" subtitle="Whoever holds the role when it's sent, so the list keeps itself up to date." />
        <DialogBody className="space-y-3">
          <Field label="Role">
            <Select value={role} onChange={(e) => setRole(e.target.value)} options={roles.map((r) => ({ value: r.key, label: r.name }))} />
          </Field>
          {def && !def.everySite && (
            <Field label="Where">
              <Select value={where} onChange={(e) => setWhere(e.target.value as "site" | "all")}>
                <option value="site">Only at the event's site</option>
                <option value="all">At every site</option>
              </Select>
            </Field>
          )}
        </DialogBody>
        <DialogFooter>
          <Button variant="secondary" onClick={onClose}>Cancel</Button>
          <Button onClick={() => { onAdd({ kind: "role", role, ...(where === "all" && !def?.everySite ? { siteOnly: false } : {}) }); onClose(); }}>Add</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/** Everyone in some staff groups: each group is a recipient, kept up to date as people join or leave it. */
function TeamDialog({ taken, onClose, onAdd }: { taken: Recipient[]; onClose: () => void; onAdd: (r: Recipient[]) => void }) {
  const { data: groups } = useStaffGroups();
  const { data: titles } = useJobTitles();
  const have = new Set(taken.flatMap((t) => (t.kind === "group" ? [t.group] : [])));
  const [picked, setPicked] = useState<string[]>([]);
  const [where, setWhere] = useState<"all" | "site">("all");
  const left = (groups ?? []).filter((g) => !have.has(g.id));
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent aria-describedby={undefined} className="w-[min(640px,calc(100vw-2rem))]">
        <DialogHeader title="Everyone in a group" subtitle="Whoever is in the group when it's sent, from their job title or added by hand." />
        <DialogBody className="max-h-[65vh] space-y-3 overflow-y-auto">
          {left.length ? (
            <GroupChecklist groups={left} titles={titles ?? []} value={picked} onChange={setPicked} />
          ) : (
            <p className="text-[13px] text-muted">{groups?.length ? "Every group is on this route already." : "No groups yet. Add them in People & roles → Groups."}</p>
          )}
          <Field label="Where">
            <Select value={where} onChange={(e) => setWhere(e.target.value as "all" | "site")}>
              <option value="all">Wherever they work</option>
              <option value="site">Only those at the event's site</option>
            </Select>
          </Field>
        </DialogBody>
        <DialogFooter>
          <Button variant="secondary" onClick={onClose}>Cancel</Button>
          <Button disabled={!picked.length} onClick={() => { onAdd(picked.map((group) => ({ kind: "group", group, ...(where === "site" ? { siteOnly: true } : {}) }))); onClose(); }}>Add</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/** Everyone with some positions (exact job titles), sorted under the groups they're in. */
function PositionDialog({ taken, onClose, onAdd }: { taken: Recipient[]; onClose: () => void; onAdd: (r: Recipient[]) => void }) {
  const { data: groups } = useStaffGroups();
  const { data: titles } = useJobTitles();
  const have = new Set(taken.flatMap((t) => (t.kind === "title" ? [t.title.toLowerCase()] : [])));
  const [picked, setPicked] = useState<string[]>([]);
  const [where, setWhere] = useState<"all" | "site">("all");
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent aria-describedby={undefined} className="w-[min(640px,calc(100vw-2rem))]">
        <DialogHeader title="Everyone with a position" subtitle="Whoever has that exact job title when it's sent." />
        <DialogBody className="max-h-[65vh] space-y-3 overflow-y-auto">
          <PositionsDropdown groups={groups ?? []} titles={(titles ?? []).filter((t) => !have.has(t.title.toLowerCase()))} value={picked} onChange={setPicked} />
          <Field label="Where">
            <Select value={where} onChange={(e) => setWhere(e.target.value as "all" | "site")}>
              <option value="all">Wherever they work</option>
              <option value="site">Only those at the event's site</option>
            </Select>
          </Field>
        </DialogBody>
        <DialogFooter>
          <Button variant="secondary" onClick={onClose}>Cancel</Button>
          <Button disabled={!picked.length} onClick={() => { onAdd(picked.map((title) => ({ kind: "title", title, ...(where === "site" ? { siteOnly: true } : {}) }))); onClose(); }}>Add</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

// ── What the email says ──────────────────────────────────────────────────

interface EmailPreview { subject: string; from: string; inside: string; outside: string }

/** A route's (or report's) "What to do" and "Answers in the email", with a preview of the email. */
function EmailParts({ whatToDo, fields, emailFields, onChange, preview, answersLabel = "Answers in the email" }: {
  whatToDo?: string;
  fields?: string[];
  emailFields: EmailField[];
  onChange: (patch: { whatToDo?: string; fields?: string[] }) => void;
  preview?: () => Promise<EmailPreview>;
  answersLabel?: string;
}) {
  const [shown, setShown] = useState<EmailPreview | null>(null);
  const [loading, setLoading] = useState(false);
  const toast = useToast();
  async function open() {
    if (!preview) return;
    setLoading(true);
    try {
      setShown(await preview());
    } catch (e) {
      toast(errorMessage(e, "Couldn't make the preview."), "error");
    } finally {
      setLoading(false);
    }
  }
  return (
    <>
      <Row label="What to do">
        <Textarea
          value={whatToDo ?? ""}
          onChange={(e) => onChange({ whatToDo: e.target.value || undefined })}
          rows={2}
          maxLength={500}
          placeholder="e.g. Review and sign within 24 hours."
          aria-label="What to do"
          className="max-w-[560px]"
        />
        <p className="mt-1 text-[12px] text-muted">Shown at the top of the email, so people know what's expected of them. No resident details.</p>
      </Row>
      <Row label={answersLabel}>
        <CheckboxList options={emailFields.map((f) => ({ value: f.id, label: f.label }))} value={fields ?? []} onChange={(v) => onChange({ fields: v.length ? v : undefined })} className="max-w-[560px]" />
        <p className="mt-1 text-[12px] text-muted">
          Shown to Lantern addresses only; anyone else gets the email without them. Residents, names, contact details, signatures, files and paragraphs can't be chosen.
        </p>
        {preview && (
          <Button type="button" variant="secondary" size="sm" className="mt-2" onClick={() => void open()} disabled={loading}>
            <Eye className="h-4 w-4" /> {loading ? "Making the preview…" : "Preview the email"}
          </Button>
        )}
      </Row>
      {shown && <EmailPreviewDialog preview={shown} onClose={() => setShown(null)} />}
    </>
  );
}

/** The email as a Lantern address gets it, and as anyone else does. */
function EmailPreviewDialog({ preview, onClose }: { preview: EmailPreview; onClose: () => void }) {
  const [who, setWho] = useState<"inside" | "outside">("inside");
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent aria-describedby={undefined} className="w-[min(780px,calc(100vw-2rem))]">
        <DialogHeader title={preview.subject} subtitle={preview.from} />
        <DialogBody className="space-y-3">
          <div className="inline-flex rounded-input border border-hairline p-0.5" role="radiogroup">
            {([["inside", "A Lantern address"], ["outside", "Anyone else"]] as const).map(([k, label]) => (
              <button
                key={k}
                type="button"
                role="radio"
                aria-checked={who === k}
                onClick={() => setWho(k)}
                className={cn("rounded-[5px] px-3 py-1.5 text-[13px] font-semibold", who === k ? "bg-navy text-white" : "text-muted hover:text-ink")}
              >
                {label}
              </button>
            ))}
          </div>
          <iframe title="Email preview" sandbox="" srcDoc={who === "inside" ? preview.inside : preview.outside} className="h-[560px] w-full rounded-input border border-hairline bg-white" />
        </DialogBody>
        <DialogFooter>
          <Button variant="secondary" onClick={onClose}>Close</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

// ── Follow-up ────────────────────────────────────────────────────────────

interface FollowUp {
  enabled: boolean;
  doers: Recipient[];
  remindAfterDays: number | null;
  maxReminders: number;
  tellSubmitter: boolean;
  whatToDo?: string;
  open?: number;
}

/**
 * Follow-up: each new entry stays open until someone it's for marks it done
 * (with what they did), whoever filed it is told, and the people it's for are
 * reminded until then. Saved on its own.
 */
function FollowUpSection({ formId, roles, sites }: { formId: string; roles: RoutingView["roles"]; sites: Site[] }) {
  const qc = useQueryClient();
  const toast = useToast();
  const key = ["routing", formId, "follow-up"];
  const { data } = useQuery({ queryKey: key, queryFn: () => api.get<FollowUp>(`/routing/${formId}/follow-up`) });
  const [f, setF] = useState<FollowUp | null>(null);
  const [busy, setBusy] = useState(false);
  const [picking, setPicking] = useState<null | "person" | "role" | "group" | "title">(null);
  useEffect(() => {
    if (data) setF(data);
  }, [data]);
  if (!data || !f) return null;
  const strip = ({ open: _o, ...x }: FollowUp & { updatedAt?: unknown; updatedByName?: unknown }) => {
    const { updatedAt: _a, updatedByName: _b, ...rest } = x;
    return rest;
  };
  const dirty = JSON.stringify(strip(f)) !== JSON.stringify(strip(data));
  const set = (patch: Partial<FollowUp>) => setF({ ...f, ...patch });
  const siteName = (code: string) => sites.find((s) => s.code === code)?.name ?? code;

  async function save() {
    if (f!.enabled && !f!.doers.length) return toast("Say who it's for: they mark entries done and get the reminders.", "error");
    setBusy(true);
    try {
      await api.put(`/routing/${formId}/follow-up`, strip(f!));
      toast(f!.enabled ? "Follow-up saved. New entries start open." : "Follow-up saved.");
      await qc.invalidateQueries({ queryKey: key });
    } catch (e) {
      toast(errorMessage(e, "Couldn't save the follow-up."), "error");
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="mb-6 mt-8">
      <div className="mb-2 px-1">
        <p className="font-heading text-[15px] font-extrabold text-ink">Follow-up</p>
        <p className="text-[12.5px] text-muted">Keep each new entry open until the people it's for mark it done, with what they did. Whoever filed it is told, and they're reminded until it's done.</p>
      </div>
      <Card className={cn("p-0", !f.enabled && "opacity-80")}>
        <div className="flex items-center gap-3 border-b border-hairline px-4 py-3 md:px-5">
          <Switch checked={f.enabled} onCheckedChange={(v) => set({ enabled: v })} aria-label="Track follow-ups" />
          <p className="min-w-0 flex-1 text-[14px] font-semibold text-ink">{f.enabled ? "Entries are followed up" : "Not followed up"}</p>
          {f.enabled && typeof data.open === "number" && <Tag tone={data.open ? "amber" : "neutral"}>{data.open} open</Tag>}
        </div>
        {f.enabled && (
          <div className="grid gap-4 px-4 py-4 md:px-5">
            <Row label="Who does it">
              <ul className="divide-y divide-hairline rounded-input border border-hairline">
                {f.doers.map((t, i) => (
                  <RecipientRow key={i} r={t} event={REPORT_EVENT} roles={roles} siteName={siteName} onChange={(next) => set({ doers: next ? f.doers.map((x, j) => (j === i ? next : x)) : f.doers.filter((_, j) => j !== i) })} />
                ))}
                {!f.doers.length && <li className="px-3 py-2 text-[13px] text-muted">Nobody yet.</li>}
              </ul>
              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <Button variant="ghost" size="sm" className="mt-1"><Plus className="h-4 w-4" /> Add people</Button>
                </DropdownMenuTrigger>
                <DropdownMenuContent align="start">
                  <DropdownMenuItem onSelect={() => setPicking("person")}><User className="h-4 w-4" /> Someone by name or email</DropdownMenuItem>
                  <DropdownMenuItem onSelect={() => setPicking("role")}><Users className="h-4 w-4" /> Everyone with a role</DropdownMenuItem>
                  <DropdownMenuItem onSelect={() => setPicking("group")}><UsersRound className="h-4 w-4" /> Everyone in a group</DropdownMenuItem>
                  <DropdownMenuItem onSelect={() => setPicking("title")}><Briefcase className="h-4 w-4" /> Everyone with a position</DropdownMenuItem>
                </DropdownMenuContent>
              </DropdownMenu>
              <p className="mt-1 text-[12px] text-muted">They can mark entries done and get the reminders. Admins always can.</p>
            </Row>
            <Row label="Reminders">
              <div className="flex flex-wrap items-center gap-2">
                <Select
                  value={f.remindAfterDays === null ? "never" : String(f.remindAfterDays)}
                  onChange={(e) => set({ remindAfterDays: e.target.value === "never" ? null : Number(e.target.value) })}
                  className="w-56"
                  aria-label="Remind after"
                  options={[{ value: "never", label: "Never remind" }, ...[1, 2, 3, 5, 7, 14].map((d) => ({ value: String(d), label: `After ${d} day${d === 1 ? "" : "s"}, then every ${d}` }))]}
                />
                {f.remindAfterDays !== null && (
                  <Select value={String(f.maxReminders)} onChange={(e) => set({ maxReminders: Number(e.target.value) })} className="w-40" aria-label="At most" options={[1, 2, 3, 5, 10].map((n) => ({ value: String(n), label: `At most ${n}` }))} />
                )}
              </div>
            </Row>
            <Row label="When it's done">
              <label className="flex items-center gap-2 pt-1 text-[13px] text-ink">
                <Switch checked={f.tellSubmitter} onCheckedChange={(v) => set({ tellSubmitter: v })} />
                Tell whoever filed it, with the note of what was done
              </label>
            </Row>
            <Row label="What to do">
              <Textarea value={f.whatToDo ?? ""} onChange={(e) => set({ whatToDo: e.target.value || undefined })} rows={2} maxLength={500} placeholder="e.g. Set up their accounts, then mark it done." className="max-w-[560px]" />
              <p className="mt-1 text-[12px] text-muted">Shown in the reminder emails.</p>
            </Row>
            <p className="text-[12px] text-muted">Applies to entries saved after it's turned on.</p>
          </div>
        )}
      </Card>
      {dirty && (
        <div className="mt-3 flex items-center justify-end gap-2">
          <span className="mr-auto text-[13px] font-semibold text-ink">Unsaved follow-up changes</span>
          <Button variant="secondary" onClick={() => setF(data)} disabled={busy}>Undo</Button>
          <Button onClick={() => void save()} disabled={busy}>{busy ? "Saving…" : "Save follow-up"}</Button>
        </div>
      )}
      <PersonDialog open={picking === "person"} sites={sites} taken={f.doers} onClose={() => setPicking(null)} onAdd={(r) => set({ doers: [...f.doers, r] })} />
      <RoleDialog open={picking === "role"} roles={roles} onClose={() => setPicking(null)} onAdd={(r) => set({ doers: [...f.doers, r] })} />
      {picking === "group" && <TeamDialog taken={f.doers} onClose={() => setPicking(null)} onAdd={(rs) => set({ doers: [...f.doers, ...rs] })} />}
      {picking === "title" && <PositionDialog taken={f.doers} onClose={() => setPicking(null)} onAdd={(rs) => set({ doers: [...f.doers, ...rs] })} />}
    </section>
  );
}

// ── Weekly summary reports ───────────────────────────────────────────────

interface Report {
  id: string;
  name: string;
  enabled: boolean;
  day: number;
  hour: number;
  split: "all" | "site";
  includeEmpty: boolean;
  fields: string[];
  to: Recipient[];
  whatToDo?: string;
  lastSentAt?: string | null;
  nextRun?: string | null;
}

interface ReportsView { reports: Report[]; revision: number }

interface ReportRun {
  sent: number;
  emails: { to: string; subject: string; site: string; entries: number; withAnswers: boolean }[];
  notes: string[];
  preview: string | null;
}

const DAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
const hourLabel = (h: number) => `${h % 12 === 0 ? 12 : h % 12}:00 ${h < 12 ? "AM" : "PM"}`;
/** For a recipient row: reports have no event of their own. */
const REPORT_EVENT: RoutingEvent = { id: "entry.created", label: "Summary report" };
const strip = ({ nextRun: _n, lastSentAt: _l, ...r }: Report) => r;

/**
 * The form's weekly summary reports: the past week's entries, emailed on a day
 * and time to the same kinds of people a route reaches, for every site or one
 * per site. Saved apart from the routes, with their own Save.
 */
function ReportsSection({ formId, emailFields, roles, sites }: { formId: string; emailFields: EmailField[]; roles: RoutingView["roles"]; sites: Site[] }) {
  const qc = useQueryClient();
  const toast = useToast();
  const key = ["routing", formId, "reports"];
  const { data } = useQuery({ queryKey: key, queryFn: () => api.get<ReportsView>(`/routing/${formId}/reports`) });
  const [reports, setReports] = useState<Report[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [run, setRun] = useState<ReportRun | null>(null);
  useEffect(() => {
    if (data) setReports(data.reports);
  }, [data]);
  if (!data || !reports) return null;
  const dirty = JSON.stringify(reports.map(strip)) !== JSON.stringify(data.reports.map(strip));

  const change = (rid: string, next: Report | null) => setReports(next ? reports.map((r) => (r.id === rid ? next : r)) : reports.filter((r) => r.id !== rid));
  const add = () =>
    setReports([
      ...reports,
      { id: uniqueId(reports.map((r) => r.id), "weekly-report"), name: "Weekly report", enabled: true, day: 1, hour: 8, split: "all", includeEmpty: false, fields: ["_site", "_date"], to: [] },
    ]);

  async function save() {
    const empty = reports!.find((r) => !r.to.length);
    if (empty) return toast(`“${empty.name}” goes to nobody. Add someone, or remove it.`, "error");
    setBusy(true);
    try {
      await api.put(`/routing/${formId}/reports`, { reports: reports!.map(strip), revision: data!.revision });
      toast("Reports saved.");
      await qc.invalidateQueries({ queryKey: key });
    } catch (e) {
      toast(errorMessage(e, "Couldn't save the reports."), "error");
    } finally {
      setBusy(false);
    }
  }

  async function preview(r: Report) {
    try {
      setRun(await api.post<ReportRun>(`/routing/${formId}/reports/preview`, { report: strip(r) }));
    } catch (e) {
      toast(errorMessage(e, "Couldn't make the preview."), "error");
    }
  }

  async function sendNow(r: Report) {
    if (!window.confirm(`Send “${r.name}” now? It still goes at its usual time too.`)) return;
    try {
      const out = await api.post<ReportRun>(`/routing/${formId}/reports/${r.id}/send`, {});
      toast(out.sent ? `Sent to ${out.sent} ${out.sent === 1 ? "person" : "people"}.` : out.notes[0] ?? "Nothing was sent.");
      await qc.invalidateQueries({ queryKey: ["routing", formId, "emails"] });
    } catch (e) {
      toast(errorMessage(e, "Couldn't send it."), "error");
    }
  }

  return (
    <section className="mb-6 mt-8">
      <div className="mb-2 flex items-end gap-3 px-1">
        <div className="min-w-0 flex-1">
          <p className="font-heading text-[15px] font-extrabold text-ink">Weekly summary reports</p>
          <p className="text-[12.5px] text-muted">The past week's entries, emailed on a day and time: a count, a table of the answers you choose (Lantern addresses only), and a button to the entries.</p>
        </div>
        <Button variant="secondary" size="sm" onClick={add}><Plus className="h-4 w-4" /> Add a report</Button>
      </div>
      {reports.length ? (
        <div className="space-y-3">
          {reports.map((r) => (
            <ReportCard
              key={r.id}
              report={r}
              saved={data.reports.some((x) => x.id === r.id)}
              emailFields={emailFields}
              roles={roles}
              sites={sites}
              onChange={(next) => change(r.id, next)}
              onPreview={() => void preview(r)}
              onSend={() => void sendNow(r)}
            />
          ))}
        </div>
      ) : (
        <p className="rounded-card border border-dashed border-hairline px-4 py-3 text-[13px] text-muted">No summary reports.</p>
      )}
      {dirty && (
        <div className="mt-3 flex items-center justify-end gap-2">
          <span className="mr-auto text-[13px] font-semibold text-ink">Unsaved report changes</span>
          <Button variant="secondary" onClick={() => setReports(data.reports)} disabled={busy}>Undo</Button>
          <Button onClick={() => void save()} disabled={busy}>{busy ? "Saving…" : "Save reports"}</Button>
        </div>
      )}
      {run && <ReportRunDialog run={run} onClose={() => setRun(null)} />}
    </section>
  );
}

function ReportCard({ report, saved, emailFields, roles, sites, onChange, onPreview, onSend }: {
  report: Report;
  saved: boolean;
  emailFields: EmailField[];
  roles: RoutingView["roles"];
  sites: Site[];
  onChange: (r: Report | null) => void;
  onPreview: () => void;
  onSend: () => void;
}) {
  const [picking, setPicking] = useState<null | "person" | "role" | "group" | "title">(null);
  const set = (patch: Partial<Report>) => onChange({ ...report, ...patch });
  const siteName = (code: string) => sites.find((s) => s.code === code)?.name ?? code;
  return (
    <Card className={cn("p-0", !report.enabled && "opacity-70")}>
      <div className="flex items-center gap-3 border-b border-hairline px-4 py-3 md:px-5">
        <Switch checked={report.enabled} onCheckedChange={(v) => set({ enabled: v })} aria-label={report.enabled ? "Turn this report off" : "Turn this report on"} />
        <Mail className="h-4 w-4 shrink-0 text-muted" />
        <input value={report.name} onChange={(e) => set({ name: e.target.value })} aria-label="Report name" className="min-w-0 flex-1 bg-transparent font-heading text-[15px] font-extrabold text-ink outline-none focus:underline" />
        <Button variant="ghost" size="icon" aria-label="Remove report" onClick={() => onChange(null)}><Trash2 className="h-4 w-4" /></Button>
      </div>
      <div className="grid gap-4 px-4 py-4 md:px-5">
        <Row label="When">
          <div className="flex flex-wrap items-center gap-2">
            <Select value={String(report.day)} onChange={(e) => set({ day: Number(e.target.value) })} className="w-40" aria-label="Day" options={DAYS.map((d, i) => ({ value: String(i), label: `Every ${d}` }))} />
            <Select value={String(report.hour)} onChange={(e) => set({ hour: Number(e.target.value) })} className="w-32" aria-label="Time" options={Array.from({ length: 24 }, (_, h) => ({ value: String(h), label: hourLabel(h) }))} />
            <span className="text-[12px] text-muted">New York time{report.nextRun && saved ? ` · next ${formatDateTime(report.nextRun)}` : ""}{report.lastSentAt ? ` · last sent ${relativeTime(report.lastSentAt)}` : ""}</span>
          </div>
        </Row>
        <Row label="Sites">
          <Select value={report.split} onChange={(e) => set({ split: e.target.value as Report["split"] })} className="max-w-[420px]" aria-label="Sites">
            <option value="all">One report for every site</option>
            <option value="site">One report per site, to that site's people</option>
          </Select>
          <label className="mt-2 flex items-center gap-2 text-[13px] text-ink">
            <Switch checked={report.includeEmpty} onCheckedChange={(v) => set({ includeEmpty: v })} />
            Send it even when there were no entries
          </label>
        </Row>
        <Row label="Send to">
          <ul className="divide-y divide-hairline rounded-input border border-hairline">
            {report.to.map((t, i) => (
              <RecipientRow key={i} r={t} event={REPORT_EVENT} roles={roles} siteName={siteName} onChange={(next) => set({ to: next ? report.to.map((x, j) => (j === i ? next : x)) : report.to.filter((_, j) => j !== i) })} />
            ))}
            {!report.to.length && <li className="px-3 py-2 text-[13px] text-muted">Nobody yet.</li>}
          </ul>
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button variant="ghost" size="sm" className="mt-1"><Plus className="h-4 w-4" /> Add people</Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="start">
              <DropdownMenuItem onSelect={() => setPicking("person")}><User className="h-4 w-4" /> Someone by name or email</DropdownMenuItem>
              <DropdownMenuItem onSelect={() => setPicking("role")}><Users className="h-4 w-4" /> Everyone with a role</DropdownMenuItem>
              <DropdownMenuItem onSelect={() => setPicking("group")}><UsersRound className="h-4 w-4" /> Everyone in a group</DropdownMenuItem>
              <DropdownMenuItem onSelect={() => setPicking("title")}><Briefcase className="h-4 w-4" /> Everyone with a position</DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        </Row>
        <EmailParts
          whatToDo={report.whatToDo}
          fields={report.fields}
          emailFields={emailFields}
          answersLabel="Columns"
          onChange={(patch) => set({ ...(patch.whatToDo !== undefined || "whatToDo" in patch ? { whatToDo: patch.whatToDo } : {}), ...("fields" in patch ? { fields: patch.fields ?? [] } : {}) })}
        />
        <div className="flex flex-wrap gap-2">
          <Button type="button" variant="secondary" size="sm" onClick={onPreview} disabled={!report.to.length}><Eye className="h-4 w-4" /> Preview this week's report</Button>
          {saved && <Button type="button" variant="secondary" size="sm" onClick={onSend}><Send className="h-4 w-4" /> Send now</Button>}
        </div>
      </div>
      <PersonDialog open={picking === "person"} sites={sites} taken={report.to} onClose={() => setPicking(null)} onAdd={(r) => set({ to: [...report.to, r] })} />
      <RoleDialog open={picking === "role"} roles={roles} onClose={() => setPicking(null)} onAdd={(r) => set({ to: [...report.to, r] })} />
      {picking === "group" && <TeamDialog taken={report.to} onClose={() => setPicking(null)} onAdd={(rs) => set({ to: [...report.to, ...rs] })} />}
      {picking === "title" && <PositionDialog taken={report.to} onClose={() => setPicking(null)} onAdd={(rs) => set({ to: [...report.to, ...rs] })} />}
    </Card>
  );
}

/** Who a report would go to now, per site, and the email itself. Nothing was sent. */
function ReportRunDialog({ run, onClose }: { run: ReportRun; onClose: () => void }) {
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent aria-describedby={undefined} className="w-[min(780px,calc(100vw-2rem))]">
        <DialogHeader title="This week's report" subtitle="A preview: nothing was sent." />
        <DialogBody className="max-h-[72vh] space-y-3 overflow-y-auto">
          {run.emails.length ? (
            <ul className="divide-y divide-hairline rounded-input border border-hairline text-[13px]">
              {run.emails.map((e, i) => (
                <li key={i} className="flex flex-wrap items-center gap-x-3 gap-y-1 px-3 py-2">
                  <span className="min-w-0 flex-1 truncate font-semibold text-ink">{e.to}</span>
                  <span className="text-muted">{e.site} · {e.entries} {e.entries === 1 ? "entry" : "entries"}</span>
                  <Tag tone={e.withAnswers ? "accent" : "neutral"}>{e.withAnswers ? "With the table" : "Count and link only"}</Tag>
                </li>
              ))}
            </ul>
          ) : (
            <p className="text-[13px] text-muted">It wouldn't send anything this week{run.notes.length ? "" : ": there were no entries"}.</p>
          )}
          {run.notes.map((n, i) => <p key={i} className="text-[12.5px] text-status-amberText">{n}</p>)}
          {run.preview && <iframe title="Report preview" sandbox="" srcDoc={run.preview} className="h-[520px] w-full rounded-input border border-hairline bg-white" />}
        </DialogBody>
        <DialogFooter>
          <Button variant="secondary" onClick={onClose}>Close</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

// ── Emails sent ──────────────────────────────────────────────────────────

interface SentEmail { id: string; createdAt: string; to: string; subject: string; kind: string; status: string; error: string | null; withAnswers: boolean }

const KIND_LABEL: Record<string, string> = { notification: "Notification", digest: "Daily summary", route: "Routing", rule: "Form rule", report: "Summary report", code: "Code form" };

/** The emails this form has sent: to whom, what, and whether it went. */
function SentEmails({ formId }: { formId: string }) {
  const { data } = useQuery({ queryKey: ["routing", formId, "emails"], queryFn: () => api.get<{ items: SentEmail[] }>(`/routing/${formId}/emails?limit=50`) });
  const items = data?.items ?? [];
  return (
    <section className="mt-8">
      <p className="mb-2 px-1 font-heading text-[15px] font-extrabold text-ink">Emails sent</p>
      <Card className="p-0">
        {items.length ? (
          <ul className="divide-y divide-hairline">
            {items.map((e) => (
              <li key={e.id} className="px-4 py-2.5 md:px-5">
                <div className="flex flex-wrap items-baseline gap-x-2">
                  <span className="min-w-0 flex-1 truncate text-[13.5px] font-semibold text-ink">{e.subject}</span>
                  <span className="text-[12px] text-muted" title={formatDateTime(e.createdAt)}>{relativeTime(e.createdAt)}</span>
                </div>
                <div className="mt-0.5 flex flex-wrap items-center gap-1.5 text-[12px] text-muted">
                  <span className="truncate">{e.to}</span>
                  <span>· {KIND_LABEL[e.kind] ?? e.kind}</span>
                  <Tag tone={e.status === "sent" ? "accent" : e.status === "failed" ? "red" : "neutral"}>{e.status === "sent" ? "Sent" : e.status === "failed" ? "Failed" : "Not sent"}</Tag>
                  {e.withAnswers && <Tag tone="neutral">With answers</Tag>}
                </div>
                {e.error && <p className="mt-0.5 text-[12px] text-status-redText">{e.error}</p>}
              </li>
            ))}
          </ul>
        ) : (
          <p className="px-4 py-3 text-[13px] text-muted md:px-5">No emails yet.</p>
        )}
      </Card>
    </section>
  );
}

// ── What was sent ────────────────────────────────────────────────────────

function RecentSends({ items }: { items: LogItem[] }) {
  if (!items.length) return null;
  return (
    <section className="mt-8">
      <p className="mb-2 px-1 font-heading text-[15px] font-extrabold text-ink">Recently sent</p>
      <Card className="p-0">
        <ul className="divide-y divide-hairline">
          {items.map((l) => (
            <li key={l.id} className="px-4 py-2.5 md:px-5">
              <div className="flex flex-wrap items-baseline gap-x-2">
                <span className="text-[13.5px] font-semibold text-ink">{l.title || l.event}</span>
                <span className="text-[12px] text-muted" title={formatDateTime(l.at)}>{relativeTime(l.at)}</span>
              </div>
              {l.routes.map((p, i) => (
                <p key={i} className="text-[12.5px] text-muted">
                  <span className="font-semibold text-ink">{p.routeName}</span> → {[...p.people.map((x) => x.name), ...p.emails].join(", ") || "nobody"}
                  {p.notes.length ? <span className="text-status-amberText"> · {p.notes.join(" ")}</span> : null}
                </p>
              ))}
              {l.failures?.map((f) => <p key={f} className="text-[12.5px] text-status-redText">{f}</p>)}
            </li>
          ))}
        </ul>
      </Card>
    </section>
  );
}
