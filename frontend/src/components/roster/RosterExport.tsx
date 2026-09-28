import { ExportButtons, ExportMenu } from "@/components/ui/export-menu";
import { useFileExport, type ExportFormat } from "@/lib/exportPipeline";
import { API_BASE } from "@/lib/api";

export type { ExportFormat };

/** What's on screen: the site selection, the tab, and the search box. */
export interface RosterView {
  site?: string;
  status: "active" | "attention" | "archived";
  q: string;
}

function exportUrl(view: RosterView, format: ExportFormat, inline = false) {
  const p = new URLSearchParams({ format, status: view.status });
  if (view.site) p.set("site", view.site);
  if (view.q.trim()) p.set("q", view.q.trim());
  if (inline) p.set("inline", "1");
  return `${API_BASE}/tenants/export?${p}`;
}

/**
 * Download (CSV / Excel / PDF) and Print for the current roster view.
 * Everything comes from the server, so the file matches the screen and the
 * export is audited there.
 */
export function useRosterExport(view: RosterView) {
  return useFileExport((format, inline) => exportUrl(view, format, inline));
}

/** Desktop: a Print button and an Export menu, side by side. */
export function RosterExportButtons({ view, disabled }: { view: RosterView; disabled?: boolean }) {
  const exporter = useRosterExport(view);
  return <ExportButtons exporter={exporter} label="Export what's shown" printTitle="Print this roster" disabled={disabled} />;
}

/** Phone: one "…" button beside Add, holding Print and the three formats. */
export function RosterExportMenu({ view, disabled }: { view: RosterView; disabled?: boolean }) {
  const exporter = useRosterExport(view);
  return <ExportMenu exporter={exporter} label="Export what's shown" disabled={disabled} />;
}
