import { useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { FileUp } from "lucide-react";
import { Page, PageHeader } from "@/components/shell/AppShell";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { useToast } from "@/components/ui/toast";
import { API_BASE, ApiError } from "@/lib/api";
import type { ImportSummary } from "@/lib/types";
import { errorMessage } from "@/lib/utils";

async function upload(file: File, commit: boolean): Promise<ImportSummary> {
  const res = await fetch(`${API_BASE}/admin/import/tenants${commit ? "?commit=1" : ""}`, {
    method: "POST",
    credentials: "include",
    headers: { "Content-Type": "text/csv" },
    body: file,
  });
  const json = await res.json();
  if (!res.ok) throw new ApiError(res.status, json.error ?? res.statusText, json.details);
  return json;
}

/**
 * Bring a property-management export in. Always previews first; the import
 * only adds people, never removes — anyone missing from a new export is left
 * for the review queue, where a person decides.
 */
export function AdminImport() {
  const [file, setFile] = useState<File | null>(null);
  const [preview, setPreview] = useState<ImportSummary | null>(null);
  const [busy, setBusy] = useState(false);
  const toast = useToast();
  const qc = useQueryClient();

  async function run(commit: boolean) {
    if (!file) return;
    setBusy(true);
    try {
      const summary = await upload(file, commit);
      setPreview(summary);
      if (commit) {
        toast(`Imported ${summary.added} residents.`);
        await qc.invalidateQueries({ queryKey: ["roster"] });
      }
    } catch (e) {
      toast(errorMessage(e, "Import failed."), "error");
    } finally {
      setBusy(false);
    }
  }

  return (
    <Page className="max-w-[860px]">
      <PageHeader title="Import tenant list" subtitle="CSV with Property, Unit and Tenant columns — the property-management export format." />
      <Card className="mb-4 p-5">
        <label className="flex cursor-pointer flex-col items-center gap-2 rounded-card border-2 border-dashed border-strongline px-4 py-8 text-center hover:bg-rowhover">
          <FileUp className="h-7 w-7 text-muted" />
          <span className="text-[14px] font-semibold text-ink">{file ? file.name : "Choose a CSV file"}</span>
          <span className="text-micro text-muted">Excel exports (Windows-1252) and UTF-8 both work. Nothing is written until you confirm.</span>
          <input type="file" accept=".csv,text/csv" className="sr-only" onChange={(e) => { setFile(e.target.files?.[0] ?? null); setPreview(null); }} />
        </label>
        <div className="mt-4 flex justify-end gap-2">
          <Button variant="secondary" disabled={!file || busy} onClick={() => run(false)}>Preview</Button>
          <Button disabled={!file || busy || !preview || preview.committed || preview.added === 0} onClick={() => run(true)}>
            {busy ? "Working…" : preview && !preview.committed ? `Import ${preview.added} residents` : "Import"}
          </Button>
        </div>
      </Card>

      {preview && (
        <Card className="p-5">
          <p className="kicker mb-3">{preview.committed ? "Imported" : "Preview"}</p>
          <div className="mb-4 grid grid-cols-2 gap-3 text-[13px] md:grid-cols-4">
            <Stat label="Rows" value={preview.rows} />
            <Stat label={preview.committed ? "Added" : "Will add"} value={preview.added} />
            <Stat label="Already on roster" value={preview.alreadyPresent} />
            <Stat label="Blank rows skipped" value={preview.skippedBlank} />
          </div>
          {preview.sitesCreated.length > 0 && (
            <p className="mb-3 rounded-input bg-status-blueBg px-3 py-2 text-[13px] text-status-blueText">
              New sites {preview.committed ? "created" : "will be created"}: {preview.sitesCreated.join(", ")}
            </p>
          )}
          <table className="mb-4 w-full text-[13px]">
            <tbody>
              {preview.bySite.map((s) => (
                <tr key={s.site} className="border-b border-hairline last:border-0">
                  <td className="py-1.5 text-ink">{s.site}</td>
                  <td className="py-1.5 text-right tabular text-ink">+{s.added}</td>
                  <td className="py-1.5 text-right tabular text-muted">{s.alreadyPresent} existing</td>
                </tr>
              ))}
            </tbody>
          </table>
          {preview.samples.length > 0 && (
            <>
              <p className="kicker mb-2">How tricky names were read</p>
              <ul className="space-y-1 text-[12.5px]">
                {preview.samples.map((x, i) => (
                  <li key={i} className="text-muted">
                    <span className="text-ink">{x.raw}</span> → first <b>{x.parsed.firstName}</b>, last <b>{x.parsed.lastName || "—"}</b>
                    {x.parsed.preferredName && <>, goes by <b>{x.parsed.preferredName}</b></>}
                  </li>
                ))}
              </ul>
            </>
          )}
        </Card>
      )}
    </Page>
  );
}

function Stat({ label, value }: { label: string; value: number }) {
  return (
    <div>
      <p className="text-micro font-semibold text-muted">{label}</p>
      <p className="font-heading text-[20px] font-extrabold tabular text-ink">{value}</p>
    </div>
  );
}
