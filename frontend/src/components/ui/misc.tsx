import { Loader2, Sparkles, Inbox } from "lucide-react";
import { cn } from "@/lib/utils";
import { Button } from "./button";

export function Spinner({ className }: { className?: string }) {
  return <Loader2 className={cn("h-5 w-5 animate-spin text-muted", className)} />;
}

export function LoadingState({ label = "Loading…" }: { label?: string }) {
  return (
    <div className="flex items-center justify-center gap-2 py-16 text-muted">
      <Spinner /> <span className="text-[13.5px]">{label}</span>
    </div>
  );
}

export function EmptyState({ title, hint, icon }: { title: string; hint?: string; icon?: React.ReactNode }) {
  return (
    <div className="flex flex-col items-center justify-center gap-2 py-16 text-center">
      <div className="mb-1 text-muted">{icon ?? <Inbox className="h-8 w-8" />}</div>
      <p className="text-[15px] font-semibold text-ink">{title}</p>
      {hint && <p className="max-w-sm text-[13px] text-muted">{hint}</p>}
    </div>
  );
}

/** The button under a paged list that fetches the next page. */
export function LoadMore({ loading, onClick, children = "Load more" }: { loading: boolean; onClick: () => void; children?: React.ReactNode }) {
  return (
    <div className="flex justify-center py-5">
      <Button variant="secondary" disabled={loading} onClick={onClick}>
        {loading ? "Loading…" : children}
      </Button>
    </div>
  );
}

/**
 * The teal "AI-suggested" indicator. Renders ONLY when a field carries an AI
 * flag that hasn't been verified — dormant under manual extraction.
 */
export function AiSparkle({ meta }: { meta?: { aiSuggested?: boolean; verified?: boolean } }) {
  if (!meta?.aiSuggested || meta.verified) return null;
  return <Sparkles className="inline h-3.5 w-3.5 text-teal" aria-label="Auto-filled by AI" />;
}

/** Returns the `ln-ai` tint class only for unverified AI fields (dormant otherwise). */
export function aiTintClass(meta?: { aiSuggested?: boolean; verified?: boolean }): string {
  return meta?.aiSuggested && !meta.verified ? "ln-ai" : "";
}
