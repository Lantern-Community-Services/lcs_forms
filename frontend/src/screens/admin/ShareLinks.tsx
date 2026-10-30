import { useState } from "react";
import { useNavigate } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { ChevronDown, ChevronRight, QrCode, Settings2 } from "lucide-react";
import { Page, PageHeader } from "@/components/shell/AppShell";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Tag } from "@/components/ui/badge";
import { EmptyState, LoadingState } from "@/components/ui/misc";
import { ShareSettings } from "@/components/ShareSettings";
import { api } from "@/lib/api";
import type { SharingSettings } from "@/screens/builtforms/SharePage";

/**
 * Admin → Share links: every form anyone can fill in through an employee's
 * link (backend services/shareLinks.ts), in one place. For each, its sharing
 * settings and everyone's links (turn any off), the Admin's own link and QR
 * code, and the way to its Settings.
 */

interface LinkForm {
  form: { id: string; slug: string; title: string; status: string };
  /** The published version is shared by link (else only the draft is, so links don't work yet). */
  live: boolean;
  settings: SharingSettings;
  working: number;
  entries: number;
  mine: boolean;
}

export function AdminShareLinks() {
  const navigate = useNavigate();
  const { data, isLoading } = useQuery({ queryKey: ["share", "all"], queryFn: () => api.get<{ forms: LinkForm[] }>("/share/all/forms") });
  const [open, setOpen] = useState<string | null>(null);
  if (isLoading || !data) return <LoadingState />;

  return (
    <Page className="max-w-[960px]">
      <PageHeader
        title="Share links"
        subtitle="Forms people outside Lantern fill in through an employee's own link or QR code."
        help={{ article: "share-links", text: "Every form shared by link: its settings, everyone's links (turn any off), and your own link and QR code." }}
      />
      {data.forms.length ? (
        <div className="space-y-3">
          {data.forms.map((f) => {
            const expanded = open === f.form.id;
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
                  <Button size="sm" variant="secondary" onClick={() => navigate(`/f/${f.form.slug}/share`)} disabled={!f.live || !f.settings.enabled}>
                    <QrCode className="h-4 w-4" /> {f.mine ? "My link and QR code" : "Make my link"}
                  </Button>
                  <Button size="sm" variant="ghost" onClick={() => navigate(`/admin/builder/${f.form.id}?tab=settings`)}>
                    <Settings2 className="h-4 w-4" /> Settings
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
          <EmptyState title="No form is shared by link yet" hint="In a form's Settings, under Who can fill it in, choose Anyone with a share link. It shows here, and its links and QR codes are managed from here." />
        </Card>
      )}
    </Page>
  );
}
