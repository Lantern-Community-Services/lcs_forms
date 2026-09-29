import { useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { Copy, Plus, Send, Trash2 } from "lucide-react";
import { Page, PageHeader } from "@/components/shell/AppShell";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Field } from "@/components/ui/label";
import { Select } from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { ToneBadge } from "@/components/ui/badge";
import { Dialog, DialogBody, DialogContent, DialogFooter, DialogHeader } from "@/components/ui/dialog";
import { EmptyState, LoadingState } from "@/components/ui/misc";
import { useToast } from "@/components/ui/toast";
import { api } from "@/lib/api";
import { useApiKeys, useSites, useWebhooks } from "@/lib/queries";
import { errorMessage, formatDate, relativeTime } from "@/lib/utils";

function useCopy() {
  const toast = useToast();
  return (text: string) =>
    navigator.clipboard.writeText(text).then(
      () => toast("Copied."),
      () => toast("Copy failed — select and copy it by hand.", "error")
    );
}

/** A secret shown exactly once, with a copy button. */
function OnceSecret({ label, value, onDone }: { label: string; value: string; onDone: () => void }) {
  const copy = useCopy();
  return (
    <Dialog open onOpenChange={(o) => !o && onDone()}>
      <DialogContent aria-describedby={undefined}>
        <DialogHeader title={label} subtitle="Copy it now — it won't be shown again." />
        <DialogBody>
          <div className="flex items-center gap-2 rounded-input border border-hairline bg-subtle p-2">
            <code className="min-w-0 flex-1 break-all text-[12.5px] text-ink">{value}</code>
            <Button size="sm" variant="secondary" onClick={() => copy(value)}><Copy className="h-3.5 w-3.5" /></Button>
          </div>
        </DialogBody>
        <DialogFooter><Button onClick={onDone}>Done</Button></DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/** Must match API_SCOPES in backend/src/services/apiKeys.ts. */
export const API_SCOPE_OPTIONS = [
  { scope: "roster:read", label: "Read rosters" },
  { scope: "activity:write", label: "Report form activity" },
  { scope: "forms:build", label: "Build basic forms (AI form builder / MCP)" },
  { scope: "apps:build", label: "Build code forms: files, server code, publish (AI / MCP)" },
  { scope: "entries:read", label: "Read built forms' entries" },
  { scope: "entries:write", label: "Submit entries to built forms" },
];

export function AdminApiKeys() {
  const { data: keys, isLoading } = useApiKeys();
  const { data: sites } = useSites(true);
  const [creating, setCreating] = useState<{ name: string; scopes: string[]; siteId: string } | null>(null);
  const [secret, setSecret] = useState<string | null>(null);
  const qc = useQueryClient();
  const toast = useToast();
  const refresh = () => qc.invalidateQueries({ queryKey: ["admin", "api-keys"] });

  async function create() {
    if (!creating) return;
    const scopes = creating.scopes;
    try {
      const res = await api.post<{ key: string }>("/admin/api-keys", { name: creating.name, scopes, siteId: creating.siteId || null });
      setCreating(null);
      setSecret(res.key);
      await refresh();
    } catch (e) {
      toast(errorMessage(e, "Could not create key."), "error");
    }
  }

  async function revoke(id: string) {
    if (!confirm("Revoke this key? Anything using it stops working immediately.")) return;
    await api.delete(`/admin/api-keys/${id}`);
    toast("Key revoked.");
    await refresh();
  }

  return (
    <Page className="max-w-[900px]">
      <PageHeader
        title="API keys"
        subtitle="For WordPress, Power Automate and anything else that reads rosters or reports form activity."
        actions={<Button onClick={() => setCreating({ name: "", scopes: ["roster:read", "activity:write"], siteId: "" })}><Plus className="h-4 w-4" /> New key</Button>}
      />
      {isLoading ? <LoadingState /> : !keys?.length ? (
        <Card><EmptyState title="No API keys yet" hint="Create one for the WordPress connector." /></Card>
      ) : (
        <Card>
          <ul>
            {keys.map((k) => (
              <li key={k.id} className="flex flex-wrap items-center gap-3 border-b border-hairline px-4 py-3 last:border-0">
                <div className="min-w-0 flex-1">
                  <p className="text-[13.5px] font-semibold text-ink">{k.name}</p>
                  <p className="text-micro text-muted">
                    <code>{k.prefix}…</code> · {k.scopes.split(",").join(", ")} · {k.site?.name ?? "all sites"} · created {formatDate(k.createdAt)} ·{" "}
                    {k.lastUsedAt ? `used ${relativeTime(k.lastUsedAt)}` : "never used"}
                  </p>
                </div>
                {k.revokedAt ? <ToneBadge tone="neutral">Revoked</ToneBadge> : (
                  <Button size="sm" variant="outlineDanger" onClick={() => revoke(k.id)}>Revoke</Button>
                )}
              </li>
            ))}
          </ul>
        </Card>
      )}

      <Dialog open={Boolean(creating)} onOpenChange={(o) => !o && setCreating(null)}>
        <DialogContent aria-describedby={undefined}>
          <DialogHeader title="New API key" />
          {creating && (
            <DialogBody className="grid gap-3">
              <Field label="Name"><Input value={creating.name} onChange={(e) => setCreating({ ...creating, name: e.target.value })} placeholder="forms.lanterncommunity.org" /></Field>
              <Field label="Can">
                {API_SCOPE_OPTIONS.map((o) => (
                  <label key={o.scope} className="mt-1 flex items-start gap-2 text-[13.5px] text-ink first:mt-0">
                    <input type="checkbox" className="mt-1" checked={creating.scopes.includes(o.scope)} onChange={(e) => setCreating({ ...creating, scopes: e.target.checked ? [...creating.scopes, o.scope] : creating.scopes.filter((x) => x !== o.scope) })} />
                    <span>{o.label} (<code>{o.scope}</code>)</span>
                  </label>
                ))}
              </Field>
              <Field label="Limit to site" hint="Optional. A site-limited key can't see other sites at all.">
                <Select value={creating.siteId} onChange={(e) => setCreating({ ...creating, siteId: e.target.value })}
                  options={[{ value: "", label: "All sites" }, ...(sites ?? []).map((s) => ({ value: s.id, label: s.name }))]} />
              </Field>
            </DialogBody>
          )}
          <DialogFooter>
            <Button variant="secondary" onClick={() => setCreating(null)}>Cancel</Button>
            <Button onClick={create} disabled={!creating?.name || !creating.scopes.length}>Create key</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
      {secret && <OnceSecret label="Your new API key" value={secret} onDone={() => setSecret(null)} />}
    </Page>
  );
}

export function AdminWebhooks() {
  const { data, isLoading } = useWebhooks();
  const [creating, setCreating] = useState<{ name: string; url: string; events: string[] } | null>(null);
  const [secret, setSecret] = useState<string | null>(null);
  const qc = useQueryClient();
  const toast = useToast();
  const refresh = () => qc.invalidateQueries({ queryKey: ["admin", "webhooks"] });

  async function create() {
    if (!creating) return;
    try {
      const res = await api.post<{ secret: string }>("/admin/webhooks", creating);
      setCreating(null);
      setSecret(res.secret);
      await refresh();
    } catch (e) {
      toast(errorMessage(e, "Could not add webhook."), "error");
    }
  }
  async function test(id: string) {
    const r = await api.post<{ ok: boolean; status: number | null; error: string | null }>(`/admin/webhooks/${id}/test`);
    toast(r.ok ? `Delivered (HTTP ${r.status}).` : `Failed: ${r.error}`, r.ok ? "success" : "error");
    await refresh();
  }

  return (
    <Page className="max-w-[900px]">
      <PageHeader
        title="Webhooks"
        subtitle="Roster changes are POSTed here, signed with HMAC-SHA256 (X-Lantern-Signature). WordPress uses this to refresh form dropdowns instantly."
        actions={<Button onClick={() => setCreating({ name: "", url: "", events: ["*"] })}><Plus className="h-4 w-4" /> Add webhook</Button>}
      />
      {isLoading ? <LoadingState /> : !data?.items.length ? (
        <Card><EmptyState title="No webhooks yet" hint="Point one at the WordPress connector's receiver: https://<site>/wp-json/lantern-roster/v1/webhook" /></Card>
      ) : (
        <div className="grid gap-3">
          {data.items.map((h) => (
            <Card key={h.id} className="p-4">
              <div className="flex flex-wrap items-center gap-3">
                <div className="min-w-0 flex-1">
                  <p className="text-[14px] font-semibold text-ink">{h.name}</p>
                  <p className="truncate text-micro text-muted">{h.url} · events: {h.events} · secret {h.secretHint}</p>
                </div>
                <Switch checked={h.active} onCheckedChange={async (v) => { await api.patch(`/admin/webhooks/${h.id}`, { active: v }); await refresh(); }} />
                <Button size="sm" variant="secondary" onClick={() => test(h.id)}><Send className="h-3.5 w-3.5" /> Test</Button>
                <Button size="sm" variant="ghost" onClick={async () => { if (confirm("Remove this webhook?")) { await api.delete(`/admin/webhooks/${h.id}`); await refresh(); } }}><Trash2 className="h-3.5 w-3.5" /></Button>
              </div>
              {h.deliveries.length > 0 && (
                <ul className="mt-3 border-t border-hairline pt-2 text-micro">
                  {h.deliveries.map((d) => (
                    <li key={d.id} className="flex gap-2 py-0.5 text-muted">
                      <span className={d.error ? "text-status-redText" : "text-status-greenText"}>{d.statusCode ?? "—"}</span>
                      <span className="text-ink">{d.event}</span>
                      <span>{relativeTime(d.createdAt)}</span>
                      {d.error && <span className="truncate text-status-redText">{d.error}</span>}
                    </li>
                  ))}
                </ul>
              )}
            </Card>
          ))}
        </div>
      )}

      <Dialog open={Boolean(creating)} onOpenChange={(o) => !o && setCreating(null)}>
        <DialogContent aria-describedby={undefined}>
          <DialogHeader title="Add webhook" />
          {creating && (
            <DialogBody className="grid gap-3">
              <Field label="Name"><Input value={creating.name} onChange={(e) => setCreating({ ...creating, name: e.target.value })} placeholder="WordPress forms site" /></Field>
              <Field label="URL"><Input value={creating.url} onChange={(e) => setCreating({ ...creating, url: e.target.value })} placeholder="https://forms.lanterncommunity.org/wp-json/lantern-roster/v1/webhook" /></Field>
              <Field label="Events">
                <div className="flex flex-wrap gap-2">
                  {["*", ...(data?.events ?? [])].map((ev) => (
                    <label key={ev} className="flex items-center gap-1.5 rounded-pill border border-hairline px-2.5 py-1 text-[12.5px] text-ink">
                      <input type="checkbox" checked={creating.events.includes(ev)}
                        onChange={(e) => {
                          const on = e.target.checked;
                          const events =
                            ev === "*"
                              ? (on ? ["*"] : [])
                              : on
                                ? [...creating.events.filter((x) => x !== "*"), ev]
                                : creating.events.filter((x) => x !== ev);
                          setCreating({ ...creating, events });
                        }} />
                      {ev === "*" ? "Everything" : ev}
                    </label>
                  ))}
                </div>
              </Field>
            </DialogBody>
          )}
          <DialogFooter>
            <Button variant="secondary" onClick={() => setCreating(null)}>Cancel</Button>
            <Button onClick={create} disabled={!creating?.name || !creating?.url || !creating.events.length}>Add</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
      {secret && <OnceSecret label="Webhook signing secret" value={secret} onDone={() => setSecret(null)} />}
    </Page>
  );
}

/** How to wire the roster into forms.lanterncommunity.org. */
export function AdminWordPress() {
  const copy = useCopy();
  const base = `${window.location.origin}/api/v1`;
  const snippet = `// wp-config.php
define('LANTERN_ROSTER_API', '${base}');
define('LANTERN_ROSTER_KEY', 'lrk_…');          // Admin → API keys
define('LANTERN_ROSTER_WEBHOOK_SECRET', 'whsec_…'); // Admin → Webhooks`;

  return (
    <Page className="max-w-[860px]">
      <PageHeader title="WordPress setup" subtitle="Get rosters into Gravity Forms and report form activity back — so the 48-hour queue knows who's still around." />
      <Card className="mb-4 p-5 text-[13.5px] text-ink">
        <ol className="list-decimal space-y-3 pl-5">
          <li>Create an API key with both scopes (Admin → API keys).</li>
          <li>
            Install <code>integrations/wordpress/lantern-roster-connector.php</code> from this repo as a plugin (or mu-plugin) and add to <code>wp-config.php</code>:
            <div className="mt-2 flex items-start gap-2 rounded-input border border-hairline bg-subtle p-3">
              <pre className="min-w-0 flex-1 overflow-x-auto text-[12px]">{snippet}</pre>
              <Button size="sm" variant="secondary" onClick={() => copy(snippet)}><Copy className="h-3.5 w-3.5" /></Button>
            </div>
          </li>
          <li>
            In any Gravity Form, give a Drop Down / Checkboxes / Multi Select field the CSS class <code>lantern-roster</code> and
            <code> lantern-site-amber-hall</code> (the site code). The connector fills it with the live roster; the value stored in the entry is the roster ID.
          </li>
          <li>On submit, the connector posts those IDs to <code>/activity</code>. That resident's review clock resets.</li>
          <li>Add a webhook (Admin → Webhooks) pointing at <code>https://&lt;wp-site&gt;/wp-json/lantern-roster/v1/webhook</code> so dropdowns refresh the moment someone is added or removed.</li>
        </ol>
      </Card>
      <Card className="p-5">
        <p className="kicker mb-2">Endpoints</p>
        <table className="w-full text-[12.5px]">
          <tbody>
            {[
              ["GET", "/sites", "Sites the key can see"],
              ["GET", "/sites/{code}/roster", "Active roster for a site"],
              ["GET", "/sites/{code}/choices", "Gravity Forms-ready [{text, value}]"],
              ["GET", "/roster/changes?since=ISO", "Delta sync, includes removals"],
              ["GET", "/tenants/{id}", "One resident"],
              ["POST", "/activity", "{ label, externalRef, tenantIds[] } or { match: [{site, unit, name}] }"],
            ].map(([m, p, d]) => (
              <tr key={p} className="border-b border-hairline last:border-0">
                <td className="py-1.5 pr-3 font-mono font-bold text-ink">{m}</td>
                <td className="py-1.5 pr-3 font-mono text-ink">{p}</td>
                <td className="py-1.5 text-muted">{d}</td>
              </tr>
            ))}
          </tbody>
        </table>
        <p className="mt-3 text-micro text-muted">Base URL <code>{base}</code> · header <code>Authorization: Bearer lrk_…</code></p>
      </Card>
    </Page>
  );
}
