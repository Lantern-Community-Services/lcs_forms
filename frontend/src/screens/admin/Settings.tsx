import { useEffect, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { X } from "lucide-react";
import { Page, PageHeader } from "@/components/shell/AppShell";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Field } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { LoadingState } from "@/components/ui/misc";
import { useToast } from "@/components/ui/toast";
import { api } from "@/lib/api";
import { useAuth } from "@/lib/auth";
import { useSettings, useSites } from "@/lib/queries";
import type { Site } from "@/lib/types";
import { errorMessage } from "@/lib/utils";

/**
 * The review threshold and friends. The org-wide default is an Admin's
 * (settings.manage); each site's own override belongs to whoever holds
 * sites.manageRules for it — a Site Admin sees just their sites.
 */
export function AdminSettings() {
  const { can } = useAuth();
  const orgWide = can("settings.manage");
  const { data, isLoading } = useSettings();
  const [hours, setHours] = useState("48");
  const qc = useQueryClient();
  const toast = useToast();
  useEffect(() => { if (data) setHours(data.attentionHours); }, [data]);

  async function save() {
    try {
      await api.patch("/admin/settings", { attentionHours: Number(hours) });
      toast("Saved. The review queue now uses the new threshold.");
      await qc.invalidateQueries();
    } catch (e) {
      toast(errorMessage(e, "Could not save."), "error");
    }
  }

  if (isLoading) return <LoadingState />;
  return (
    <Page className="max-w-[720px]">
      <PageHeader title="Roster rules" />
      <Card className="p-5">
        <Field label="Review after (hours without activity)" hint="Someone lands in the review queue when no form has named them and nobody has confirmed them for this long. Sites can override it (Admin → Sites) — shelters may want 24.">
          <div className="flex gap-2">
            <Input type="number" min={1} max={1440} value={hours} disabled={!orgWide} onChange={(e) => setHours(e.target.value)} className="w-32" />
            {orgWide && <Button onClick={save} disabled={!hours || hours === data?.attentionHours}>Save</Button>}
          </div>
          {!orgWide && <p className="mt-1.5 text-micro text-muted">The org-wide default. Only an Admin can change it; set your own sites below.</p>}
        </Field>
        <div className="mt-5 border-t border-hairline pt-4 text-[13px] text-muted">
          <p className="font-semibold text-ink">What counts as activity</p>
          <ul className="mt-1 list-disc space-y-1 pl-5">
            <li>A Gravity Form (or any integration) posting the person to <code className="text-[12px]">POST /api/v1/activity</code>.</li>
            <li>Staff tapping <b>Keep</b> in the review queue or <b>Still here</b> on a profile.</li>
            <li>Being added to the roster, or restored to it.</li>
          </ul>
          <p className="mt-2">Editing someone's details does not count — correcting a spelling isn't evidence they're still in the building.</p>
        </div>
      </Card>
      {can("sites.manageRules") && <SiteRules orgHours={data?.attentionHours ?? "48"} />}
    </Page>
  );
}

/** Each of the caller's sites, with its own review threshold or the default. */
function SiteRules({ orgHours }: { orgHours: string }) {
  const { data: sites, isLoading } = useSites();
  if (isLoading) return <LoadingState />;
  return (
    <Card className="mt-4">
      <div className="border-b border-hairline px-5 py-3.5">
        <p className="font-heading text-[15px] font-extrabold text-ink">Your sites</p>
        <p className="mt-0.5 text-[13px] text-muted">Leave a site blank to use the default ({orgHours} hours). Shelters often use 24.</p>
      </div>
      <ul>
        {(sites ?? []).map((s) => <SiteRuleRow key={s.id} site={s} />)}
      </ul>
    </Card>
  );
}

function SiteRuleRow({ site }: { site: Site }) {
  const saved = site.attentionHours == null ? "" : String(site.attentionHours);
  const [hours, setHours] = useState(saved);
  const qc = useQueryClient();
  const toast = useToast();
  useEffect(() => setHours(saved), [saved]);

  async function save() {
    try {
      await api.patch(`/sites/${site.id}/rules`, { attentionHours: hours ? Number(hours) : null });
      toast(hours ? `${site.name} now reviews after ${hours} hours.` : `${site.name} uses the default again.`);
      await qc.invalidateQueries();
    } catch (e) {
      toast(errorMessage(e, "Could not save."), "error");
    }
  }

  return (
    <li className="flex items-center gap-3 border-b border-hairline px-5 py-2.5 last:border-0">
      <span className="min-w-0 flex-1 truncate text-[13.5px] font-semibold text-ink">{site.name}</span>
      <Input type="number" min={1} max={1440} placeholder="Default" value={hours} onChange={(e) => setHours(e.target.value)} className="w-28" aria-label={`${site.name} review threshold in hours`} />
      <Button variant="secondary" onClick={save} disabled={hours === saved}>Save</Button>
    </li>
  );
}

