import { useDeferredValue, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Eye } from "lucide-react";
import { Avatar } from "@/components/ui/avatar";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { SearchInput } from "@/components/ui/input";
import { LoadingState } from "@/components/ui/misc";
import { ResponsiveDialog } from "@/components/ui/responsive-dialog";
import { useToast } from "@/components/ui/toast";
import { api } from "@/lib/api";
import { useAuth } from "@/lib/auth";
import { cn, errorMessage } from "@/lib/utils";

/**
 * View as: a Super Admin (or an Admin one has let) sees the whole site as
 * someone else, to check what it looks like for them. The server swaps who
 * every request runs as (backend auth/middleware.ts) and refuses changes
 * meanwhile, so it's read only. Starting, switching and stopping reload the
 * page, so nothing fetched as one person is shown as another.
 */

type Candidate = { id: string; name: string; email: string; title: string | null; roleName: string; avatarColor: string | null; sites: string[] };

async function change(go: () => Promise<unknown>) {
  await go();
  window.location.assign("/");
}
export const startViewAs = (userId: string) => change(() => api.post("/auth/view-as", { userId }));
export const stopViewAs = () => change(() => api.delete("/auth/view-as"));

/** Pick whom to view the site as. */
export function ViewAsPicker({ open, onOpenChange }: { open: boolean; onOpenChange: (open: boolean) => void }) {
  const toast = useToast();
  const [q, setQ] = useState("");
  const query = useDeferredValue(q.trim());
  const [busy, setBusy] = useState<string | null>(null);
  const { data, isLoading } = useQuery({
    queryKey: ["view-as", "people", query],
    queryFn: () => api.get<Candidate[]>(`/auth/view-as/people?q=${encodeURIComponent(query)}`),
    enabled: open,
  });

  async function pick(p: Candidate) {
    setBusy(p.id);
    try {
      await startViewAs(p.id);
    } catch (e) {
      toast(errorMessage(e, `Couldn't view the site as ${p.name}.`), "error");
      setBusy(null);
    }
  }

  return (
    <ResponsiveDialog open={open} onOpenChange={onOpenChange} title="View the site as…">
      <div className="flex flex-col gap-3">
        <p className="text-[13px] text-muted">
          See every screen as they would: their role, sites and forms. Nothing can be changed while you do.
        </p>
        <SearchInput autoFocus value={q} onChange={(e) => setQ(e.target.value)} placeholder="Name, email or job title" aria-label="Search people" />
        {isLoading ? (
          <LoadingState />
        ) : !data?.length ? (
          <p className="px-1 py-4 text-center text-[13px] text-muted">Nobody matches.</p>
        ) : (
          <ul className="-mx-1 flex max-h-[50vh] flex-col overflow-y-auto">
            {data.map((p) => (
              <li key={p.id}>
                <button
                  type="button"
                  disabled={busy !== null}
                  onClick={() => void pick(p)}
                  className="flex min-h-[52px] w-full items-center gap-3 rounded-input px-2 py-2 text-left hover:bg-rowhover disabled:opacity-60"
                >
                  <Avatar name={p.name} color={p.avatarColor} size={32} />
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-[14px] font-semibold text-ink">{p.name}</span>
                    <span className="block truncate text-micro text-muted">
                      {[p.title, p.roleName, p.sites.length ? p.sites.join(", ") : null].filter(Boolean).join(" · ")}
                    </span>
                  </span>
                  {busy === p.id && <span className="text-micro text-muted">Opening…</span>}
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>
    </ResponsiveDialog>
  );
}

/** Profile: the way in, for whoever may view as others (not shown while they already are: the bar does that). */
export function ViewAsCard({ delay }: { delay?: string }) {
  const { user } = useAuth();
  const [picking, setPicking] = useState(false);
  if (!user?.canViewAs || user.viewAs) return null;
  return (
    <Card className="page-list-item-enter mb-4 p-5" style={{ animationDelay: delay }}>
      <p className="kicker flex items-center gap-1.5"><Eye className="h-3.5 w-3.5" /> View as</p>
      <p className="mt-1 text-[13px] text-muted">
        See the whole site as someone else sees it: their role, sites, forms and entries. Nothing can be changed while you do, and a strip along the top takes you back.
      </p>
      <Button variant="secondary" className="mt-3" onClick={() => setPicking(true)}>
        <Eye className="h-4 w-4" /> View the site as…
      </Button>
      <ViewAsPicker open={picking} onOpenChange={setPicking} />
    </Card>
  );
}

/** Above every screen while viewing as someone: who, and the way back. `top`: nothing above it, so it clears the status bar itself. */
export function ViewAsBar({ top }: { top: boolean }) {
  const { user } = useAuth();
  const toast = useToast();
  const [picking, setPicking] = useState(false);
  const [busy, setBusy] = useState(false);
  if (!user?.viewAs) return null;

  async function stop() {
    setBusy(true);
    try {
      await stopViewAs();
    } catch (e) {
      toast(errorMessage(e, "Couldn't stop viewing as them."), "error");
      setBusy(false);
    }
  }

  return (
    <div
      role="status"
      className={cn(
        "flex flex-none flex-wrap items-center gap-x-3 gap-y-1.5 border-b border-status-violetDot/40 bg-status-violetBg px-4 pb-1.5 text-[12.5px] text-status-violetText md:px-7",
        top ? "pt-[max(6px,var(--safe-top))]" : "pt-1.5"
      )}
    >
      <span className="flex min-w-0 flex-1 items-center gap-2">
        <Eye className="h-3.5 w-3.5 shrink-0" aria-hidden />
        <span className="min-w-0">
          Viewing as <strong className="font-semibold">{user.name}</strong> ({user.role.name}). Nothing can be changed.
        </span>
      </span>
      <span className="flex items-center gap-1">
        <Button variant="ghost" size="sm" disabled={busy} onClick={() => setPicking(true)}>Switch</Button>
        <Button variant="secondary" size="sm" disabled={busy} onClick={() => void stop()}>Stop viewing</Button>
      </span>
      <ViewAsPicker open={picking} onOpenChange={setPicking} />
    </div>
  );
}
