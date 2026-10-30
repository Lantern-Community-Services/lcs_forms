import { useEffect, useState } from "react";
import { useNavigate, useParams } from "react-router-dom";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import QRCode from "qrcode";
import { Copy, Download, RefreshCw, Share2, XCircle } from "lucide-react";
import { DesktopBackLink, Page, PageHeader } from "@/components/shell/AppShell";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Field } from "@/components/ui/label";
import { Select } from "@/components/ui/select";
import { EmptyState, LoadingState } from "@/components/ui/misc";
import { useToast } from "@/components/ui/toast";
import { api } from "@/lib/api";
import { errorMessage, formatDateTime, relativeTime } from "@/lib/utils";

/**
 * /f/<slug>/share: my own link and QR code for a form anyone can fill in
 * through a link (backend services/shareLinks.ts). Entries through it are
 * mine to see. Refresh turns the old link off and makes a new one; links
 * expire (the form says the longest).
 */

export interface ShareLinkView {
  id: string;
  url: string;
  token: string;
  userId: string;
  userName: string;
  createdAt: string;
  expiresAt: string | null;
  revokedAt: string | null;
  revokedByName: string | null;
  entries: number;
  lastUsedAt: string | null;
  live: boolean;
}
export interface SharingSettings { enabled: boolean; defaultDays: number; maxDays: number | null }
interface MyShare {
  form: { id: string; slug: string; title: string };
  canShare: boolean;
  why: string | null;
  settings: SharingSettings;
  link: ShareLinkView | null;
  entriesFromMyLinks: number;
  isAdmin: boolean;
}

const LENGTHS = [7, 30, 90, 180, 365];

/**
 * The link's QR code with the Lantern mark in the middle, as a PNG. The
 * highest error correction (H, 30%) lets a scanner read past the mark, which
 * covers about 5% of the code, on a white square so it stays clear of the
 * dots. Navy on white, with a quiet zone: it scans from a screen or paper.
 */
async function qrWithLogo(url: string): Promise<string> {
  const size = 640;
  const canvas = document.createElement("canvas");
  await QRCode.toCanvas(canvas, url, { width: size, margin: 2, errorCorrectionLevel: "H", color: { dark: "#2c3453", light: "#ffffff" } });
  const ctx = canvas.getContext("2d");
  if (!ctx) return canvas.toDataURL("image/png");
  try {
    const logo = await new Promise<HTMLImageElement>((resolve, reject) => {
      const img = new Image();
      img.onload = () => resolve(img);
      img.onerror = reject;
      img.src = "/lcs_logo_color.svg";
    });
    const box = Math.round(size * 0.22);
    const x = (size - box) / 2;
    ctx.fillStyle = "#ffffff";
    ctx.beginPath();
    ctx.roundRect(x, x, box, box, box * 0.18);
    ctx.fill();
    const pad = box * 0.12;
    const w = box - pad * 2;
    const h = (w * logo.naturalHeight) / (logo.naturalWidth || 1);
    ctx.drawImage(logo, x + pad, x + pad + (w - h) / 2, w, h);
  } catch {
    // No logo (it didn't load): the plain code still works.
  }
  return canvas.toDataURL("image/png");
}

/** "in 90 days", "in 3 hours": how long a link has left. */
function timeLeft(iso: string) {
  const ms = Date.parse(iso) - Date.now();
  if (ms <= 0) return "ended";
  const days = Math.round(ms / 86_400_000);
  if (days >= 1) return `in ${days} day${days === 1 ? "" : "s"}`;
  const hours = Math.max(1, Math.floor(ms / 3_600_000));
  return `in ${hours} hour${hours === 1 ? "" : "s"}`;
}

