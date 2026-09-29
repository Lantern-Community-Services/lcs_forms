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
import { DateRangeBar as AppDateRangeBar, PRESETS, presetRange, type Preset } from "@/components/hotfoods/DateRange";
import { useApp } from "./sdk";
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

export {
  Button, Card, Input, SearchInput, Textarea, Field, Label, Select, Checkbox, Switch, Chip, Badge, ToneBadge, Avatar, EmptyState, LoadingState,
  Spinner, SignaturePad, presetRange, cn, initials, tintFor, distanceMeters, formatDistance,
};
