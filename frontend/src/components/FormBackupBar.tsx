import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { AlertTriangle, CloudUpload, Loader2 } from "lucide-react";
import { api } from "@/lib/api";
import { Button } from "@/components/ui/button";
import { useToast } from "@/components/ui/toast";
import { cn, errorMessage, relativeTime } from "@/lib/utils";

/** The GitHub backup of every built form (backend services/formBackup.ts), on the builder lists. */

interface BackupStatus {
  configured: boolean;
  repo: string | null;
  running: boolean;
  lastCheckedAt: string | null;
  lastCommitAt: string | null;
  lastCommitUrl: string | null;
  lastError: string | null;
}

export function FormBackupBar({ className }: { className?: string }) {
  const qc = useQueryClient();
  const toast = useToast();
  const { data } = useQuery({ queryKey: ["form-backup"], queryFn: () => api.get<BackupStatus>("/admin/form-backup"), refetchInterval: 60_000 });
  const run = useMutation({
    mutationFn: () => api.post<BackupStatus>("/admin/form-backup"),
    onSuccess: (s) => {
      qc.setQueryData(["form-backup"], s);
      toast(s.lastError ? `Backup failed: ${s.lastError}` : "Forms backed up.", s.lastError ? "error" : "success");
    },
    onError: (e) => toast(errorMessage(e, "The backup didn't run."), "error"),
  });
  if (!data) return null;
  const repoName = data.repo?.split("/").pop();
  const repoUrl = data.repo ? `https://github.com/${data.repo}` : null;

  return (
    <div className={cn("mb-4 flex flex-wrap items-center gap-x-3 gap-y-2 rounded-card border border-hairline bg-surface px-4 py-2.5 text-[13px]", className)}>
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
              <> · up to date (checked {relativeTime(data.lastCheckedAt)})</>
            ) : (
              <> · checks every 10 minutes</>
            )}
            .
          </>
        )}
      </p>
      {data.configured && (
        <Button size="sm" variant="secondary" onClick={() => run.mutate()} disabled={run.isPending || data.running}>
          {run.isPending || data.running ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : null} Back up now
        </Button>
      )}
    </div>
  );
}
