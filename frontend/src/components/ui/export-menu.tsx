import { Download, FileSpreadsheet, FileText, Loader2, MoreHorizontal, Printer, Sheet as SheetIcon, type LucideIcon } from "lucide-react";
import { Button } from "./button";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuLabel, DropdownMenuSeparator, DropdownMenuTrigger } from "./dropdown-menu";
import type { ExportFormat, useFileExport } from "@/lib/exportPipeline";

/**
 * Print and Export controls for any "export what's on screen" feature. The
 * feature builds the exporter (`useFileExport` with its own URL) and says
 * which formats it offers; everything else — the buttons, the menu, the
 * spinners while a file is being made — is the same on every screen.
 */

type Exporter = ReturnType<typeof useFileExport>;

export interface ExportOption {
  format: ExportFormat;
  Icon: LucideIcon;
  label: string;
  hint: string;
}

/** CSV, Excel and a PDF grouped by site — what a list of residents or attendance offers. */
export const STANDARD_EXPORTS: ExportOption[] = [
  { format: "csv", Icon: SheetIcon, label: "CSV", hint: "Plain spreadsheet data" },
  { format: "xlsx", Icon: FileSpreadsheet, label: "Excel", hint: "Formatted table with filters" },
  { format: "pdf", Icon: FileText, label: "PDF", hint: "Print-ready, grouped by site" },
];

function ExportItems({ exporter: { download, busy }, options }: { exporter: Exporter; options: ExportOption[] }) {
  return (
    <>
      {options.map(({ format, Icon, label, hint }) => (
        <DropdownMenuItem key={format} onSelect={() => download(format)} disabled={busy !== null} className="min-h-[44px] md:min-h-0">
          {busy === format ? <Loader2 className="h-4 w-4 animate-spin text-muted" /> : <Icon className="h-4 w-4 text-muted" />}
          <span className="flex-1">
            <span className="block">{label}</span>
            <span className="block text-micro text-muted">{hint}</span>
          </span>
        </DropdownMenuItem>
      ))}
    </>
  );
}

/** Desktop: a Print button and an Export menu, side by side. */
export function ExportButtons({
  exporter,
  label,
  options = STANDARD_EXPORTS,
  disabled,
  printLabel = "Print",
  printTitle,
  exportLabel = "Export",
  menuClassName = "w-[240px]",
}: {
  exporter: Exporter;
  /** The menu's heading, e.g. "Export what's shown". */
  label: string;
  options?: ExportOption[];
  disabled?: boolean;
  printLabel?: string;
  printTitle?: string;
  exportLabel?: string;
  menuClassName?: string;
}) {
  const { print, busy } = exporter;
  return (
    <>
      <Button variant="secondary" onClick={() => void print()} disabled={disabled || busy !== null} title={printTitle}>
        {busy === "print" ? <Loader2 className="h-4 w-4 animate-spin" /> : <Printer className="h-4 w-4" />} {printLabel}
      </Button>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button variant="secondary" disabled={disabled}>
            {busy && busy !== "print" ? <Loader2 className="h-4 w-4 animate-spin" /> : <Download className="h-4 w-4" />} {exportLabel}
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" className={menuClassName}>
          <DropdownMenuLabel>{label}</DropdownMenuLabel>
          <ExportItems exporter={exporter} options={options} />
        </DropdownMenuContent>
      </DropdownMenu>
    </>
  );
}

/** Phone: one "…" button beside the screen's main action, holding Print and the formats. */
export function ExportMenu({
  exporter,
  label,
  options = STANDARD_EXPORTS,
  disabled,
  menuClassName = "w-[240px]",
}: {
  exporter: Exporter;
  label: string;
  options?: ExportOption[];
  disabled?: boolean;
  menuClassName?: string;
}) {
  const { print, busy } = exporter;
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button variant="secondary" disabled={disabled} className="min-h-[44px] w-11 px-0" aria-label="Print or export">
          {busy ? <Loader2 className="h-5 w-5 animate-spin" /> : <MoreHorizontal className="h-5 w-5" />}
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className={menuClassName}>
        <DropdownMenuItem onSelect={() => void print()} disabled={busy !== null} className="min-h-[44px]">
          <Printer className="h-4 w-4 text-muted" /> Print
        </DropdownMenuItem>
        <DropdownMenuSeparator />
        <DropdownMenuLabel>{label}</DropdownMenuLabel>
        <ExportItems exporter={exporter} options={options} />
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
