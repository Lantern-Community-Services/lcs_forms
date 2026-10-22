import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Copy, Sparkles } from "lucide-react";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { LoadingState } from "@/components/ui/misc";
import { useToast } from "@/components/ui/toast";
import { api } from "@/lib/api";
import { errorMessage, formatDate, relativeTime } from "@/lib/utils";

/**
 * Claude connections: people who connected their Claude to the site, which
 * then reads it as them (backend oauth/). Profile shows your own with how to
 * connect; Admin → API keys shows everyone's, so an admin can cut one off.
 */

interface ClaudeConnection {
  id: string;
  client: string;
  scope: string;
  createdAt: string;
  lastUsedAt: string | null;
  user: { id: string; name: string; email: string };
}

const connectionsKey = (all: boolean) => ["oauth", "grants", all ? "all" : "mine"];

function useClaudeConnections(all: boolean) {
  return useQuery({ queryKey: connectionsKey(all), queryFn: () => api.get<ClaudeConnection[]>(`/oauth/grants${all ? "?all=1" : ""}`) });
}

const EXAMPLES = [
  "How many Hot Foods entries did my site log last week?",
  "Make a table of incident reports by site for this month.",
  "Which residents at my site are due for a check?",
];

function ConnectionList({ all }: { all: boolean }) {
  const { data, isLoading } = useClaudeConnections(all);
  const qc = useQueryClient();
  const toast = useToast();

  async function disconnect(c: ClaudeConnection) {
    const whose = all ? `${c.user.name}'s ${c.client}` : c.client;
    if (!confirm(`Disconnect ${whose}? It stops reading Lantern Forms right away, and has to be connected again to come back.`)) return;
    try {
      await api.delete(`/oauth/grants/${c.id}`);
      toast("Disconnected.");
      await qc.invalidateQueries({ queryKey: ["oauth", "grants"] });
    } catch (e) {
      toast(errorMessage(e, "Couldn't disconnect."), "error");
    }
  }

  if (isLoading) return <LoadingState />;
  if (!data?.length) {
    return <p className="mt-3 text-[13px] text-muted">{all ? "Nobody has connected Claude yet." : "Not connected yet."}</p>;
  }
  return (
    <ul className="mt-3">
      {data.map((c) => (
        <li key={c.id} className="flex flex-wrap items-center gap-3 border-b border-hairline py-3 last:border-0">
          <div className="min-w-0 flex-1">
            <p className="text-[13.5px] font-semibold text-ink">{all ? `${c.user.name} · ${c.client}` : c.client}</p>
            <p className="text-micro text-muted">
              {all ? `${c.user.email} · ` : ""}read only · connected {formatDate(c.createdAt)} · {c.lastUsedAt ? `used ${relativeTime(c.lastUsedAt)}` : "not used yet"}
            </p>
          </div>
          <Button size="sm" variant="outlineDanger" onClick={() => void disconnect(c)}>Disconnect</Button>
        </li>
      ))}
    </ul>
  );
}

/** Profile: how to connect, what to ask, and your connections. */
export function ClaudeProfileCard({ delay }: { delay?: string }) {
  const toast = useToast();
  const address = `${typeof window === "undefined" ? "" : window.location.origin}/api/mcp`;

  async function copy() {
    try {
      await navigator.clipboard.writeText(address);
      toast("Copied.");
    } catch {
      toast("Couldn't copy. Select the address and copy it instead.", "error");
    }
  }

  return (
    <Card className="page-list-item-enter mb-4 p-5" style={{ animationDelay: delay }}>
      <p className="kicker flex items-center gap-1.5"><Sparkles className="h-3.5 w-3.5" /> Claude</p>
      <p className="mt-1 text-[13px] text-muted">
        Connect your Claude account and ask it about the site: counts, summaries and reports from the forms, entries,
        residents and calendar you can see here. Claude can only read, and only what you can see.
      </p>
      <p className="mt-3 text-[13px] text-ink">
        In Claude (the website, desktop app or phone app), open <strong>Settings → Connectors</strong>, find{" "}
        <strong>Lantern Forms</strong> and choose <strong>Connect</strong>. You'll come back here to sign in and allow it.
      </p>
      <p className="mt-3 text-micro text-muted">Try asking:</p>
      <ul className="mt-1 list-disc pl-5 text-[13px] text-ink">
        {EXAMPLES.map((e) => <li key={e}>{e}</li>)}
      </ul>
      <div className="mt-3 flex flex-wrap items-center gap-2 text-micro text-muted">
        <span>Not listed in Claude? The connector address is</span>
        <code className="rounded bg-subtle2 px-1.5 py-0.5 text-ink">{address}</code>
        <Button size="sm" variant="ghost" onClick={() => void copy()} aria-label="Copy the connector address"><Copy className="h-3.5 w-3.5" /></Button>
      </div>
      <ConnectionList all={false} />
    </Card>
  );
}

/** Admin → API keys: everyone's connections. */
export function ClaudeConnectionsAdmin() {
  return (
    <Card className="mt-6 p-5">
      <p className="kicker">Claude connections</p>
      <p className="mt-1 text-[13px] text-muted">
        People who connected their own Claude. Each reads the site as that person, read only, and stops when they lose
        access. No key is involved: they sign in with Microsoft and allow it.
      </p>
      <ConnectionList all />
    </Card>
  );
}
