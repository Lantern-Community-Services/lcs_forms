import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { AlertTriangle, ChevronDown, CloudUpload, Loader2, RefreshCw } from "lucide-react";
import { api } from "@/lib/api";
import { Button } from "@/components/ui/button";
import { ToneBadge } from "@/components/ui/badge";
import { useToast } from "@/components/ui/toast";
import { cn, errorMessage, relativeTime } from "@/lib/utils";

/**
 * The GitHub backup of every built form (backend services/formBackup.ts), on the builder lists.
 * It's shared by prod, Azure dev and local: each form there is the newest version any site saved,
 * so a form here can need sync (the backup is newer) or differ (changed on both sides).
 */

type Kind = "basic" | "code";
type SyncState = "in_sync" | "behind" | "differs" | "only_backup";

export interface FormSync {
  key: string;
  kind: Kind;
  slug: string;
  title: string;
  state: SyncState;
  backup: { title: string | null; savedFrom: string | null; savedAt: string | null } | null;
  editedHere: string | null;
}

interface BackupStatus {
  configured: boolean;
  repo: string | null;
  site: string;
  running: boolean;
  lastCheckedAt: string | null;
  lastCommitAt: string | null;
  lastCommitUrl: string | null;
  lastError: string | null;
  forms: FormSync[];
}

interface SyncResult {
  synced: string[];
  failed: { key: string; error: string }[];
  status: BackupStatus;
}

const KEY = ["form-backup"];
const useBackupStatus = () => useQuery({ queryKey: KEY, queryFn: () => api.get<BackupStatus>("/admin/form-backup"), refetchInterval: 60_000 });

const savedLine = (f: FormSync) =>
  f.backup?.savedAt ? `saved ${relativeTime(f.backup.savedAt)}${f.backup.savedFrom ? ` from ${f.backup.savedFrom}` : ""}` : f.backup?.savedFrom ? `from ${f.backup.savedFrom}` : "";

/** Sync / keep / remove, shared by the bar and the row labels. */
function useBackupActions(listKey: readonly unknown[]) {
  const qc = useQueryClient();
  const toast = useToast();
  const done = (s: BackupStatus) => {
    qc.setQueryData(KEY, s);
    void qc.invalidateQueries({ queryKey: listKey });
  };
  const sync = useMutation({
    mutationFn: (body: { keys: string[] } | { all: true }) => api.post<SyncResult>("/admin/form-backup/sync", body),
    onSuccess: (r) => {
      done(r.status);
      if (r.failed.length) toast(`Couldn't sync ${r.failed.map((f) => `${f.key.split("/")[1]} (${f.error})`).join("; ")}`, "error");
      else toast(r.synced.length ? `Synced ${r.synced.length} form${r.synced.length === 1 ? "" : "s"} from the backup.` : "Nothing needed syncing.", "success");
    },
    onError: (e) => toast(errorMessage(e, "The sync didn't run."), "error"),
  });
  const keep = useMutation({
    mutationFn: (key: string) => api.post<BackupStatus>("/admin/form-backup/keep", { key }),
    onSuccess: (s) => { done(s); toast(s.lastError ? `Backup failed: ${s.lastError}` : "Saved this site's version to the backup.", s.lastError ? "error" : "success"); },
    onError: (e) => toast(errorMessage(e, "That didn't work."), "error"),
  });
  const remove = useMutation({
    mutationFn: (key: string) => api.post<BackupStatus>("/admin/form-backup/remove", { key }),
    onSuccess: (s) => { done(s); toast("Removed from the backup."); },
    onError: (e) => toast(errorMessage(e, "That didn't work."), "error"),
  });
  const busy = sync.isPending || keep.isPending || remove.isPending;
  return {
    busy,
    syncOne(f: FormSync) {
      if (f.state === "differs" && !confirm(`“${f.title}” was changed here too. Replace this site's draft with the backup's version${savedLine(f) ? ` (${savedLine(f)})` : ""}? Published versions stay in its history.`)) return;
      sync.mutate({ keys: [f.key] });
    },
    syncAll: () => sync.mutate({ all: true }),
    keep: (f: FormSync) => {
      if (confirm(`Save this site's “${f.title}” over the backup's version${savedLine(f) ? ` (${savedLine(f)})` : ""}? Other sites will then see theirs as needing sync.`)) keep.mutate(f.key);
    },
    remove: (f: FormSync) => {
      if (confirm(`Remove “${f.title}” from the backup? No site will be able to sync it in afterwards.`)) remove.mutate(f.key);
    },
  };
}

/** The label on a form's row when it isn't in sync with the backup, with its Sync button. */
export function BackupSyncLabel({ kind, slug, listKey }: { kind: Kind; slug: string; listKey: readonly unknown[] }) {
  const { data } = useBackupStatus();
  const actions = useBackupActions(listKey);
  const f = data?.forms.find((x) => x.kind === kind && x.slug === slug);
  if (!f || (f.state !== "behind" && f.state !== "differs")) return null;
  const behind = f.state === "behind";
  return (
    <span className="inline-flex items-center gap-1.5" title={`The backup's version: ${savedLine(f) || "unknown"}`}>
      <ToneBadge tone={behind ? "amber" : "red"}>{behind ? "Needs sync" : "Differs from backup"}</ToneBadge>
      <Button size="sm" variant="secondary" disabled={actions.busy} onClick={() => actions.syncOne(f)}>
        <RefreshCw className="h-3.5 w-3.5" /> Sync
      </Button>
    </span>
  );
}

