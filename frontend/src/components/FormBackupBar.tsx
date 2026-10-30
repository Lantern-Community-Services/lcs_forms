import { useEffect, useRef, useState } from "react";
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
 *
 * Sync, Keep, Remove and Back up now queue a job on the server and come straight back, so several
 * can be clicked in a row; the jobs run one at a time in the background while this polls.
 */

type Kind = "basic" | "code";
type SyncState = "in_sync" | "behind" | "differs" | "only_backup";
type JobAction = "sync" | "keep" | "remove" | "backup";

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
  jobs: { id: number; action: JobAction; key: string | null; running: boolean; by: string }[];
  results: { id: number; action: JobAction; key: string | null; ok: boolean; error: string | null; at: string }[];
}

const KEY = ["form-backup"];
const useBackupStatus = () =>
  useQuery({
    queryKey: KEY,
    queryFn: () => api.get<BackupStatus>("/admin/form-backup"),
    // Quick while jobs are queued, so each form's label changes as its job finishes.
    refetchInterval: (q) => (q.state.data?.jobs.length ? 2_000 : 60_000),
  });

const savedLine = (f: FormSync) =>
  f.backup?.savedAt ? `saved ${relativeTime(f.backup.savedAt)}${f.backup.savedFrom ? ` from ${f.backup.savedFrom}` : ""}` : f.backup?.savedFrom ? `from ${f.backup.savedFrom}` : "";

const DONE: Record<JobAction, string> = { sync: "Synced", keep: "Saved this site's version of", remove: "Removed from the backup:", backup: "Backed up" };
const FAILED: Record<JobAction, string> = { sync: "Couldn't sync", keep: "Couldn't save", remove: "Couldn't remove", backup: "The backup failed" };
const RUNNING: Record<JobAction, string> = { sync: "Syncing…", keep: "Saving…", remove: "Removing…", backup: "Backing up…" };

/** Sync / keep / remove, shared by the bar and the row labels: each queues a job. */
function useBackupActions(data: BackupStatus | undefined) {
  const qc = useQueryClient();
  const toast = useToast();
  const queue = useMutation({
    mutationFn: ({ path, body }: { path: string; body?: unknown }) => api.post<BackupStatus>(`/admin/form-backup${path}`, body),
    onSuccess: (s) => qc.setQueryData(KEY, s),
    onError: (e) => toast(errorMessage(e, "That didn't get queued."), "error"),
  });
  /** The queued or running job for a form, if any. */
  const jobOf = (key: string | null) => data?.jobs.find((j) => j.key === key);
  return {
    jobOf,
    syncOne(f: FormSync) {
      if (f.state === "differs" && !confirm(`“${f.title}” was changed here too. Replace this site's draft with the backup's version${savedLine(f) ? ` (${savedLine(f)})` : ""}? Published versions stay in its history.`)) return;
      queue.mutate({ path: "/sync", body: { keys: [f.key] } });
    },
    syncAll: () => queue.mutate({ path: "/sync", body: { all: true } }),
    keep: (f: FormSync) => {
      if (confirm(`Save this site's “${f.title}” over the backup's version${savedLine(f) ? ` (${savedLine(f)})` : ""}? Other sites will then see theirs as needing sync.`)) queue.mutate({ path: "/keep", body: { key: f.key } });
    },
    remove: (f: FormSync) => {
      if (confirm(`Remove “${f.title}” from the backup? No site will be able to sync it in afterwards.`)) queue.mutate({ path: "/remove", body: { key: f.key } });
    },
    backupNow: () => queue.mutate({ path: "" }),
  };
}

/** A form's button, or what's happening to it when it has a job queued. */
function JobButton({ job, onClick, children, variant = "secondary" }: { job: BackupStatus["jobs"][number] | undefined; onClick: () => void; children: React.ReactNode; variant?: "secondary" | "ghost" }) {
  if (job) {
    return (
      <span className="inline-flex items-center gap-1.5 text-[12.5px] font-semibold text-muted">
        {job.running ? <><Loader2 className="h-3.5 w-3.5 animate-spin" /> {RUNNING[job.action]}</> : "Queued"}
      </span>
    );
  }
  return <Button size="sm" variant={variant} onClick={onClick}>{children}</Button>;
}

/** The label on a form's row when it isn't in sync with the backup, with its Sync button. */
export function BackupSyncLabel({ kind, slug }: { kind: Kind; slug: string }) {
  const { data } = useBackupStatus();
  const actions = useBackupActions(data);
  const f = data?.forms.find((x) => x.kind === kind && x.slug === slug);
  if (!f || (f.state !== "behind" && f.state !== "differs")) return null;
  const behind = f.state === "behind";
  return (
    <span className="inline-flex items-center gap-1.5" title={`The backup's version: ${savedLine(f) || "unknown"}`}>
      <ToneBadge tone={behind ? "amber" : "red"}>{behind ? "Needs sync" : "Differs from backup"}</ToneBadge>
      <JobButton job={actions.jobOf(f.key)} onClick={() => actions.syncOne(f)}>
        <RefreshCw className="h-3.5 w-3.5" /> Sync
      </JobButton>
    </span>
  );
}

