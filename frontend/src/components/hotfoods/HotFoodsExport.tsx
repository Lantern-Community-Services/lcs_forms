import { Download, FileSpreadsheet, FileText, Loader2, Printer, Sheet as SheetIcon } from "lucide-react";
import { Button } from "@/components/ui/button";
import { ExportButtons, ExportMenu, type ExportOption } from "@/components/ui/export-menu";
import { useFileExport } from "@/lib/exportPipeline";
import { API_BASE } from "@/lib/api";
import { hotFoodParams, type HotFoodView } from "@/lib/queries";

/**
 * Print + Export for the Hot Foods Entries list and the Reports tab. The file
 * is built by the server from the same filter as the screen, so it always
 * matches what's shown, and every export is audited there.
 */

type Kind = "entries" | "report";

const OPTIONS: Record<Kind, ExportOption[]> = {
  entries: [
    { format: "csv", Icon: SheetIcon, label: "CSV", hint: "Plain spreadsheet data" },
    { format: "xlsx", Icon: FileSpreadsheet, label: "Excel", hint: "Formatted table with filters" },
    { format: "pdf", Icon: FileText, label: "PDF", hint: "Print-ready list" },
  ],
  report: [
    { format: "pdf", Icon: FileText, label: "PDF report", hint: "The charts and totals, ready to share" },
    { format: "xlsx", Icon: FileSpreadsheet, label: "Excel workbook", hint: "One sheet per breakdown, to re-chart" },
  ],
};

const LABEL: Record<Kind, string> = { entries: "Export what's shown", report: "Export this report" };

function useHotFoodsExport(kind: Kind, view: HotFoodView) {
  return useFileExport((format, inline) => `${API_BASE}/hot-foods/${kind === "report" ? "report/export" : "export"}?${hotFoodParams(view, { format, ...(inline ? { inline: "1" } : {}) })}`);
}

/** Desktop: Print and an Export menu, side by side. */
export function HotFoodsExportButtons({ kind, view, disabled }: { kind: Kind; view: HotFoodView; disabled?: boolean }) {
  const exporter = useHotFoodsExport(kind, view);
  return <ExportButtons exporter={exporter} label={LABEL[kind]} options={OPTIONS[kind]} disabled={disabled} menuClassName="w-[250px]" />;
}

/** Phone: one "…" button holding Print and the formats. */
export function HotFoodsExportMenu({ kind, view, disabled }: { kind: Kind; view: HotFoodView; disabled?: boolean }) {
  const exporter = useHotFoodsExport(kind, view);
  return <ExportMenu exporter={exporter} label={LABEL[kind]} options={OPTIONS[kind]} disabled={disabled} menuClassName="w-[250px]" />;
}

/** One entry's signed receipt. */
export function HotFoodEntryPrint({ id }: { id: string }) {
  const { print, download, busy } = useFileExport((_format, inline) => `${API_BASE}/hot-foods/${encodeURIComponent(id)}/export${inline ? "?inline=1" : ""}`);
  return (
    <div className="flex flex-wrap gap-2">
      <Button variant="secondary" onClick={() => void print()} disabled={busy !== null}>
        {busy === "print" ? <Loader2 className="h-4 w-4 animate-spin" /> : <Printer className="h-4 w-4" />} Print
      </Button>
      <Button variant="secondary" onClick={() => void download("pdf")} disabled={busy !== null}>
        {busy === "pdf" ? <Loader2 className="h-4 w-4 animate-spin" /> : <Download className="h-4 w-4" />} PDF
      </Button>
    </div>
  );
}
