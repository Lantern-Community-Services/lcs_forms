import { ExportButtons, ExportMenu } from "@/components/ui/export-menu";
import { useFileExport, type ExportFormat } from "@/lib/exportPipeline";
import { API_BASE } from "@/lib/api";

/** What's on screen: the site selection and the search box, or a specific multi-select. */
export interface AttendanceView {
  site?: string;
  q: string;
  /** A multi-selected set of entries — exported instead of the filtered view when present. */
  ids?: string[];
}

function exportUrl(view: AttendanceView, format: ExportFormat, inline = false) {
  const p = new URLSearchParams({ format });
  if (view.ids && view.ids.length > 0) {
    p.set("ids", view.ids.join(","));
  } else {
    if (view.site) p.set("site", view.site);
    if (view.q.trim()) p.set("q", view.q.trim());
  }
  if (inline) p.set("inline", "1");
  return `${API_BASE}/attendance/export?${p}`;
}

export function useAttendanceExport(view: AttendanceView) {
  return useFileExport((format, inline) => exportUrl(view, format, inline));
}

const menuLabel = (view: AttendanceView) => (view.ids && view.ids.length > 0 ? `Export ${view.ids.length} selected` : "Export what's shown");

/** Desktop: a Print button and an Export menu, side by side. */
export function AttendanceExportButtons({ view, disabled }: { view: AttendanceView; disabled?: boolean }) {
  const exporter = useAttendanceExport(view);
  return <ExportButtons exporter={exporter} label={menuLabel(view)} printTitle="Print attendance" disabled={disabled} />;
}

/** Phone: one "…" button beside Take attendance, holding Print and the three formats. */
export function AttendanceExportMenu({ view, disabled }: { view: AttendanceView; disabled?: boolean }) {
  const exporter = useAttendanceExport(view);
  return <ExportMenu exporter={exporter} label={menuLabel(view)} disabled={disabled} />;
}

/** Export the selected session's attendee sheet, including signatures in its PDF. */
export function AttendanceDetailExport({ id }: { id: string }) {
  const exporter = useFileExport((format, inline) =>
    `${API_BASE}/attendance/${encodeURIComponent(id)}/export?${new URLSearchParams({ format, ...(inline ? { inline: "1" } : {}) })}`
  );
  return (
    <div className="flex flex-wrap gap-2">
      <ExportButtons
        exporter={exporter}
        label="Export this attendance"
        printLabel="Print sheet"
        exportLabel="Export sheet"
        disabled={exporter.busy !== null}
      />
    </div>
  );
}
