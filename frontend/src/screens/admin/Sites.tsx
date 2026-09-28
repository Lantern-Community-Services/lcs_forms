import { useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { ExternalLink, Loader2, LocateFixed, MapPin, Plus, Search } from "lucide-react";
import { Page, PageHeader } from "@/components/shell/AppShell";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Field } from "@/components/ui/label";
import { Select } from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { ToneBadge } from "@/components/ui/badge";
import { Dialog, DialogBody, DialogContent, DialogFooter, DialogHeader } from "@/components/ui/dialog";
import { LoadingState } from "@/components/ui/misc";
import { useToast } from "@/components/ui/toast";
import { api } from "@/lib/api";
import { useSites } from "@/lib/queries";
import { DEFAULT_GEOFENCE_METERS } from "@/lib/location";
import type { Site } from "@/lib/types";
import { errorMessage } from "@/lib/utils";

type Draft = {
  id?: string; name: string; code: string; entityName: string; siteType: string; address: string; attentionHours: string; active: boolean;
  latitude: string; longitude: string; geofenceMeters: string;
};
const empty: Draft = { name: "", code: "", entityName: "", siteType: "supportive", address: "", attentionHours: "", active: true, latitude: "", longitude: "", geofenceMeters: "" };
/** Six decimals is ~10 cm, plenty for a building. */
const coord = (n: number) => String(Math.round(n * 1e6) / 1e6);
const slug = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");

