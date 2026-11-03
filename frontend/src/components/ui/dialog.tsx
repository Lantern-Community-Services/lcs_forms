import * as DialogPrimitive from "@radix-ui/react-dialog";
import { X } from "lucide-react";
import { forwardRef } from "react";
import { cn } from "@/lib/utils";

export const Dialog = DialogPrimitive.Root;
export const DialogTrigger = DialogPrimitive.Trigger;
export const DialogClose = DialogPrimitive.Close;

export const DialogContent = forwardRef<
  React.ElementRef<typeof DialogPrimitive.Content>,
  React.ComponentPropsWithoutRef<typeof DialogPrimitive.Content> & { hideClose?: boolean }
>(({ className, children, hideClose, ...props }, ref) => (
  <DialogPrimitive.Portal>
    <DialogPrimitive.Overlay className="fixed inset-0 z-50 bg-[rgba(35,42,58,0.5)] data-[state=open]:animate-in data-[state=open]:fade-in-0" />
    <DialogPrimitive.Content
      ref={ref}
      className={cn(
        "fixed left-1/2 top-1/2 z-50 w-[min(560px,calc(100vw-2rem))] -translate-x-1/2 -translate-y-1/2",
        // Never taller than the screen: the body scrolls, the header and footer stay put.
        "flex max-h-[calc(100dvh-2rem)] flex-col",
        "rounded-card bg-surface p-0 shadow-modal focus:outline-none",
        className
      )}
      {...props}
    >
      {children}
      {!hideClose && (
        <DialogPrimitive.Close className="absolute right-4 top-4 rounded-input p-1 text-muted hover:bg-rowhover focus-visible:outline focus-visible:outline-2 focus-visible:outline-navy">
          <X className="h-4 w-4" />
        </DialogPrimitive.Close>
      )}
    </DialogPrimitive.Content>
  </DialogPrimitive.Portal>
));
DialogContent.displayName = "DialogContent";

export function DialogHeader({ title, subtitle }: { title: string; subtitle?: string }) {
  return (
    <div className="shrink-0 border-b border-hairline px-6 py-4">
      <DialogPrimitive.Title className="text-[19px] font-heading font-extrabold text-ink">{title}</DialogPrimitive.Title>
      {subtitle && <DialogPrimitive.Description className="mt-0.5 text-[13px] text-muted">{subtitle}</DialogPrimitive.Description>}
    </div>
  );
}

export function DialogBody({ children, className }: { children: React.ReactNode; className?: string }) {
  return <div className={cn("min-h-0 flex-1 overflow-y-auto px-6 py-5", className)}>{children}</div>;
}

export function DialogFooter({ children }: { children: React.ReactNode }) {
  return <div className="flex shrink-0 items-center justify-end gap-2 border-t border-hairline px-6 py-4">{children}</div>;
}
