import { useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { Bell, ChevronDown, ChevronRight, ClipboardList, PenLine, Plus, QrCode } from "lucide-react";
import { Page, PageHeader } from "@/components/shell/AppShell";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Tag } from "@/components/ui/badge";
import { EmptyState, LoadingState } from "@/components/ui/misc";
import { ShareSettings } from "@/components/ShareSettings";
import { api } from "@/lib/api";
import type { SharingSettings } from "@/screens/builtforms/SharePage";

/**
 * Admin → External forms: everything about forms people outside Lantern fill
 * in through an employee's own link or QR code (backend services/shareLinks.ts).
 * Making one, the steps to get it out, and for each form: its links and QR
 * code, its entries, who's told, its sharing settings and everyone's links
 * (turn any off). Was "Share links"; /admin/share-links still lands here.
 */

interface LinkForm {
  form: { id: string; slug: string; title: string; status: string; kind?: "basic" | "code" };
  /** The published version is shared by link (else only the draft is, so links don't work yet). */
  live: boolean;
  settings: SharingSettings;
  working: number;
  entries: number;
  mine: boolean;
}

const NEW_EXTERNAL = "/admin/builder?new=external";

const STEPS: { title: string; body: React.ReactNode }[] = [
  {
    title: "Make the form",
    body: (
      <>
        <b>New external form</b> starts one set for people outside Lantern, from a blank form or a template. To turn a form you already have into one: its <b>Settings → Who can fill it in → Anyone with a share link</b>.
      </>
    ),
  },
  { title: "Publish it", body: <>Links only work on the published version. Until then it shows here as <b>Not published as shared yet</b>.</> },
  {
    title: "Hand it out",
    body: (
      <>
        You, and every employee who can open the form, get your own link and QR code (<b>My link and QR code</b>, or <b>Share it</b> on the form). Send the link, or print or show the QR code. Links last 90 days unless you set otherwise, and refreshing one stops the old one.
      </>
    ),
  },
  {
    title: "See what comes back",
    body: (
      <>
        Entries come to Lantern, each saying whose link it came through, and that person sees it. <b>Who's told</b> sets who's notified: “Whoever shared the link” tells the employee.
      </>
    ),
  },
];

export function AdminShareLinks() {
  const navigate = useNavigate();
  const { data, isLoading } = useQuery({ queryKey: ["share", "all"], queryFn: () => api.get<{ forms: LinkForm[] }>("/share/all/forms") });
  const [open, setOpen] = useState<string | null>(null);
  if (isLoading || !data) return <LoadingState />;

  return (
    <Page className="max-w-[960px]">
      <PageHeader
        title="External forms"
        subtitle="Forms people outside Lantern fill in, handed out by each employee with their own link or QR code."
        help={{ article: "share-links", text: "Make a form for people outside Lantern, publish it, and hand it out with your link and QR code. Every external form's links, entries and settings are here." }}
        actions={<Button onClick={() => navigate(NEW_EXTERNAL)}><Plus className="h-4 w-4" /> New external form</Button>}
      />

      <Card className="mb-5 p-5">
        <h2 className="font-heading text-[16px] font-extrabold text-ink">How it works</h2>
        <ol className="mt-3 grid gap-3 md:grid-cols-2">
          {STEPS.map((s, i) => (
            <li key={s.title} className="flex gap-3">
              <span className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-navy text-[12px] font-extrabold text-white">{i + 1}</span>
              <span className="text-[13.5px] text-ink">
                <span className="block font-bold">{s.title}</span>
                <span className="text-muted">{s.body}</span>
              </span>
            </li>
          ))}
        </ol>
      </Card>

      <h2 className="mb-2 px-1 font-heading text-[15px] font-extrabold text-ink">Your external forms</h2>
      {data.forms.length ? (
        <div className="space-y-3">
          {data.forms.map((f) => {
            const expanded = open === f.form.id;
            const code = f.form.kind === "code";
            const ready = f.live && f.settings.enabled;
            return (
              <Card key={f.form.id} className="p-0">
                <div className="flex flex-wrap items-center gap-3 px-5 py-3">
                  <button
                    type="button"
                    onClick={() => setOpen(expanded ? null : f.form.id)}
                    aria-expanded={expanded}
                    className="flex min-w-0 flex-1 items-center gap-2 text-left"
                  >
                    {expanded ? <ChevronDown className="h-4 w-4 shrink-0 text-muted" /> : <ChevronRight className="h-4 w-4 shrink-0 text-muted" />}
                    <span className="min-w-0">
                      <span className="flex flex-wrap items-center gap-2">
                        <span className="truncate text-[14px] font-semibold text-ink">{f.form.title}</span>
                        {!f.live && <Tag tone="amber">Not published as shared yet</Tag>}
                        {!f.settings.enabled && <Tag tone="neutral">Sharing off</Tag>}
                      </span>
                      <span className="mt-0.5 block text-[12.5px] text-muted">
                        {f.working} working link{f.working === 1 ? "" : "s"} · {f.entries} entr{f.entries === 1 ? "y" : "ies"} through links · new links last {f.settings.defaultDays} days{f.settings.maxDays ? `, at most ${f.settings.maxDays}` : ", no limit"}
                      </span>
                    </span>
                  </button>
                  <Button size="sm" onClick={() => navigate(`/f/${f.form.slug}/share`)} disabled={!ready} title={ready ? undefined : !f.live ? "Publish it first: links work on the published version." : "Sharing is off: turn it on below."}>
                    <QrCode className="h-4 w-4" /> {f.mine ? "My link and QR code" : "Make my link"}
                  </Button>
                </div>
                <div className="flex flex-wrap gap-1.5 border-t border-hairline px-5 py-2">
                  <Button size="sm" variant="ghost" onClick={() => navigate(code ? `/admin/apps/${f.form.id}` : `/admin/builder/${f.form.id}`)}><PenLine className="h-4 w-4" /> Edit form</Button>
                  {!code && <Button size="sm" variant="ghost" onClick={() => navigate(`/f/${f.form.slug}/entries`)}><ClipboardList className="h-4 w-4" /> Entries</Button>}
                  <Button size="sm" variant="ghost" onClick={() => navigate(`/admin/notifications/forms/${f.form.id}`)}><Bell className="h-4 w-4" /> Who's told</Button>
                  <Button size="sm" variant="ghost" onClick={() => setOpen(expanded ? null : f.form.id)} aria-expanded={expanded}>
                    {expanded ? <ChevronDown className="h-4 w-4" /> : <ChevronRight className="h-4 w-4" />} Sharing settings and everyone's links
                  </Button>
                </div>
                {expanded && (
                  <div className="border-t border-hairline px-5 py-4">
                    <ShareSettings formId={f.form.id} live={f.live} />
                  </div>
                )}
              </Card>
            );
          })}
        </div>
      ) : (
        <Card>
          <EmptyState
            title="No external forms yet"
            hint="Make one for people outside Lantern, like art submissions or an event sign-up. Or turn a form you have into one: its Settings → Who can fill it in → Anyone with a share link."
          />
          <div className="flex justify-center gap-2 pb-8">
            <Button onClick={() => navigate(NEW_EXTERNAL)}><Plus className="h-4 w-4" /> New external form</Button>
            <Link to="/admin/builder"><Button variant="secondary">Open the Form builder</Button></Link>
          </div>
        </Card>
      )}
    </Page>
  );
}