/** Toasts as queued jobs finish, and a refresh of the form list when one changed a form. */
function useJobResults(data: BackupStatus | undefined, listKey: readonly unknown[]) {
  const qc = useQueryClient();
  const toast = useToast();
  const seen = useRef<number | null>(null);
  useEffect(() => {
    if (!data) return;
    const last = data.results.at(-1)?.id ?? 0;
    if (seen.current === null) {
      seen.current = last; // results from before this page opened aren't news
      return;
    }
    const fresh = data.results.filter((r) => r.id > seen.current!);
    seen.current = Math.max(seen.current, last);
    if (!fresh.length) return;
    void qc.invalidateQueries({ queryKey: listKey });
    const name = (key: string | null) => (key ? data.forms.find((f) => f.key === key)?.title ?? key.split("/")[1] : "");
    for (const r of fresh.filter((r) => !r.ok)) toast(`${FAILED[r.action]} ${name(r.key)}: ${r.error}`, "error");
    const ok = fresh.filter((r) => r.ok);
    if (ok.length === 1) toast(`${DONE[ok[0].action]} ${name(ok[0].key)}`.trim() + ".", "success");
    else if (ok.length > 1) toast(`${ok.length} backup jobs done.`, "success");
  }, [data, listKey, qc, toast]);
}

export function FormBackupBar({ className, kind, listKey }: { className?: string; kind: Kind; listKey: readonly unknown[] }) {
  const [open, setOpen] = useState(false);
  const { data } = useBackupStatus();
  const actions = useBackupActions(data);
  useJobResults(data, listKey);
  if (!data) return null;
  const repoName = data.repo?.split("/").pop();
  const repoUrl = data.repo ? `https://github.com/${data.repo}` : null;
  const mine = data.forms.filter((f) => f.kind === kind);
  const behind = mine.filter((f) => f.state === "behind");
  const differs = mine.filter((f) => f.state === "differs");
  const onlyBackup = mine.filter((f) => f.state === "only_backup");
  const unqueued = behind.filter((f) => !actions.jobOf(f.key));
  const backupJob = actions.jobOf(null);
  const waiting = data.jobs.length;

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
          {waiting > 0 && <span className="text-ink"> {waiting} job{waiting === 1 ? "" : "s"} running in the background.</span>}
        </p>
        {data.configured && (
          <>
            {unqueued.length > 0 && (
              <Button size="sm" onClick={actions.syncAll} title="Bring in every form whose backup is newer">
                <RefreshCw className="h-3.5 w-3.5" /> Sync all ({unqueued.length})
              </Button>
            )}
            <JobButton job={backupJob} onClick={actions.backupNow}>Back up now</JobButton>
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
              {mine.map((f) => {
                const job = actions.jobOf(f.key);
                return (
                  <li key={f.key} className="flex flex-wrap items-center gap-x-3 gap-y-1.5 border-b border-hairline px-4 py-2 last:border-0">
                    <div className="min-w-0 flex-1">
                      <p className="truncate font-semibold text-ink">{f.title}</p>
                      <p className="truncate text-micro text-muted">
                        {f.state === "behind" && <>A newer version is in the backup{savedLine(f) && <> ({savedLine(f)})</>}.</>}
                        {f.state === "differs" && <>Changed here{f.editedHere && <> ({relativeTime(f.editedHere)})</>} and in the backup{savedLine(f) && <> ({savedLine(f)})</>}. Pick which to keep.</>}
                        {f.state === "only_backup" && <>Not on this site{savedLine(f) && <> · {savedLine(f)}</>}.</>}
                      </p>
                    </div>
                    {job ? (
                      <JobButton job={job} onClick={() => undefined}>{null}</JobButton>
                    ) : (
                      <>
                        {f.state === "behind" && <Button size="sm" variant="secondary" onClick={() => actions.syncOne(f)}>Sync</Button>}
                        {f.state === "differs" && (
                          <>
                            <Button size="sm" variant="secondary" onClick={() => actions.syncOne(f)}>Use the backup's</Button>
                            <Button size="sm" variant="secondary" onClick={() => actions.keep(f)}>Keep this site's</Button>
                          </>
                        )}
                        {f.state === "only_backup" && (
                          <>
                            <Button size="sm" variant="secondary" onClick={() => actions.syncOne(f)}>Add to this site</Button>
                            <Button size="sm" variant="ghost" onClick={() => actions.remove(f)}>Remove from backup</Button>
                          </>
                        )}
                      </>
                    )}
                  </li>
                );
              })}
            </ul>
          )}
        </>
      )}
    </div>
  );
}