export function FormBackupBar({ className, kind, listKey }: { className?: string; kind: Kind; listKey: readonly unknown[] }) {
  const qc = useQueryClient();
  const toast = useToast();
  const [open, setOpen] = useState(false);
  const { data } = useBackupStatus();
  const actions = useBackupActions(listKey);
  const run = useMutation({
    mutationFn: () => api.post<BackupStatus>("/admin/form-backup"),
    onSuccess: (s) => {
      qc.setQueryData(KEY, s);
      toast(s.lastError ? `Backup failed: ${s.lastError}` : "Forms backed up.", s.lastError ? "error" : "success");
    },
    onError: (e) => toast(errorMessage(e, "The backup didn't run."), "error"),
  });
  if (!data) return null;
  const repoName = data.repo?.split("/").pop();
  const repoUrl = data.repo ? `https://github.com/${data.repo}` : null;
  const mine = data.forms.filter((f) => f.kind === kind);
  const behind = mine.filter((f) => f.state === "behind");
  const differs = mine.filter((f) => f.state === "differs");
  const onlyBackup = mine.filter((f) => f.state === "only_backup");
  const busy = actions.busy || run.isPending || data.running;

  return (
    <div className={cn("mb-4 rounded-card border border-hairline bg-surface text-[13px]", className)}>
      <div className="flex flex-wrap items-center gap-x-3 gap-y-2 px-4 py-2.5">
        {data.lastError ? <AlertTriangle className="h-4 w-4 shrink-0 text-status-amberText" /> : <CloudUpload className="h-4 w-4 shrink-0 text-muted" />}
        <p className="min-w-0 flex-1 text-muted">
          {!data.configured ? (
            <>Forms aren't being backed up yet. Add FORM_BACKUP_TOKEN on the server (see README, "Form backup").</>
          ) : data.lastError ? (
            <span className="text-status-amberText">The last backup failed: {data.lastError}</span>
          ) : (
            <>
              Every form here is backed up to{" "}
              <a href={repoUrl!} target="_blank" rel="noreferrer" className="font-semibold text-ink hover:underline">{repoName}</a> on GitHub
              {data.lastCommitAt ? (
                <> · last change saved{" "}
                  {data.lastCommitUrl ? <a href={data.lastCommitUrl} target="_blank" rel="noreferrer" className="hover:underline">{relativeTime(data.lastCommitAt)}</a> : relativeTime(data.lastCommitAt)}
                </>
              ) : data.lastCheckedAt ? (
                <> · checked {relativeTime(data.lastCheckedAt)}</>
              ) : (
                <> · checks every 10 minutes</>
              )}
              .
            </>
          )}
        </p>
        {data.configured && (
          <>
            {behind.length > 0 && (
              <Button size="sm" onClick={actions.syncAll} disabled={busy} title="Bring in every form whose backup is newer">
                <RefreshCw className="h-3.5 w-3.5" /> Sync all ({behind.length})
              </Button>
            )}
            <Button size="sm" variant="secondary" onClick={() => run.mutate()} disabled={busy}>
              {busy ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : null} Back up now
            </Button>
          </>
        )}
      </div>

      {mine.length > 0 && (
        <>
          <button onClick={() => setOpen(!open)} className="flex w-full items-center gap-2 border-t border-hairline px-4 py-2 text-left text-[13px] font-semibold text-ink hover:bg-rowhover/50">
            <ChevronDown className={cn("h-4 w-4 text-muted transition-transform", !open && "-rotate-90")} />
            {[
              behind.length && `${behind.length} need${behind.length === 1 ? "s" : ""} sync`,
              differs.length && `${differs.length} differ${differs.length === 1 ? "s" : ""} from the backup`,
              onlyBackup.length && `${onlyBackup.length} only in the backup`,
            ].filter(Boolean).join(" · ")}
          </button>
          {open && (
            <ul className="border-t border-hairline">
              {mine.map((f) => (
                <li key={f.key} className="flex flex-wrap items-center gap-x-3 gap-y-1.5 border-b border-hairline px-4 py-2 last:border-0">
                  <div className="min-w-0 flex-1">
                    <p className="truncate font-semibold text-ink">{f.title}</p>
                    <p className="truncate text-micro text-muted">
                      {f.state === "behind" && <>A newer version is in the backup{savedLine(f) && <> ({savedLine(f)})</>}.</>}
                      {f.state === "differs" && <>Changed here{f.editedHere && <> ({relativeTime(f.editedHere)})</>} and in the backup{savedLine(f) && <> ({savedLine(f)})</>}. Pick which to keep.</>}
                      {f.state === "only_backup" && <>Not on this site{savedLine(f) && <> · {savedLine(f)}</>}.</>}
                    </p>
                  </div>
                  {f.state === "behind" && <Button size="sm" variant="secondary" disabled={busy} onClick={() => actions.syncOne(f)}>Sync</Button>}
                  {f.state === "differs" && (
                    <>
                      <Button size="sm" variant="secondary" disabled={busy} onClick={() => actions.syncOne(f)}>Use the backup's</Button>
                      <Button size="sm" variant="secondary" disabled={busy} onClick={() => actions.keep(f)}>Keep this site's</Button>
                    </>
                  )}
                  {f.state === "only_backup" && (
                    <>
                      <Button size="sm" variant="secondary" disabled={busy} onClick={() => actions.syncOne(f)}>Add to this site</Button>
                      <Button size="sm" variant="ghost" disabled={busy} onClick={() => actions.remove(f)}>Remove from backup</Button>
                    </>
                  )}
                </li>
              ))}
            </ul>
          )}
        </>
      )}
    </div>
  );
}
