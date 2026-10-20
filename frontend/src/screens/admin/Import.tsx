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

/** Rows per request: small enough that each part is a quick, short write. */
const PART_ROWS = 500;

/**
 * Split the file into header + PART_ROWS-line parts. Works on bytes so a
 * Windows-1252 export reaches the server untouched (a line feed is the same
 * byte in either encoding); a line break inside quotes doesn't split a row.
 */
function splitCsv(bytes: Uint8Array): Blob[] {
  const lines: Uint8Array[] = [];
  let start = 0;
  let quoted = false;
  for (let i = 0; i < bytes.length; i++) {
    if (bytes[i] === 0x22) quoted = !quoted;
    else if (bytes[i] === 0x0a && !quoted) {
      lines.push(bytes.subarray(start, i + 1));
      start = i + 1;
    }
  }
  if (start < bytes.length) lines.push(bytes.subarray(start));
  const body = lines.slice(1).filter((l) => l.some((b) => b !== 0x0d && b !== 0x0a && b !== 0x20));
  if (body.length <= PART_ROWS) return [new Blob([bytes as BlobPart])];
  const header = lines[0];
  const parts: Blob[] = [];
  for (let i = 0; i < body.length; i += PART_ROWS) parts.push(new Blob([header as BlobPart, ...(body.slice(i, i + PART_ROWS) as BlobPart[])]));
  return parts;
}

async function upload(part: Blob, commit: boolean, index: number, total: number): Promise<ImportSummary> {
  const query = new URLSearchParams();
  if (commit) query.set("commit", "1");
  if (total > 1) {
    query.set("part", String(index));
    query.set("parts", String(total));
  }
  const qs = query.toString();
  const res = await fetch(`${API_BASE}/admin/import/tenants${qs ? `?${qs}` : ""}`, {
    method: "POST",
    credentials: "include",
    headers: { "Content-Type": "text/csv" },
    body: part,
  });
  const json = await res.json();
  if (!res.ok) throw new ApiError(res.status, json.error ?? res.statusText, json.details);
  return json;
}

function merge(a: ImportSummary | null, b: ImportSummary): ImportSummary {
  if (!a) return b;
  const bySite = new Map(a.bySite.map((s) => [s.site, { ...s }]));
  for (const s of b.bySite) {
    const x = bySite.get(s.site);
    if (x) {
      x.added += s.added;
      x.alreadyPresent += s.alreadyPresent;
    } else bySite.set(s.site, { ...s });
  }
  return {
    committed: b.committed,
    rows: a.rows + b.rows,
    skippedBlank: a.skippedBlank + b.skippedBlank,
    sitesCreated: [...new Set([...a.sitesCreated, ...b.sitesCreated])],
    added: a.added + b.added,
    alreadyPresent: a.alreadyPresent + b.alreadyPresent,
    bySite: [...bySite.values()].sort((x, y) => x.site.localeCompare(y.site)),
    samples: [...a.samples, ...b.samples].slice(0, 12),
  };
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
  const [progress, setProgress] = useState<{ done: number; total: number } | null>(null);
  const toast = useToast();
  const qc = useQueryClient();

  async function run(commit: boolean) {
    if (!file) return;
    setBusy(true);
    let summary: ImportSummary | null = null;
    try {
      const parts = splitCsv(new Uint8Array(await file.arrayBuffer()));
      // One part at a time, so a big file never asks the server for one long write.
      for (let i = 0; i < parts.length; i++) {
        if (parts.length > 1) setProgress({ done: i, total: parts.length });
        summary = merge(summary, await upload(parts[i], commit, i + 1, parts.length));
      }
      setPreview(summary);
      if (commit && summary) toast(`Imported ${summary.added} residents.`);
    } catch (e) {
      if (commit && summary) {
        // The finished parts are in; running it again skips everyone already added.
        setPreview(summary);
        toast(`${errorMessage(e, "Import failed.")} ${summary.added} residents were added before it stopped — run it again to finish; nobody is added twice.`, "error");
      } else toast(errorMessage(e, "Import failed."), "error");
    } finally {
      if (commit) await qc.invalidateQueries({ queryKey: ["roster"] });
      setProgress(null);
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
            {busy ? (progress ? `Working… part ${progress.done + 1} of ${progress.total}` : "Working…") : preview && !preview.committed ? `Import ${preview.added} residents` : "Import"}
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
