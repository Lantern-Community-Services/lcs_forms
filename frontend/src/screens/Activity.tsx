import { Link } from "react-router-dom";
import { CheckCircle2, History, PencilLine, RotateCcw, Settings2, Undo2, UserMinus, UserPlus } from "lucide-react";
import { Page, PageHeader } from "@/components/shell/AppShell";
import { Card } from "@/components/ui/card";
import { EmptyState, LoadingState } from "@/components/ui/misc";
import { useAudit } from "@/lib/queries";
import { SitePicker, useSiteSelection } from "@/lib/site";
import { formatDateTime } from "@/lib/utils";

const ICONS: Record<string, typeof History> = {
  "tenant.created": UserPlus,
  "tenant.updated": PencilLine,
  "tenant.archived": UserMinus,
  "tenant.restored": RotateCcw,
  "tenant.kept": CheckCircle2,
  "tenant.keep_undone": Undo2,
  "tenant.remove_undone": Undo2,
};

/** The audit trail: who changed which roster, when, and why. */
export function ActivityPage() {
  const { codes, setCodes, param } = useSiteSelection();
  const { data, isLoading } = useAudit(param);

  return (
    <Page className="max-w-[860px]">
      <PageHeader
        title="Activity"
        help={{ article: "roster", text: "Every change to the roster, newest first, with who made it." }}
        subtitle="Every roster change, with who made it."
        actions={<SitePicker codes={codes} onChange={setCodes} className="w-full md:w-[260px]" />}
      />
      {isLoading ? (
        <LoadingState />
      ) : !data?.items.length ? (
        <EmptyState title="No activity yet" />
      ) : (
        <Card>
          <ul>
            {data.items.map((e) => {
              const Icon = ICONS[e.action] ?? Settings2;
              return (
                <li key={e.id} className="flex gap-3 border-b border-hairline px-4 py-3 last:border-0">
                  <Icon className="mt-0.5 h-4 w-4 shrink-0 text-muted" />
                  <div className="min-w-0 flex-1 text-[13.5px]">
                    {e.tenantId ? (
                      <Link to={`/tenants/${e.tenantId}`} className="text-ink hover:underline">{e.summary}</Link>
                    ) : (
                      <p className="text-ink">{e.summary}</p>
                    )}
                    <p className="text-micro text-muted">{e.actorName} · {formatDateTime(e.createdAt)}</p>
                  </div>
                </li>
              );
            })}
          </ul>
        </Card>
      )}
    </Page>
  );
}
