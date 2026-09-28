import { useState } from "react";
import { useToast } from "@/components/ui/toast";
import { ApiError } from "@/lib/api";
import { errorMessage } from "@/lib/utils";

/**
 * Download/print plumbing shared by every "export what's on screen" feature
 * (Roster, Attendance…) — the URL and its query params are feature-specific,
 * everything after that (fetching the file, triggering a save, driving the
 * phone's print dialog) is not.
 */

export type ExportFormat = "csv" | "xlsx" | "pdf";

async function fetchFile(url: string): Promise<{ blob: Blob; name: string }> {
  const res = await fetch(url, { credentials: "include" });
  if (!res.ok) {
    let msg = res.statusText;
    try {
      msg = (await res.json()).error ?? msg;
    } catch {
      // not JSON
    }
    throw new ApiError(res.status, msg);
  }
  const name = /filename="?([^"]+)"?/.exec(res.headers.get("content-disposition") ?? "")?.[1] ?? "export";
  return { blob: await res.blob(), name };
}

/**
 * iOS and iPadOS can't print a PDF from a hidden frame, and Android's viewer is
 * similar — there, the PDF opens in its own tab, whose share sheet has Print.
 */
const mobileBrowser = () =>
  /iPad|iPhone|iPod|Android/i.test(navigator.userAgent) || (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1);

/**
 * Download (CSV / Excel / PDF) and Print for whatever `buildUrl` points at.
 * The URL is expected to come from the server, so the file always matches
 * what's on screen, and the export is audited there.
 */
export function useFileExport(buildUrl: (format: ExportFormat, inline?: boolean) => string) {
  const toast = useToast();
  const [busy, setBusy] = useState<ExportFormat | "print" | null>(null);

  async function download(format: ExportFormat) {
    setBusy(format);
    try {
      const { blob, name } = await fetchFile(buildUrl(format));
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = name;
      document.body.appendChild(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 30_000);
    } catch (e) {
      toast(errorMessage(e, "Export failed."), "error");
    } finally {
      setBusy(null);
    }
  }

  async function print() {
    if (mobileBrowser()) {
      // Opened synchronously inside the tap, or the popup blocker eats it.
      window.open(buildUrl("pdf", true), "_blank", "noopener");
      return;
    }
    setBusy("print");
    try {
      const { blob } = await fetchFile(buildUrl("pdf", true));
      const url = URL.createObjectURL(blob);
      // Load the PDF into an invisible frame and ask it to print: the browser's
      // own print dialog opens over the app, with the PDF as the document.
      const frame = document.createElement("iframe");
      frame.style.cssText = "position:fixed;right:0;bottom:0;width:0;height:0;border:0;visibility:hidden";
      frame.src = url;
      frame.onload = () => {
        setTimeout(() => {
          try {
            frame.contentWindow?.focus();
            frame.contentWindow?.print();
          } catch {
            // Some browsers refuse to script their PDF viewer — show it instead.
            window.open(url, "_blank");
          }
          setBusy(null);
        }, 250);
        // Leave the frame long enough for the dialog; it must outlive print().
        setTimeout(() => {
          frame.remove();
          URL.revokeObjectURL(url);
        }, 60_000);
      };
      document.body.appendChild(frame);
    } catch (e) {
      toast(errorMessage(e, "Could not prepare the printout."), "error");
      setBusy(null);
    }
  }

  return { download, print, busy };
}
