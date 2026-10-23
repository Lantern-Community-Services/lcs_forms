import * as DialogPrimitive from "@radix-ui/react-dialog";
import { X } from "lucide-react";
import { forwardRef } from "react";
import { cn } from "@/lib/utils";

/**
 * A popup with a scrolling body and a footer that stays put: a list to pick
 * from (sites, categories), a search to choose someone, a short form.
 *
 * It used to be a bottom sheet rising from the screen's edge on every device,
 * which read badly on a desktop (a strip pinned to the bottom of the page, or
 * of a code form's frame). Now it's a centred popup everywhere, like
 * `<Dialog>`, but it caps its height and scrolls its body, so a long list
 * still fits on a phone. Same Radix dialog underneath, so focus trapping,
 * Escape and the scroll lock behave identically.
 */
export const Sheet = DialogPrimitive.Root;
export const SheetTrigger = DialogPrimitive.Trigger;
export const SheetClose = DialogPrimitive.Close;

export const SheetContent = forwardRef<
  React.ElementRef<typeof DialogPrimitive.Content>,
  React.ComponentPropsWithoutRef<typeof DialogPrimitive.Content>
>(({ className, children, ...props }, ref) => (
  <DialogPrimitive.Portal>
    <DialogPrimitive.Overlay className="sheet-overlay fixed inset-0 z-50 bg-[rgba(35,42,58,0.5)]" />
    <DialogPrimitive.Content
      ref={ref}
      className={cn(
        "sheet-panel fixed left-1/2 top-1/2 z-50 flex w-[min(560px,calc(100vw-2rem))] -translate-x-1/2 -translate-y-1/2 flex-col",
        "max-h-[min(88vh,calc(100dvh-2rem))] rounded-card bg-surface shadow-modal focus:outline-none",
        className
      )}
      {...props}
    >
      {children}
    </DialogPrimitive.Content>
  </DialogPrimitive.Portal>
));
SheetContent.displayName = "SheetContent";

/** The title, and a close button unless `action` brings its own controls. */
export function SheetHeader({ title, action }: { title: string; action?: React.ReactNode }) {
  return (
    <div className="flex flex-none items-center gap-2 border-b border-hairline py-3 pl-5 pr-3">
      <DialogPrimitive.Title className="min-w-0 flex-1 truncate text-[19px] font-heading font-extrabold text-ink">{title}</DialogPrimitive.Title>
      {action ?? (
        <DialogPrimitive.Close
          aria-label="Close"
          className="grid h-10 w-10 shrink-0 place-items-center rounded-full text-muted hover:bg-rowhover focus-visible:outline focus-visible:outline-2 focus-visible:outline-navy"
        >
          <X className="h-4 w-4" />
        </DialogPrimitive.Close>
      )}
    </div>
  );
}

export function SheetBody({ children, className }: { children: React.ReactNode; className?: string }) {
  return <div className={cn("min-h-0 flex-1 overflow-y-auto scroll-thin px-5 py-4", className)}>{children}</div>;
}

/** Footer, kept in view under the scrolling body. */
export function SheetFooter({ children, className }: { children: React.ReactNode; className?: string }) {
  return (
    <div className={cn("flex flex-none items-center gap-2.5 border-t border-hairline px-5 py-3", className)}>
      {children}
    </div>
  );
}
