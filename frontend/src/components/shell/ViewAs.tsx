import { useDeferredValue, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Eye, FileText, UserCog } from "lucide-react";
import { Link } from "react-router-dom";
import { Avatar } from "@/components/ui/avatar";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { SearchInput } from "@/components/ui/input";
import { LoadingState } from "@/components/ui/misc";
import { ResponsiveDialog } from "@/components/ui/responsive-dialog";
import { Switch } from "@/components/ui/switch";
import { useToast } from "@/components/ui/toast";
import { api } from "@/lib/api";
import { useAuth } from "@/lib/auth";
import { cn, errorMessage } from "@/lib/utils";

/**
 * View as: a Super Admin (or an Admin one has let) sees the whole site as
 * someone else, to check what it looks like for them. The server swaps who
 * every request runs as (backend auth/middleware.ts). Read only unless they
 * act as them (IT support): then changes go through in that person's name, and
 * the audit log says who really made them. Starting, switching and stopping
 * reload the page, so nothing fetched as one person is shown as another.
 */

type Candidate = { id: string; name: string; email: string; title: string | null; roleName: string; avatarColor: string | null; sites: string[] };

async function change(go: () => Promise<unknown>) {
  await go();
  window.location.assign("/");
}
export const startViewAs = (userId: string, act = false) => change(() => api.post("/auth/view-as", { userId, act }));
export const stopViewAs = () => change(() => api.delete("/auth/view-as"));
const setActing = (act: boolean) => change(() => api.patch("/auth/view-as", { act }));

/** The "Act as them" switch's explanation, wherever it's offered. */
const ACT_HINT = "Changes go through in their name: forms, roster, calendar, everything they can do. The audit log records that you made them.";

