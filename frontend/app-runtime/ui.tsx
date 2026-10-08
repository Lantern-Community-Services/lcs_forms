/**
 * @lcs/ui — the app's own components, so a code form looks exactly like the
 * rest of the site. Mostly the very same modules the app uses (src/components/ui),
 * plus a few simpler wrappers (Modal, Sheet, DropdownMenu, Page) that take props
 * instead of the Radix compound parts.
 */
import { cn, initials, tintFor } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Input, SearchInput, Textarea } from "@/components/ui/input";
import { Field, Label } from "@/components/ui/label";
import { Select } from "@/components/ui/select";
import { Checkbox } from "@/components/ui/checkbox";
import { Switch } from "@/components/ui/switch";
import { Chip } from "@/components/ui/chip";
import { Badge, ToneBadge } from "@/components/ui/badge";
import { Avatar } from "@/components/ui/avatar";
import { EmptyState, LoadingState, Spinner } from "@/components/ui/misc";
import { Dialog, DialogBody, DialogContent, DialogFooter, DialogHeader } from "@/components/ui/dialog";
import { Sheet as SheetRoot, SheetBody, SheetContent, SheetFooter, SheetHeader } from "@/components/ui/sheet";
import {
  DropdownMenu as MenuRoot, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { SignaturePad } from "@/components/attendance/SignaturePad";
import { DateRangeBar as AppDateRangeBar, PRESETS, presetRange, type Preset } from "@/components/charts/DateRange";
import { useState } from "react";
import { Camera, FileText, Paperclip, X } from "lucide-react";
import { dates, device, entries, files, useApp, useData, useFileUrl, type FileRef } from "./sdk";
import { distanceMeters, formatDistance } from "@/lib/location";

export function Page({ className, children }: { className?: string; children: React.ReactNode }) {
  return <div className={cn("mx-auto max-w-[1240px] px-4 py-4 md:px-7 md:py-7", className)}>{children}</div>;
}

export function PageHeader({ title, subtitle, actions }: { title: string; subtitle?: string; actions?: React.ReactNode }) {
  return (
    <div className="mb-4 flex flex-wrap items-start justify-between gap-3 md:mb-6">
      <div className="min-w-0">
        <h1 className="font-heading text-[23px] font-extrabold text-ink md:text-[24px]">{title}</h1>
        {subtitle && <p className="mt-1 text-[13px] text-muted md:text-[13.5px]">{subtitle}</p>}
      </div>
      {actions && <div className="flex flex-wrap items-center gap-2">{actions}</div>}
    </div>
  );
}

export function Modal({ open, onOpenChange, title, subtitle, footer, children, wide }: {
  open: boolean; onOpenChange: (o: boolean) => void; title: string; subtitle?: string; footer?: React.ReactNode; children?: React.ReactNode; wide?: boolean;
}) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent aria-describedby={undefined} className={wide ? "w-[min(820px,calc(100vw-2rem))]" : undefined}>
        <DialogHeader title={title} subtitle={subtitle} />
        {children && <DialogBody className="max-h-[70vh] overflow-y-auto">{children}</DialogBody>}
        {footer && <DialogFooter>{footer}</DialogFooter>}
      </DialogContent>
    </Dialog>
  );
}

export function Sheet({ open, onOpenChange, title, footer, children }: {
  open: boolean; onOpenChange: (o: boolean) => void; title: string; footer?: React.ReactNode; children?: React.ReactNode;
}) {
  return (
    <SheetRoot open={open} onOpenChange={onOpenChange}>
      <SheetContent aria-describedby={undefined}>
        <SheetHeader title={title} />
        <SheetBody>{children}</SheetBody>
        {footer && <SheetFooter>{footer}</SheetFooter>}
      </SheetContent>
    </SheetRoot>
  );
}

export function DropdownMenu({ trigger, items, align = "end" }: {
  trigger: React.ReactNode; items: ({ label: string; onSelect: () => void; danger?: boolean } | "separator")[]; align?: "start" | "end";
}) {
  return (
    <MenuRoot>
      <DropdownMenuTrigger asChild>{trigger}</DropdownMenuTrigger>
      <DropdownMenuContent align={align}>
        {items.map((it, i) =>
          it === "separator" ? (
            <DropdownMenuSeparator key={i} />
          ) : (
            <DropdownMenuItem key={i} onSelect={it.onSelect}>
              <span className={it.danger ? "text-status-redText" : undefined}>{it.label}</span>
            </DropdownMenuItem>
          )
        )}
      </DropdownMenuContent>
    </MenuRoot>
  );
}

