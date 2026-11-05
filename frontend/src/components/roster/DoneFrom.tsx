import { MapPin } from "lucide-react";

/**
 * Where an audit event was done from: the place, the device and the IP. The
 * server only sends these to Admins (audit.view), so for everyone else this
 * renders nothing. Places come from DB-IP's free database, looked up on the
 * server; DbIpCredit is the credit its licence asks for.
 */
export function DoneFrom({ e }: { e: { ip?: string | null; location?: string | null; device?: string | null } }) {
  const parts = [e.location, e.device, e.ip].filter(Boolean);
  if (!parts.length) return null;
  return (
    <p className="flex items-center gap-1 text-micro text-muted">
      <MapPin className="h-3 w-3 shrink-0" aria-hidden />
      <span className="sr-only">From </span>
      {parts.join(" · ")}
    </p>
  );
}

export function DbIpCredit({ className }: { className?: string }) {
  return (
    <p className={className ?? "mt-3 px-1 text-micro text-muted"}>
      Places are approximate, from the IP address. <a href="https://db-ip.com" target="_blank" rel="noreferrer" className="underline">IP Geolocation by DB-IP</a>.
    </p>
  );
}
