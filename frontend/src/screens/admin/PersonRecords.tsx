import { useState } from "react";
import { Link, useParams } from "react-router-dom";
import { useInfiniteQuery } from "@tanstack/react-query";
import { ExternalLink } from "lucide-react";
import { Page, PageHeader, DesktopBackLink } from "@/components/shell/AppShell";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Chip } from "@/components/ui/chip";
import { Select } from "@/components/ui/select";
import { Tag, ToneBadge } from "@/components/ui/badge";
import { EmptyState, LoadingState } from "@/components/ui/misc";
import { api } from "@/lib/api";
import { cn, errorMessage, formatDateTime, relativeTime } from "@/lib/utils";

/**
 * People & roles → a person → Records (Super Admins): everything they filed,
 * the follow-ups they did and the ones waiting on them, what they were told
 * and emailed, what they changed, and which forms they can open and how much
 * of each form's entries they see (backend services/personRecords.ts).
 * Entries are listed here and open on their own pages.
 */

interface Records {
  person: { id: string; name: string; email: string; title: string | null; role: string; status: string; sites: string[]; groups: string[]; lastSignInAt: string | null; createdAt: string; active: boolean };
  entries: {
    items: { id: string; createdAt: string; site: string | null; status: string; followUp: "open" | "done" | null; form: { id: string; slug: string; title: string; kind: string }; url: string }[];
    nextBefore: string | null;
    perForm: { formId: string; title: string; count: number }[];
  };
  followUps: {
    done: { id: string; doneAt: string | null; note: string | null; filedBy: string; form: { title: string }; url: string }[];
    waiting: { id: string; form: { title: string }; createdAt: string; createdByName: string; url: string }[];
  };
  notifications: { id: string; title: string; sourceLabel: string | null; createdAt: string; readAt: string | null; urgent: boolean; emailStatus: string; link: string | null }[];
  emails: { id: string; createdAt: string; subject: string; kind: string; status: string; error: string | null; withAnswers: boolean }[];
  activity: { id: string; action: string; summary: string; createdAt: string }[];
  access: { id: string; slug: string; title: string; kind: string; canOpen: boolean; entries: "all" | "site" | "own" | null }[];
}

type Section = "entries" | "followups" | "notifications" | "emails" | "activity" | "access";

const REACH: Record<string, string> = { all: "Every entry", site: "Their sites' entries", own: "Only their own" };

