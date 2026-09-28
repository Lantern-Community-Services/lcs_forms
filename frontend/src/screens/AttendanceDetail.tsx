import { useState } from "react";
import { useParams } from "react-router-dom";
import { PenLine } from "lucide-react";
import { DesktopBackLink, Page } from "@/components/shell/AppShell";
import { PhoneHeader } from "@/components/shell/PhoneHeader";
import { AttendanceDetailExport } from "@/components/attendance/AttendanceExport";
import { Card } from "@/components/ui/card";
import { ResponsiveDialog } from "@/components/ui/responsive-dialog";
import { EmptyState, LoadingState } from "@/components/ui/misc";
import { useAttendanceDetail } from "@/lib/queries";
import { errorMessage, formatDateTime } from "@/lib/utils";
import type { AttendanceEntry } from "@/lib/types";

export function AttendanceDetailPage() {
  const { id } = useParams();
  const { data: e, isLoading, isError, error } = useAttendanceDetail(id);
  const [viewing, setViewing] = useState<AttendanceEntry | null>(null);

  if (isLoading) return <LoadingState />;
  if (isError || !e) return <EmptyState title="Could not load attendance" hint={errorMessage(error, "The entry may be unavailable.")} />;
  const signedCount = e.entries.filter((en) => en.signature).length;

  return (
    <div className="flex min-h-full flex-col">
      <PhoneHeader title={e.title} subtitle={e.site.name} back={{ to: "/roster/attendance", label: "Attendance" }} />
      <Page className="w-full max-w-[720px]">
        <DesktopBackLink to="/roster/attendance">Attendance</DesktopBackLink>

        <Card className="mb-4 p-5">
          <h1 className="hidden text-[21px] font-heading font-extrabold text-ink md:block">{e.title}</h1>
          <p className="mt-1 text-[13.5px] text-ink">{e.description}</p>
          <p className="mt-2 text-[13px] text-muted">
            {e.site.name} · {formatDateTime(e.occurredAt)} · Taken by {e.createdByName}
          </p>
          <p className="mt-1 text-[13px] text-muted">
            {e.entries.length} present · {signedCount} signed
          </p>
        </Card>

        <div className="mb-4"><AttendanceDetailExport id={e.id} /></div>

        <Card>
          {e.entries.length === 0 ? (
            <p className="px-4 py-6 text-center text-[13.5px] text-muted">Nobody was marked present.</p>
          ) : (
            <ul>
              {e.entries.map((en) => (
                <li key={en.id} className="border-b border-hairline last:border-0">
                  <button
                    type="button"
                    disabled={!en.signature}
                    onClick={() => setViewing(en)}
                    className="flex min-h-[48px] w-full items-center gap-3 px-4 py-2.5 text-left hover:bg-rowhover disabled:hover:bg-transparent"
                  >
                    <span className="min-w-0 flex-1 truncate text-[14px] font-semibold text-ink">{en.tenantName}</span>
                    {en.signature ? (
                      <span className="inline-flex shrink-0 items-center gap-1.5 rounded-pill bg-status-greenBg px-2.5 py-0.5 text-micro font-semibold text-status-greenText">
                        <PenLine className="h-3 w-3" /> Signed
                      </span>
                    ) : (
                      <span className="shrink-0 text-micro text-muted">No signature</span>
                    )}
                  </button>
                </li>
              ))}
            </ul>
          )}
        </Card>
      </Page>

      <ResponsiveDialog open={viewing !== null} onOpenChange={(o) => !o && setViewing(null)} title={viewing?.tenantName ?? ""}>
        {viewing && (
          <div className="flex flex-col items-center gap-2">
            <img src={viewing.signature ?? undefined} alt={`${viewing.tenantName}'s signature`} className="w-full rounded-card border border-hairline bg-white" />
            <p className="text-micro text-muted">Signed {formatDateTime(viewing.signedAt)}</p>
          </div>
        )}
      </ResponsiveDialog>
    </div>
  );
}