/** The app's range picker; the highlighted preset is worked out from from/to when not given. */
export function DateRangeBar({ from, to, preset, onChange, className }: { from: string; to: string; preset?: string | null; onChange: (r: { from: string; to: string }) => void; className?: string }) {
  const match = preset ?? PRESETS.find((p) => { const r = presetRange(p.key); return r.from === from && r.to === to; })?.key;
  return <AppDateRangeBar from={from} to={to} preset={(match ?? undefined) as Preset | undefined} onChange={onChange} className={className} />;
}

export const DATE_PRESETS = PRESETS;

/**
 * Like the app's useMediaQuery, but answered for the device's window rather
 * than the frame: (min-width: N px), (max-width: N px) and (orientation: X),
 * joined with "and". Anything else falls back to the frame's own matchMedia.
 */
export function useMediaQuery(query: string): boolean {
  const { device } = useApp();
  const parts = query.split(/\s+and\s+/i).map((p) => p.trim().replace(/^\(|\)$/g, ""));
  return parts.every((p) => {
    const m = /^(min|max)-width:\s*(\d+)px$/.exec(p);
    if (m) return m[1] === "min" ? device.width >= Number(m[2]) : device.width <= Number(m[2]);
    const o = /^orientation:\s*(portrait|landscape)$/.exec(p);
    if (o) return device.orientation === o[1];
    return window.matchMedia(`(${p})`).matches;
  });
}

// ── Entry history ────────────────────────────────────────────────────────

type HistoryItem = { at: string; byName: string; kind: "edit" | "void" | "restore"; reason?: string | null; changes?: { field: string; from: unknown; to: unknown }[] };

const shown = (v: unknown) => {
  if (v === null || v === undefined || v === "") return "—";
  if (typeof v === "object") {
    if (Array.isArray(v) && v.every((x) => x && typeof x === "object" && "fileId" in x)) return `${v.length} file${v.length === 1 ? "" : "s"}`;
    return JSON.stringify(v);
  }
  return String(v);
};

/**
 * What happened to an entry after it was made: each edit with what changed,
 * voids and restores. `labels` turns data keys into the names people know.
 */
export function EntryHistory({ entryId, labels, className }: { entryId: string; labels?: Record<string, string>; className?: string }) {
  const { data, loading, error } = useData(() => entries.history(entryId) as Promise<HistoryItem[]>, [entryId]);
  if (loading && !data) return <Spinner />;
  if (error) return <p className="text-[12.5px] text-status-redText">{error.message}</p>;
  if (!data?.length) return <p className={cn("text-[12.5px] text-muted", className)}>No changes since it was made.</p>;
  return (
    <ol className={cn("space-y-3", className)}>
      {data.map((h, i) => (
        <li key={i} className="border-l-2 border-hairline pl-3">
          <p className="text-[12.5px] text-muted">
            <span className="font-semibold text-ink">{h.byName}</span> {h.kind === "edit" ? "edited" : h.kind === "void" ? "voided" : "restored"} · {dates.format(h.at, "datetime")}
          </p>
          {h.reason && <p className="text-[12.5px] text-muted">Reason: {h.reason}</p>}
          {h.changes?.map((c) => (
            <p key={c.field} className="text-[13px] text-ink">
              <span className="font-semibold">{labels?.[c.field] ?? c.field}:</span> <span className="text-muted line-through">{shown(c.from)}</span> → {shown(c.to)}
            </p>
          ))}
        </li>
      ))}
    </ol>
  );
}

// ── Photos and files ─────────────────────────────────────────────────────

/** A photo from a FileRef (or its fileId), fetched through the SDK. */
export function Photo({ file, alt, className, onClick }: { file: FileRef | string | null | undefined; alt?: string; className?: string; onClick?: () => void }) {
  const url = useFileUrl(file);
  if (!url) return <div className={cn("animate-pulse rounded-input bg-rowhover", className)} aria-label="Loading photo" />;
  return <img src={url} alt={alt ?? (typeof file === "object" && file ? file.name : "Photo")} className={cn("rounded-input object-cover", className)} onClick={onClick} />;
}

/**
 * Photos for an entry: thumbnails with remove, and an "Add photo" button that
 * opens the camera (with a "Choose a photo" option). value/onChange hold FileRefs —
 * put them straight into the entry's data.
 */
