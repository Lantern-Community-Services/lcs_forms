import { useIsPhone } from "@/lib/useMediaQuery";
import { Dialog, DialogBody, DialogContent, DialogFooter, DialogHeader } from "./dialog";
import { Sheet, SheetBody, SheetContent, SheetFooter, SheetHeader } from "./sheet";

/**
 * A popup that is a bottom sheet on a phone — its actions under the thumb —
 * and a centred dialog on desktop. `children` is the body and `footer` the
 * action row; both render unchanged in either form.
 *
 * The class props reach the matching piece of each form, for a popup that
 * needs a different size or scrolling on one of them (Take attendance).
 */
export function ResponsiveDialog({
  open,
  onOpenChange,
  title,
  children,
  footer,
  sheetClassName,
  sheetBodyClassName,
  dialogClassName,
  dialogBodyClassName,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: string;
  children: React.ReactNode;
  footer?: React.ReactNode;
  sheetClassName?: string;
  sheetBodyClassName?: string;
  dialogClassName?: string;
  dialogBodyClassName?: string;
}) {
  const phone = useIsPhone();

  if (phone) {
    return (
      <Sheet open={open} onOpenChange={onOpenChange}>
        <SheetContent aria-describedby={undefined} className={sheetClassName}>
          <SheetHeader title={title} />
          <SheetBody className={sheetBodyClassName}>{children}</SheetBody>
          {footer && <SheetFooter>{footer}</SheetFooter>}
        </SheetContent>
      </Sheet>
    );
  }
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent aria-describedby={undefined} className={dialogClassName}>
        <DialogHeader title={title} />
        <DialogBody className={dialogBodyClassName}>{children}</DialogBody>
        {footer && <DialogFooter>{footer}</DialogFooter>}
      </DialogContent>
    </Dialog>
  );
}
