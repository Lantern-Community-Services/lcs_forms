import { useEffect, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Field } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { Tag } from "@/components/ui/badge";
import { useToast } from "@/components/ui/toast";
import { api } from "@/lib/api";
import { errorMessage, formatDateTime, relativeTime } from "@/lib/utils";
import type { ShareLinkView, SharingSettings } from "@/screens/builtforms/SharePage";

/**
 * A form shared by link, in its editor's Settings (Admins): whether employees
 * can share it, how long a new link lasts and the longest, and everyone's
 * links, any of which can be turned off. Saved straight away, not with Publish.
 */
export function ShareSettings({ formId, live }: { formId: string; live: boolean }) {
  const qc = useQueryClient();
  const toast = useToast();
  const key = ["share", formId, "links"];
  const { data } = useQuery({ queryKey: key, queryFn: () => api.get<{ settings: SharingSettings; links: ShareLinkView[] }>(`/share/${formId}/links`) });
  const [draft, setDraft] = useState<SharingSettings | null>(null);
  const [busy, setBusy] = useState(false);
  const [showOld, setShowOld] = useState(false);
  useEffect(() => {
    if (data) setDraft(data.settings);
  }, [data]);
  if (!data || !draft) return null;
  const changed = JSON.stringify(draft) !== JSON.stringify(data.settings);
  const links = data.links.filter((l) => showOld || l.live);

  async function save() {
    setBusy(true);
    try {
      await api.put(`/share/${formId}/settings`, draft);
      await qc.invalidateQueries({ queryKey: ["share"] });
      toast(draft!.enabled ? "Saved." : "Sharing is off: every link stops working.");
    } catch (e) {
      toast(errorMessage(e, "Couldn't save."), "error");
    } finally {
      setBusy(false);
    }
  }

  async function turnOff(l: ShareLinkView) {
    if (!window.confirm(`Turn off ${l.userName}'s link? Anyone who opens it is told it no longer works.`)) return;
    try {
      await api.delete(`/share/links/${l.id}`);
      await qc.invalidateQueries({ queryKey: ["share"] });
      toast(`${l.userName}'s link is off.`);
    } catch (e) {
      toast(errorMessage(e, "Couldn't turn it off."), "error");
    }
  }

  return (
    <div className="space-y-4">
      {!live && <p className="rounded-input bg-status-amberBg px-3 py-2 text-[12.5px] text-status-amberText">Publish the form to start sharing: links work once the live version is shared by link.</p>}
      <label className="flex items-start gap-2 text-[13px] text-ink">
        <Switch checked={draft.enabled} onCheckedChange={(v) => setDraft({ ...draft, enabled: v })} className="mt-0.5" aria-label="Employees can share it" />
        <span>
          Employees can share it
          <span className="block text-[12px] text-muted">Everyone who can open the form gets their own link and QR code (on the form: “Share it”). Off: no new links, and every link stops working.</span>
        </span>
      </label>
      <div className="grid gap-4 sm:grid-cols-2">
        <Field label="A new link lasts (days)" hint="They can pick shorter or longer, up to the longest.">
          <Input type="number" min={1} max={3650} value={draft.defaultDays} onChange={(e) => setDraft({ ...draft, defaultDays: Math.max(1, Number(e.target.value) || 1) })} aria-label="A new link lasts (days)" className="w-[120px]" />
        </Field>
        <Field label="The longest (days)" hint="Empty: no limit, so a link can have no end date.">
          <Input type="number" min={1} max={3650} value={draft.maxDays ?? ""} onChange={(e) => setDraft({ ...draft, maxDays: e.target.value ? Math.max(1, Number(e.target.value)) : null })} placeholder="No limit" aria-label="The longest a link lasts (days)" className="w-[120px]" />
        </Field>
      </div>
      <div className="flex justify-end">
        <Button size="sm" onClick={() => void save()} disabled={busy || !changed}>Save sharing</Button>
      </div>

      <div>
        <div className="mb-2 flex items-center gap-2">
          <p className="min-w-0 flex-1 text-[13px] font-semibold text-ink">Everyone's links</p>
          <label className="flex items-center gap-2 text-[12.5px] text-muted">
            <Switch checked={showOld} onCheckedChange={setShowOld} aria-label="Show old links" /> Old ones too
          </label>
        </div>
        {links.length ? (
          <ul className="divide-y divide-hairline rounded-input border border-hairline">
            {links.map((l) => (
              <li key={l.id} className="flex flex-wrap items-center gap-x-3 gap-y-1 px-3 py-2 text-[12.5px]">
                <span className="min-w-0 flex-1">
                  <span className="block truncate font-semibold text-ink">{l.userName}</span>
                  <span className="block text-muted">
                    Made {relativeTime(l.createdAt)} · {l.revokedAt ? `turned off ${relativeTime(l.revokedAt)}${l.revokedByName ? ` by ${l.revokedByName}` : ""}` : l.expiresAt ? (l.live ? `until ${formatDateTime(l.expiresAt)}` : `ended ${relativeTime(l.expiresAt)}`) : "no end date"}
                    {" · "}{l.entries} entr{l.entries === 1 ? "y" : "ies"}{l.lastUsedAt ? `, last ${relativeTime(l.lastUsedAt)}` : ""}
                  </span>
                </span>
                {l.live ? <Tag tone="accent">Working</Tag> : <Tag tone="neutral">Off</Tag>}
                {l.live && <Button size="sm" variant="ghost" onClick={() => void turnOff(l)}>Turn off</Button>}
              </li>
            ))}
          </ul>
        ) : (
          <p className="rounded-input bg-subtle px-3 py-2 text-[12.5px] text-muted">{showOld ? "Nobody has made a link yet." : "No working links right now."}</p>
        )}
      </div>
    </div>
  );
}