export function AdminSites() {
  const { data: sites, isLoading } = useSites(true);
  const [draft, setDraft] = useState<Draft | null>(null);
  const qc = useQueryClient();
  const toast = useToast();

  async function save() {
    if (!draft) return;
    const lat = draft.latitude.trim() ? Number(draft.latitude) : null;
    const lng = draft.longitude.trim() ? Number(draft.longitude) : null;
    if ((lat === null) !== (lng === null)) return toast("Enter both latitude and longitude, or clear both.", "error");
    if ((lat !== null && (!Number.isFinite(lat) || Math.abs(lat) > 90)) || (lng !== null && (!Number.isFinite(lng) || Math.abs(lng) > 180))) {
      return toast("Those coordinates don't look right.", "error");
    }
    const body = {
      name: draft.name,
      code: draft.code,
      entityName: draft.entityName || null,
      siteType: draft.siteType,
      address: draft.address || null,
      latitude: lat,
      longitude: lng,
      geofenceMeters: draft.geofenceMeters ? Number(draft.geofenceMeters) : null,
      attentionHours: draft.attentionHours ? Number(draft.attentionHours) : null,
      active: draft.active,
    };
    try {
      if (draft.id) await api.patch(`/sites/${draft.id}`, body);
      else await api.post("/sites", body);
      toast(draft.id ? "Site updated." : "Site created.");
      setDraft(null);
      await qc.invalidateQueries({ queryKey: ["roster"] });
    } catch (e) {
      toast(errorMessage(e, "Could not save."), "error");
    }
  }

  const edit = (s: Site) =>
    setDraft({
      id: s.id, name: s.name, code: s.code, entityName: s.entityName ?? "", siteType: s.siteType,
      address: s.address ?? "", attentionHours: s.attentionHours ? String(s.attentionHours) : "", active: s.active,
      latitude: s.latitude != null ? coord(s.latitude) : "", longitude: s.longitude != null ? coord(s.longitude) : "",
      geofenceMeters: s.geofenceMeters ? String(s.geofenceMeters) : "",
    });

  return (
    <Page>
      <PageHeader
        title="Sites"
        subtitle="Every Lantern property or shelter with a roster. The code is what WordPress and the API use — keep it stable."
        actions={<Button onClick={() => setDraft({ ...empty })}><Plus className="h-4 w-4" /> New site</Button>}
      />
      {isLoading ? <LoadingState /> : (
        <Card className="overflow-x-auto">
          <table className="w-full min-w-[640px] text-[13.5px]">
            <thead>
              <tr className="border-b border-hairline text-left text-micro font-bold uppercase tracking-[0.04em] text-muted">
                <th className="px-4 py-2.5">Site</th><th className="px-4 py-2.5">Code</th><th className="px-4 py-2.5">Type</th><th className="px-4 py-2.5">Location</th>
                <th className="px-4 py-2.5 text-right">Roster</th><th className="px-4 py-2.5 text-right">Review</th><th className="px-4 py-2.5">Threshold</th><th className="px-4 py-2.5" />
              </tr>
            </thead>
            <tbody>
              {sites?.map((s) => (
                <tr key={s.id} onClick={() => edit(s)} className="cursor-pointer border-b border-hairline last:border-0 hover:bg-rowhover">
                  <td className="px-4 py-2.5"><p className="font-semibold text-ink">{s.name}</p>{s.entityName && <p className="text-micro text-muted">{s.entityName}</p>}</td>
                  <td className="px-4 py-2.5 font-mono text-[12px] text-muted">{s.code}</td>
                  <td className="px-4 py-2.5 capitalize text-muted">{s.siteType}</td>
                  <td className="px-4 py-2.5">
                    {s.latitude != null ? (
                      <span className="inline-flex items-center gap-1 text-[12.5px] text-status-greenText" title={s.address ?? undefined}><MapPin className="h-3.5 w-3.5" /> Set</span>
                    ) : (
                      <ToneBadge tone="amber" className="whitespace-nowrap">Not set</ToneBadge>
                    )}
                  </td>
                  <td className="px-4 py-2.5 text-right tabular">{s.activeCount}</td>
                  <td className="px-4 py-2.5 text-right tabular">{s.attentionCount || "—"}</td>
                  <td className="px-4 py-2.5 text-muted">{s.effectiveAttentionHours}h{s.attentionHours ? "" : " (default)"}</td>
                  <td className="px-4 py-2.5">{!s.active && <ToneBadge tone="neutral">Inactive</ToneBadge>}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </Card>
      )}

      <Dialog open={Boolean(draft)} onOpenChange={(o) => !o && setDraft(null)}>
        <DialogContent aria-describedby={undefined} className="max-h-[90vh] overflow-y-auto scroll-thin">
          <DialogHeader title={draft?.id ? `Edit ${draft.name}` : "New site"} />
          {draft && (
            <DialogBody className="grid grid-cols-2 gap-3">
              <Field label="Name" className="col-span-2">
                <Input value={draft.name} onChange={(e) => setDraft({ ...draft, name: e.target.value, code: draft.id ? draft.code : slug(e.target.value) })} />
              </Field>
              <Field label="Code" hint={draft.id ? "Changing this breaks integrations that use the old code." : "Used in URLs and the API."}>
                <Input value={draft.code} onChange={(e) => setDraft({ ...draft, code: slug(e.target.value) })} className="font-mono" />
              </Field>
              <Field label="Type" hint="Sets the Hot Foods limits: shelters get more meals a day, with a cooldown (Admin → Hot Foods).">
                <Select value={draft.siteType} onChange={(e) => setDraft({ ...draft, siteType: e.target.value })}
                  options={[{ value: "supportive", label: "Supportive housing" }, { value: "shelter", label: "Shelter (high turnover)" }, { value: "other", label: "Other" }]} />
              </Field>
              <Field label="Entity name" hint="As it appears in the property-management export, e.g. “Amber Hall LP”.">
                <Input value={draft.entityName} onChange={(e) => setDraft({ ...draft, entityName: e.target.value })} />
              </Field>
              <Field label="Review threshold (hours)" hint="Blank = org default.">
                <Input type="number" min={1} value={draft.attentionHours} onChange={(e) => setDraft({ ...draft, attentionHours: e.target.value })} placeholder="48" />
              </Field>
              <LocationFields draft={draft} setDraft={setDraft} />
              <label className="col-span-2 flex items-center justify-between rounded-input border border-hairline px-3 py-2">
                <span className="text-[13.5px] text-ink">Active — shown in rosters, forms and the API</span>
                <Switch checked={draft.active} onCheckedChange={(v) => setDraft({ ...draft, active: v })} />
              </label>
            </DialogBody>
          )}
          <DialogFooter>
            <Button variant="secondary" onClick={() => setDraft(null)}>Cancel</Button>
            <Button onClick={save} disabled={!draft?.name || !draft?.code}>Save</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </Page>
  );
}

/**
 * Where the site is, for forms that pick the site from the staff member's
 * location. Three ways in: look the address up, stand at the site and use this
 * device's position, or type the coordinates.
 */
function LocationFields({ draft, setDraft }: { draft: Draft; setDraft: (d: Draft) => void }) {
  const toast = useToast();
  const [busy, setBusy] = useState<"lookup" | "here" | null>(null);
  const set = (lat: number, lng: number) => setDraft({ ...draft, latitude: coord(lat), longitude: coord(lng) });
  const hasCoords = draft.latitude.trim() !== "" && draft.longitude.trim() !== "";

  async function lookup() {
    setBusy("lookup");
    try {
      const r = await api.get<{ latitude: number; longitude: number; label: string }>(`/sites/geocode?address=${encodeURIComponent(draft.address)}`);
      set(r.latitude, r.longitude);
      toast(`Found: ${r.label}`);
    } catch (e) {
      toast(errorMessage(e, "Couldn't look that address up."), "error");
    } finally {
      setBusy(null);
    }
  }

  function here() {
    if (!navigator.geolocation || !window.isSecureContext) return toast("This browser can't share its location.", "error");
    setBusy("here");
    navigator.geolocation.getCurrentPosition(
      (p) => {
        set(p.coords.latitude, p.coords.longitude);
        setBusy(null);
        toast(`Set from this device (accurate to about ${Math.round(p.coords.accuracy)} m).`);
      },
      () => {
        setBusy(null);
        toast("Couldn't get this device's location. Check that location is allowed for this site.", "error");
      },
      { enableHighAccuracy: true, timeout: 15_000, maximumAge: 0 }
    );
  }

  return (
    <div className="col-span-2 space-y-3 rounded-input border border-hairline p-3">
      <div>
        <p className="text-[13.5px] font-bold text-ink">Location</p>
        <p className="text-micro text-muted">Forms use this to pick the site automatically when staff are there. Their position stays on their device.</p>
      </div>
      <Field label="Address">
        <div className="flex gap-2">
          <Input value={draft.address} onChange={(e) => setDraft({ ...draft, address: e.target.value })} placeholder="1385 Fulton Avenue, Bronx, NY 10456" className="flex-1" />
          <Button variant="secondary" onClick={lookup} disabled={busy !== null || draft.address.trim().length < 5} title="Look up the coordinates for this address">
            {busy === "lookup" ? <Loader2 className="h-4 w-4 animate-spin" /> : <Search className="h-4 w-4" />} Look up
          </Button>
        </div>
      </Field>
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-3">
        <Field label="Latitude"><Input inputMode="decimal" value={draft.latitude} onChange={(e) => setDraft({ ...draft, latitude: e.target.value })} placeholder="40.834354" className="font-mono text-[13px]" /></Field>
        <Field label="Longitude"><Input inputMode="decimal" value={draft.longitude} onChange={(e) => setDraft({ ...draft, longitude: e.target.value })} placeholder="-73.90226" className="font-mono text-[13px]" /></Field>
        <Field label="Radius (metres)" hint={`Blank = ${DEFAULT_GEOFENCE_METERS}.`} className="col-span-2 sm:col-span-1">
          <Input type="number" min={25} max={2000} value={draft.geofenceMeters} onChange={(e) => setDraft({ ...draft, geofenceMeters: e.target.value })} placeholder={String(DEFAULT_GEOFENCE_METERS)} />
        </Field>
      </div>
      <div className="flex flex-wrap items-center gap-2">
        <Button variant="secondary" size="sm" onClick={here} disabled={busy !== null}>
          {busy === "here" ? <Loader2 className="h-4 w-4 animate-spin" /> : <LocateFixed className="h-4 w-4" />} Use this device's location
        </Button>
        {hasCoords && (
          <>
            <a
              href={`https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(`${draft.latitude.trim()},${draft.longitude.trim()}`)}`}
              target="_blank"
              rel="noopener noreferrer"
              className="inline-flex h-8 items-center gap-1.5 rounded-input px-2 text-[13px] font-semibold text-accent hover:bg-subtle2 dark:text-white"
            >
              <ExternalLink className="h-4 w-4" /> Check on a map
            </a>
            <Button variant="ghost" size="sm" onClick={() => setDraft({ ...draft, latitude: "", longitude: "" })}>Clear</Button>
          </>
        )}
      </div>
    </div>
  );
}