export function PhotoInput({ value, onChange, max = 5, label = "Add photo", fileLabel = "photo", disabled, className }: {
  value: FileRef[]; onChange: (v: FileRef[]) => void; max?: number; label?: string; fileLabel?: string; disabled?: boolean; className?: string;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [big, setBig] = useState<FileRef | null>(null);
  async function add() {
    setError(null);
    setBusy(true);
    try {
      const ref = await device.takePhoto({ label: fileLabel });
      if (ref) onChange([...value, ref]);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }
  return (
    <div className={cn("space-y-2", className)}>
      <div className="flex flex-wrap gap-2">
        {value.map((f) => (
          <div key={f.fileId} className="relative">
            <Photo file={f} className="h-20 w-20 cursor-zoom-in border border-hairline" onClick={() => setBig(f)} />
            {!disabled && (
              <button type="button" aria-label="Remove photo" onClick={() => onChange(value.filter((x) => x.fileId !== f.fileId))}
                className="absolute -right-1.5 -top-1.5 rounded-full bg-ink p-0.5 text-surface shadow">
                <X className="h-3.5 w-3.5" />
              </button>
            )}
          </div>
        ))}
        {value.length < max && !disabled && (
          <button type="button" onClick={add} disabled={busy}
            className="flex h-20 w-20 flex-col items-center justify-center gap-1 rounded-input border border-dashed border-hairline text-[12px] font-semibold text-muted hover:bg-rowhover disabled:opacity-60">
            {busy ? <Spinner /> : <Camera className="h-5 w-5" />}
            {label}
          </button>
        )}
      </div>
      {error && <p className="text-[12.5px] text-status-redText">{error}</p>}
      <Modal open={big !== null} onOpenChange={(o) => !o && setBig(null)} title={big?.name ?? "Photo"} wide>
        {big && <Photo file={big} className="max-h-[65vh] w-full object-contain" />}
      </Modal>
    </div>
  );
}

/** Files for an entry (documents, PDFs, photos from the library), as FileRefs. */
export function FileInput({ value, onChange, accept, max = 5, label = "Attach a file", fileLabel = "file", disabled, className }: {
  value: FileRef[]; onChange: (v: FileRef[]) => void; accept?: string; max?: number; label?: string; fileLabel?: string; disabled?: boolean; className?: string;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  async function add() {
    setError(null);
    setBusy(true);
    try {
      const refs = await files.choose({ accept, multiple: max - value.length > 1, label: fileLabel });
      if (refs.length) onChange([...value, ...refs].slice(0, max));
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }
  return (
    <div className={cn("space-y-2", className)}>
      {value.map((f) => <FileChip key={f.fileId} file={f} onRemove={disabled ? undefined : () => onChange(value.filter((x) => x.fileId !== f.fileId))} />)}
      {value.length < max && !disabled && (
        <Button type="button" variant="secondary" onClick={add} disabled={busy}>
          {busy ? <Spinner /> : <Paperclip className="h-4 w-4" />} {label}
        </Button>
      )}
      {error && <p className="text-[12.5px] text-status-redText">{error}</p>}
    </div>
  );
}

/** One file as a row: name and size; tap to download. */
export function FileChip({ file, onRemove }: { file: FileRef; onRemove?: () => void }) {
  const kb = file.size < 1024 * 1024 ? `${Math.max(1, Math.round(file.size / 1024))} KB` : `${(file.size / 1024 / 1024).toFixed(1)} MB`;
  return (
    <div className="flex items-center gap-2 rounded-input border border-hairline px-3 py-2 text-[13px]">
      <FileText className="h-4 w-4 shrink-0 text-muted" />
      <button type="button" className="min-w-0 flex-1 truncate text-left font-semibold text-ink hover:underline" onClick={() => void files.download(file)}>{file.name}</button>
      <span className="shrink-0 text-micro text-muted">{kb}</span>
      {onRemove && <button type="button" aria-label={`Remove ${file.name}`} onClick={onRemove} className="text-muted hover:text-ink"><X className="h-4 w-4" /></button>}
    </div>
  );
}

export {
  Button, Card, Input, SearchInput, Textarea, Field, Label, Select, Checkbox, Switch, Chip, Badge, ToneBadge, Avatar, EmptyState, LoadingState,
  Spinner, SignaturePad, presetRange, cn, initials, tintFor, distanceMeters, formatDistance,
};