export function PersonRecordsPage() {
  const { id = "" } = useParams();
  const [form, setForm] = useState("");
  const [section, setSection] = useState<Section>("entries");
  const q = useInfiniteQuery({
    queryKey: ["admin", "records", id, form],
    initialPageParam: null as string | null,
    queryFn: ({ pageParam }) => api.get<Records>(`/users/${encodeURIComponent(id)}/records?${new URLSearchParams({ ...(form ? { form } : {}), ...(pageParam ? { before: pageParam } : {}) })}`),
    getNextPageParam: (last) => last.entries.nextBefore,
  });

  if (q.isLoading) return <LoadingState />;
  if (q.error || !q.data) return <Page><Card><EmptyState title={errorMessage(q.error, "Couldn't load their records.")} /></Card></Page>;
  const first = q.data.pages[0];
  const p = first.person;
  const entries = q.data.pages.flatMap((x) => x.entries.items);
  const total = first.entries.perForm.reduce((n, f) => n + f.count, 0);
  const counts: Record<Section, number> = {
    entries: total,
    followups: first.followUps.waiting.length + first.followUps.done.length,
    notifications: first.notifications.length,
    emails: first.emails.length,
    activity: first.activity.length,
    access: first.access.filter((a) => a.canOpen).length,
  };

  return (
    <Page className="max-w-[1000px]">
      <DesktopBackLink to="/admin/people">People &amp; roles</DesktopBackLink>
      <PageHeader
        title={`${p.name}: records`}
        help={{ article: "admin-records", text: "Everything this person filed, was told and did, and which forms they can open. Super Admins only; it changes nothing." }}
        subtitle={[p.title, p.role, p.email].filter(Boolean).join(" · ")}
      />
      <Card className="mb-4 grid gap-3 p-4 text-[13px] sm:grid-cols-2 lg:grid-cols-4">
        <Meta label="Sites" value={p.sites.join(", ") || "None"} />
        <Meta label="Groups" value={p.groups.join(", ") || "None"} />
        <Meta label="Last signed in" value={p.lastSignInAt ? formatDateTime(p.lastSignInAt) : "Never"} />
        <Meta label="Status" value={p.active ? "Active" : p.status} />
      </Card>

      <div className="mb-4 flex flex-wrap gap-1.5">
        {([["entries", "Entries"], ["followups", "Follow-ups"], ["notifications", "Notifications"], ["emails", "Emails"], ["activity", "Activity"], ["access", "Forms they can open"]] as const).map(([k, label]) => (
          <Chip key={k} active={section === k} onClick={() => setSection(k)}>
            {label}{counts[k] ? ` · ${counts[k]}` : ""}
          </Chip>
        ))}
      </div>

      {section === "entries" && (
        <Card className="p-0">
          <div className="flex flex-wrap items-center gap-2 border-b border-hairline px-4 py-3">
            <p className="mr-auto text-[13px] text-muted">{total} entr{total === 1 ? "y" : "ies"} filed, newest first. Each opens on its own page.</p>
            <div className="w-[260px]">
              <Select value={form} onChange={(e) => setForm(e.target.value)} aria-label="Form" options={[{ value: "", label: "Every form" }, ...first.entries.perForm.map((f) => ({ value: f.formId, label: `${f.title} (${f.count})` }))]} />
            </div>
          </div>
          {entries.length ? (
            <ul className="divide-y divide-hairline">
              {entries.map((e) => (
                <li key={e.id}>
                  <Link to={e.url} className="flex flex-wrap items-center gap-x-3 gap-y-1 px-4 py-2.5 hover:bg-rowhover">
                    <span className="min-w-0 flex-1 truncate text-[13.5px] font-semibold text-ink">{e.form.title}</span>
                    <span className="text-[12px] text-muted">{e.site ?? "No site"}</span>
                    <span className="w-[150px] text-right text-[12px] text-muted" title={formatDateTime(e.createdAt)}>{formatDateTime(e.createdAt)}</span>
                    {e.status === "voided" && <ToneBadge tone="red">Void</ToneBadge>}
                    {e.followUp && <ToneBadge tone={e.followUp === "open" ? "amber" : "green"}>{e.followUp === "open" ? "Open" : "Done"}</ToneBadge>}
                  </Link>
                </li>
              ))}
            </ul>
          ) : (
            <EmptyState title="No entries" hint="They haven't filed any entries yet." />
          )}
          {q.hasNextPage && (
            <div className="border-t border-hairline px-4 py-3 text-center">
              <Button variant="secondary" size="sm" onClick={() => void q.fetchNextPage()} disabled={q.isFetchingNextPage}>{q.isFetchingNextPage ? "Loading…" : "Older entries"}</Button>
            </div>
          )}
        </Card>
      )}

      {section === "followups" && (
        <div className="space-y-4">
          <List title="Waiting on them" empty="Nothing waiting on them.">
            {first.followUps.waiting.map((w) => (
              <Row key={w.id} to={w.url} title={w.form.title} meta={`Filed by ${w.createdByName}, ${relativeTime(w.createdAt)}`} badge={<ToneBadge tone="amber">Open</ToneBadge>} />
            ))}
          </List>
          <List title="Done by them" empty="They haven't marked any done.">
            {first.followUps.done.map((d) => (
              <Row key={d.id} to={d.url} title={d.form.title} meta={[`Filed by ${d.filedBy}`, d.doneAt ? `done ${relativeTime(d.doneAt)}` : null, d.note].filter(Boolean).join(" · ")} badge={<ToneBadge tone="green">Done</ToneBadge>} />
            ))}
          </List>
        </div>
      )}

      {section === "notifications" && (
        <List title="Latest notifications" empty="No notifications.">
          {first.notifications.map((n) => (
            <Row
              key={n.id}
              to={n.link}
              title={n.title}
              meta={[n.sourceLabel, relativeTime(n.createdAt), n.readAt ? "read" : "not read yet", n.emailStatus !== "none" ? `email ${n.emailStatus}` : null].filter(Boolean).join(" · ")}
              badge={n.urgent ? <Tag tone="red">Urgent</Tag> : null}
            />
          ))}
        </List>
      )}

      {section === "emails" && (
        <List title="Emails sent to them" empty="No emails logged.">
          {first.emails.map((m) => (
            <Row
              key={m.id}
              title={m.subject}
              meta={[relativeTime(m.createdAt), m.kind, m.withAnswers ? "with answers" : null, m.error].filter(Boolean).join(" · ")}
              badge={<Tag tone={m.status === "sent" ? "accent" : m.status === "failed" ? "red" : "neutral"}>{m.status === "sent" ? "Sent" : m.status === "failed" ? "Failed" : "Not sent"}</Tag>}
            />
          ))}
        </List>
      )}

      {section === "activity" && (
        <List title="What they changed" empty="Nothing in the audit log.">
          {first.activity.map((a) => (
            <Row key={a.id} title={a.summary} meta={`${a.action} · ${formatDateTime(a.createdAt)}`} />
          ))}
        </List>
      )}

      {section === "access" && (
        <Card className="p-0">
          {!p.active && <p className="border-b border-hairline px-4 py-3 text-[13px] text-muted">They don't have access right now, so they can't open any form.</p>}
          <ul className="divide-y divide-hairline">
            {first.access.map((a) => (
              <li key={a.id} className={cn("flex flex-wrap items-center gap-x-3 gap-y-1 px-4 py-2.5", !a.canOpen && "opacity-60")}>
                <span className="min-w-0 flex-1 truncate text-[13.5px] font-semibold text-ink">{a.title}</span>
                <span className="text-[12px] text-muted">{a.canOpen ? `Entries: ${REACH[a.entries ?? "own"]}` : "Can't open it"}</span>
                <Link to={a.kind === "code" ? `/admin/apps/${a.id}` : `/admin/builder/${a.id}`} className="inline-flex items-center gap-1 text-[12.5px] font-semibold text-accent dark:text-white">
                  Settings <ExternalLink className="h-3 w-3" />
                </Link>
              </li>
            ))}
          </ul>
        </Card>
      )}
    </Page>
  );
}