/** Which email domains beyond lanterncommunity.org may sign in. */
export function AdminSignInAccess() {
  const { data, isLoading } = useSettings();
  const [domains, setDomains] = useState<string[]>([]);
  const [next, setNext] = useState("");
  const toast = useToast();
  const qc = useQueryClient();
  useEffect(() => { if (data) setDomains(data.guestDomains.split(",").filter(Boolean)); }, [data]);

  async function persist(list: string[]) {
    try {
      await api.patch("/admin/settings", { guestDomains: list });
      setDomains(list);
      await qc.invalidateQueries({ queryKey: ["admin", "settings"] });
      toast("Sign-in access updated.");
    } catch (e) {
      toast(errorMessage(e, "Could not save."), "error");
    }
  }

  async function setAutoApprove(on: boolean) {
    try {
      await api.patch("/admin/settings", { autoApproveStaff: on });
      await qc.invalidateQueries({ queryKey: ["admin", "settings"] });
      toast(on ? "Lantern staff now get in on their first sign-in." : "New Lantern staff now need an admin's approval.");
    } catch (e) {
      toast(errorMessage(e, "Could not save."), "error");
    }
  }

  if (isLoading) return <LoadingState />;
  return (
    <Page className="max-w-[760px]">
      <PageHeader title="Sign-in access" subtitle="Everyone signs in through Lantern's Microsoft Entra ID. Partner organisations can use their own Google Workspace or Microsoft accounts." />
      <Card className="mb-4 p-5">
        <label className="flex items-start gap-3">
          <Switch className="mt-0.5" checked={data?.autoApproveStaff === "true"} onCheckedChange={(on) => void setAutoApprove(on)} />
          <span>
            <span className="block text-[14px] font-semibold text-ink">Let Lantern staff in on their first sign-in</span>
            <span className="mt-0.5 block text-[13px] text-muted">
              Anyone with a <b className="text-ink">lanterncommunity.org</b> account gets in as <b className="text-ink">Site Staff</b>:
              they can use the forms, but see no rosters until an Admin or Site Admin assigns them to a site in People &amp; roles.
              Turn this off to approve every new person by hand. Partner domains below always need approval.
            </span>
          </span>
        </label>
      </Card>
      <Card className="mb-4 p-5">
        <p className="kicker mb-2">Admitted domains</p>
        <p className="mb-3 text-[13px] text-muted">
          <b className="text-ink">lanterncommunity.org</b> is always admitted. Add a partner's domain to let their staff request access
          by signing in. To admit one person without their whole domain, add them by email in People &amp; roles instead.
        </p>
        <div className="mb-3 flex flex-wrap gap-2">
          {domains.length === 0 && <span className="text-[13px] text-muted">No partner domains yet.</span>}
          {domains.map((d) => (
            <span key={d} className="inline-flex items-center gap-1 rounded-pill border border-hairline bg-subtle px-3 py-1 text-[13px] text-ink">
              {d}
              <button onClick={() => persist(domains.filter((x) => x !== d))} aria-label={`Remove ${d}`} className="text-muted hover:text-ink"><X className="h-3.5 w-3.5" /></button>
            </span>
          ))}
        </div>
        <form className="flex gap-2" onSubmit={(e) => { e.preventDefault(); const d = next.trim().toLowerCase().replace(/^@/, ""); if (d) { void persist([...domains, d]); setNext(""); } }}>
          <Input value={next} onChange={(e) => setNext(e.target.value)} placeholder="partnerorg.org" className="max-w-xs" />
          <Button type="submit" disabled={!next.trim()}>Add domain</Button>
        </form>
      </Card>
      <Card className="p-5 text-[13px] text-muted">
        <p className="kicker mb-2">Partner sign-in (Google Workspace &amp; others) — one-time Entra setup</p>
        <ol className="list-decimal space-y-1.5 pl-5">
          <li>
            <b className="text-ink">Google Workspace partners</b> (their own domain): in the partner's Google Admin console add the
            <i> Microsoft Office 365 (SAML)</i> app and download its IdP metadata. Then in Entra admin center →
            <b> External Identities → All identity providers → SAML/WS-Fed</b>, add a federation for their domain with that metadata.
          </li>
          <li>
            <b className="text-ink">Individual Gmail users</b>: use the built-in <b>Google</b> identity provider instead (Google Cloud OAuth client,
            redirect <code>https://login.microsoftonline.com/te/&lt;tenant-id&gt;/oauth2/authresp</code>). Microsoft documents this as Gmail-only.
          </li>
          <li>Invite partner staff as B2B guests (or admit their domain above and add them in People &amp; roles). They click “Continue with Microsoft”, type their work email, and Entra sends them to Google.</li>
          <li>Anyone else outside Lantern can still get in with Entra's email one-time passcode — no app change either way.</li>
        </ol>
        <p className="mt-2">This app only ever talks to Lantern's Entra tenant; it records which provider signed each person in (the <code>idp</code> claim).</p>
      </Card>
    </Page>
  );
}