export function SharePage() {
  const { slug = "" } = useParams();
  const navigate = useNavigate();
  const qc = useQueryClient();
  const toast = useToast();
  const key = ["share", slug];
  const { data, isLoading, error } = useQuery({ queryKey: key, queryFn: () => api.get<MyShare>(`/share/${encodeURIComponent(slug)}`) });
  const [length, setLength] = useState<string>("");
  const [until, setUntil] = useState("");
  const [busy, setBusy] = useState(false);
  const [qr, setQr] = useState<string | null>(null);

  useEffect(() => {
    if (data && !length) setLength(String(data.settings.defaultDays));
  }, [data]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    if (!data?.link) return setQr(null);
    let alive = true;
    void qrWithLogo(data.link.url).then((png) => alive && setQr(png));
    return () => {
      alive = false;
    };
  }, [data?.link?.url]); // eslint-disable-line react-hooks/exhaustive-deps

  if (isLoading) return <LoadingState />;
  if (error || !data) return <Page><Card><EmptyState title={errorMessage(error, "Couldn't open this.")} /></Card></Page>;
  const { settings, link } = data;
  const options = [...new Set([...LENGTHS, settings.defaultDays])].filter((d) => settings.maxDays === null || d <= settings.maxDays).sort((a, b) => a - b);

  function lengthBody() {
    if (length === "never") return { never: true };
    if (length === "date") return until ? { until: new Date(`${until}T23:59:00`).toISOString() } : undefined;
    return { days: Number(length) };
  }

  async function make(refresh: boolean) {
    if (refresh && !window.confirm("Make a new link? Your old link and QR code stop working straight away, wherever you've shared them.")) return;
    if (length === "date" && !until) return toast("Pick the date it ends.", "error");
    setBusy(true);
    try {
      await api.post(`/share/${encodeURIComponent(slug)}`, { length: lengthBody() });
      await qc.invalidateQueries({ queryKey: key });
      toast(refresh ? "New link made. The old one no longer works." : "Your link is ready to share.");
    } catch (e) {
      toast(errorMessage(e, "Couldn't make the link."), "error");
    } finally {
      setBusy(false);
    }
  }

  async function turnOff() {
    if (!window.confirm("Turn your link off? Anyone who opens it is told it no longer works.")) return;
    setBusy(true);
    try {
      await api.delete(`/share/${encodeURIComponent(slug)}/mine`);
      await qc.invalidateQueries({ queryKey: key });
      toast("Your link is off.");
    } catch (e) {
      toast(errorMessage(e, "Couldn't turn it off."), "error");
    } finally {
      setBusy(false);
    }
  }

  async function copy() {
    try {
      await navigator.clipboard.writeText(link!.url);
      toast("Link copied.");
    } catch {
      toast("Couldn't copy: select the link and copy it.", "error");
    }
  }

  async function share() {
    try {
      await navigator.share({ title: data!.form.title, text: `${data!.form.title}, from Lantern Community Services`, url: link!.url });
    } catch {
      /* closed */
    }
  }

  const lengthPicker = (
    <Field label="How long it works" hint={settings.maxDays === null ? "You can turn it off or refresh it any time." : `At most ${settings.maxDays} days for this form. You can turn it off or refresh it any time.`}>
      <div className="flex flex-wrap items-center gap-2">
        <div className="w-[200px]">
          <Select
            value={length}
            onChange={(e) => setLength(e.target.value)}
            aria-label="How long it works"
            options={[...options.map((d) => ({ value: String(d), label: d % 30 === 0 && d < 365 ? `${d / 30} month${d === 30 ? "" : "s"}` : d === 365 ? "1 year" : `${d} days` })), { value: "date", label: "Until a date" }, ...(settings.maxDays === null ? [{ value: "never", label: "No end date" }] : [])]}
          />
        </div>
        {length === "date" && <Input type="date" value={until} onChange={(e) => setUntil(e.target.value)} aria-label="Ends on" className="w-[170px]" />}
      </div>
    </Field>
  );

  return (
    <Page className="max-w-[820px]">
      <DesktopBackLink to={`/f/${slug}`}>{data.form.title}</DesktopBackLink>
      <PageHeader title="Share this form" help={{ article: "share-links", text: "Your own link and QR code. Anyone you give it to can fill the form in; refresh it any time and the old one stops working." }} subtitle={`Your own link and QR code for “${data.form.title}”. Anyone you give it to can fill it in, without an account. What they send comes to Lantern, and you can see it.`} />

      {!data.canShare ? (
        <Card><EmptyState title="You can't share this form by link" hint={data.why ?? undefined} /></Card>
      ) : link ? (
        <div className="grid gap-4 md:grid-cols-[minmax(0,1fr)_280px]">
          <Card className="space-y-4 p-5">
            <Field label="Your link">
              <div className="flex gap-2">
                <Input value={link.url} readOnly onFocus={(e) => e.currentTarget.select()} aria-label="Your link" className="font-mono text-[12.5px]" />
                <Button variant="secondary" onClick={() => void copy()}><Copy className="h-4 w-4" /> Copy</Button>
              </div>
            </Field>
            <p className="text-[13px] text-ink">
              {link.expiresAt ? <>Works until <span className="font-semibold">{formatDateTime(link.expiresAt)}</span> ({timeLeft(link.expiresAt)}).</> : "Works until you refresh it or turn it off."}{" "}
              {link.entries ? `${link.entries} entr${link.entries === 1 ? "y has" : "ies have"} come through it` : "Nothing has come through it yet"}
              {link.lastUsedAt ? `, the last ${relativeTime(link.lastUsedAt)}` : ""}.
            </p>
            <div className="flex flex-wrap gap-2">
              {typeof navigator !== "undefined" && "share" in navigator && <Button variant="secondary" onClick={() => void share()}><Share2 className="h-4 w-4" /> Send it</Button>}
              {data.entriesFromMyLinks > 0 && <Button variant="secondary" onClick={() => navigate(`/f/${slug}/entries`)}>See what came in ({data.entriesFromMyLinks})</Button>}
            </div>
            <div className="space-y-3 border-t border-hairline pt-4">
              <p className="text-[13px] text-muted">Shared it somewhere you shouldn't have, or want a fresh one? Refresh makes a new link and QR code; the old ones stop working.</p>
              {lengthPicker}
              <div className="flex flex-wrap gap-2">
                <Button variant="secondary" onClick={() => void make(true)} disabled={busy}><RefreshCw className="h-4 w-4" /> Refresh my link</Button>
                <Button variant="ghost" onClick={() => void turnOff()} disabled={busy}><XCircle className="h-4 w-4" /> Turn it off</Button>
              </div>
            </div>
          </Card>
          <Card className="space-y-3 p-5 text-center">
            <p className="kicker">Your QR code</p>
            {qr ? <img src={qr} alt={`QR code for your link to ${data.form.title}`} className="mx-auto w-full max-w-[240px] rounded-input border border-hairline bg-white p-1" /> : <LoadingState />}
            <p className="text-[12px] text-muted">Show it on your phone, or print it. It opens your link.</p>
            {qr && (
              <Button
                variant="secondary"
                size="sm"
                onClick={() => {
                  const a = document.createElement("a");
                  a.href = qr;
                  a.download = `${data.form.slug}-qr.png`;
                  a.click();
                }}
              >
                <Download className="h-4 w-4" /> Download the QR code
              </Button>
            )}
          </Card>
        </div>
      ) : (
        <Card className="space-y-4 p-5">
          <p className="text-[13.5px] text-ink">You don't have a link for this form yet. Make one to share it by link, text, email or QR code.</p>
          {lengthPicker}
          <Button onClick={() => void make(false)} disabled={busy}><Share2 className="h-4 w-4" /> Make my link</Button>
        </Card>
      )}
    </Page>
  );
}