function Meta({ label, value }: { label: string; value: string }) {
  return (
    <div className="min-w-0">
      <p className="text-micro font-bold uppercase tracking-[0.04em] text-muted">{label}</p>
      <p className="mt-0.5 truncate text-ink" title={value}>{value}</p>
    </div>
  );
}

function List({ title, empty, children }: { title: string; empty: string; children: React.ReactNode }) {
  const items = Array.isArray(children) ? children.filter(Boolean) : children ? [children] : [];
  return (
    <section>
      <p className="mb-2 px-1 font-heading text-[15px] font-extrabold text-ink">{title}</p>
      <Card className="p-0">{items.length ? <ul className="divide-y divide-hairline">{children}</ul> : <p className="px-4 py-3 text-[13px] text-muted">{empty}</p>}</Card>
    </section>
  );
}

function Row({ to, title, meta, badge }: { to?: string | null; title: string; meta: string; badge?: React.ReactNode }) {
  const inner = (
    <>
      <span className="min-w-0 flex-1">
        <span className="block truncate text-[13.5px] font-semibold text-ink">{title}</span>
        <span className="block truncate text-[12px] text-muted">{meta}</span>
      </span>
      {badge}
    </>
  );
  return (
    <li>
      {to ? (
        <Link to={to} className="flex items-center gap-3 px-4 py-2.5 hover:bg-rowhover">{inner}</Link>
      ) : (
        <div className="flex items-center gap-3 px-4 py-2.5">{inner}</div>
      )}
    </li>
  );
}