/** Pick whom to view the site as. */
export function ViewAsPicker({ open, onOpenChange }: { open: boolean; onOpenChange: (open: boolean) => void }) {
  const toast = useToast();
  const [q, setQ] = useState("");
  const query = useDeferredValue(q.trim());
  const [busy, setBusy] = useState<string | null>(null);
  const [act, setAct] = useState(false);
  const { data, isLoading } = useQuery({
    queryKey: ["view-as", "people", query],
    queryFn: () => api.get<Candidate[]>(`/auth/view-as/people?q=${encodeURIComponent(query)}`),
    enabled: open,
  });

  async function pick(p: Candidate) {
    setBusy(p.id);
    try {
      await startViewAs(p.id, act);
    } catch (e) {
      toast(errorMessage(e, `Couldn't view the site as ${p.name}.`), "error");
      setBusy(null);
    }
  }

  return (
    <ResponsiveDialog open={open} onOpenChange={onOpenChange} title="View the site as…">
      <div className="flex flex-col gap-3">
        <p className="text-[13px] text-muted">
          See every screen as they would: their role, sites and forms. Nothing can be changed unless you act as them.
        </p>
        <label className="flex cursor-pointer items-start justify-between gap-3 rounded-input border border-hairline px-3 py-2.5">
          <span>
            <span className="block text-[13.5px] font-semibold text-ink">Act as them</span>
            <span className="block text-micro text-muted">{ACT_HINT}</span>
          </span>
          <Switch checked={act} onCheckedChange={setAct} className="mt-0.5" />
        </label>
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

type FormRow = { kind: "basic" | "code"; slug: string; title: string; status: string; live: boolean };

/**
 * Every form on the site, drafts included, to open as the person being viewed. A draft isn't in their
 * catalog (nobody but its builders can find it), so this is how to try one out as them.
 */
function ViewAsForms({ open, onOpenChange, name }: { open: boolean; onOpenChange: (open: boolean) => void; name: string }) {
  const [q, setQ] = useState("");
  const { data, isLoading } = useQuery({ queryKey: ["view-as", "forms"], queryFn: () => api.get<FormRow[]>("/auth/view-as/forms"), enabled: open });
  const needle = q.trim().toLowerCase();
  const shown = (data ?? []).filter((f) => !needle || f.title.toLowerCase().includes(needle) || f.slug.includes(needle));
  const href = (f: FormRow) => (f.kind === "code" ? `/apps/${f.slug}${f.live ? "" : "?draft=1"}` : `/f/${f.slug}`);
  return (
    <ResponsiveDialog open={open} onOpenChange={onOpenChange} title={`Open a form as ${name}`}>
      <div className="flex flex-col gap-3">
        <p className="text-[13px] text-muted">Drafts included. A form opens as it would for {name}: if it isn't open to them, it says so.</p>
        <SearchInput autoFocus value={q} onChange={(e) => setQ(e.target.value)} placeholder="Form name" aria-label="Search forms" />
        {isLoading ? (
          <LoadingState />
        ) : !shown.length ? (
          <p className="px-1 py-4 text-center text-[13px] text-muted">No form matches.</p>
        ) : (
          <ul className="-mx-1 flex max-h-[50vh] flex-col overflow-y-auto">
            {shown.map((f) => (
              <li key={`${f.kind}:${f.slug}`}>
                <Link
                  to={href(f)}
                  onClick={() => onOpenChange(false)}
                  className="flex min-h-[44px] w-full items-center gap-3 rounded-input px-2 py-2 text-left hover:bg-rowhover"
                >
                  <FileText className="h-4 w-4 shrink-0 text-muted" aria-hidden />
                  <span className="min-w-0 flex-1 truncate text-[14px] text-ink">{f.title}</span>
                  {!f.live && <span className="rounded-pill bg-status-violetBg px-2 py-0.5 text-micro font-bold text-status-violetText">Draft</span>}
                </Link>
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
        See the whole site as someone else sees it: their role, sites, forms and entries. It's read only unless you act as them (for IT support), and a strip along the top takes you back.
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
  const [forms, setForms] = useState(false);
  const [busy, setBusy] = useState(false);
  if (!user?.viewAs) return null;

  const acting = user.viewAs.act;
  async function toggleActing() {
    if (!acting && !window.confirm(`Act as ${user!.name}? ${ACT_HINT}`)) return;
    setBusy(true);
    try {
      await setActing(!acting);
    } catch (e) {
      toast(errorMessage(e, "Couldn't change that."), "error");
      setBusy(false);
    }
  }

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
        "flex flex-none flex-wrap items-center gap-x-3 gap-y-1.5 border-b px-4 pb-1.5 text-[12.5px] md:px-7",
        // Acting changes things for real: red, so it's never mistaken for just looking.
        acting ? "border-status-redDot/40 bg-status-redBg text-status-redText" : "border-status-violetDot/40 bg-status-violetBg text-status-violetText",
        top ? "pt-[max(6px,var(--safe-top))]" : "pt-1.5"
      )}
    >
      <span className="flex min-w-0 flex-1 items-center gap-2">
        {acting ? <UserCog className="h-3.5 w-3.5 shrink-0" aria-hidden /> : <Eye className="h-3.5 w-3.5 shrink-0" aria-hidden />}
        <span className="min-w-0">
          {acting ? "Acting as" : "Viewing as"} <strong className="font-semibold">{user.name}</strong> ({user.role.name}).{" "}
          {acting ? `Changes are made in their name and logged as ${user.viewAs.name}.` : "Nothing can be changed."}
        </span>
      </span>
      <span className="flex items-center gap-1">
        <Button variant="ghost" size="sm" disabled={busy} onClick={() => void toggleActing()}>{acting ? "View only" : "Act as them"}</Button>
        {user.viewAs.drafts && <Button variant="ghost" size="sm" disabled={busy} onClick={() => setForms(true)}>Forms</Button>}
        <Button variant="ghost" size="sm" disabled={busy} onClick={() => setPicking(true)}>Switch</Button>
        <Button variant="secondary" size="sm" disabled={busy} onClick={() => void stop()}>Stop viewing</Button>
      </span>
      <ViewAsPicker open={picking} onOpenChange={setPicking} />
      {user.viewAs.drafts && <ViewAsForms open={forms} onOpenChange={setForms} name={user.name} />}
    </div>
  );
}
