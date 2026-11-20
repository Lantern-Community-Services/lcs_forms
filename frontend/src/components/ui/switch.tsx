import * as SwitchPrimitive from "@radix-ui/react-switch";
import { forwardRef } from "react";
import { cn } from "@/lib/utils";

export const Switch = forwardRef<
  React.ElementRef<typeof SwitchPrimitive.Root>,
  React.ComponentPropsWithoutRef<typeof SwitchPrimitive.Root>
>(({ className, ...props }, ref) => (
  <SwitchPrimitive.Root
    ref={ref}
    className={cn(
      "peer relative inline-flex h-5 w-9 shrink-0 cursor-pointer items-center rounded-pill border-2 border-transparent transition-colors",
      // A finger-sized switch on a phone or tablet, with a 44px-tall hit area around the track.
      "touch:h-7 touch:w-12 touch:after:absolute touch:after:-inset-x-1 touch:after:-inset-y-2.5",
      "focus-visible:outline focus-visible:outline-2 focus-visible:outline-navy",
      "data-[state=checked]:bg-navy data-[state=unchecked]:bg-fieldline",
      className
    )}
    {...props}
  >
    <SwitchPrimitive.Thumb className="pointer-events-none block h-4 w-4 rounded-full bg-white shadow transition-transform data-[state=checked]:translate-x-4 data-[state=unchecked]:translate-x-0 touch:h-6 touch:w-6 touch:data-[state=checked]:translate-x-5" />
  </SwitchPrimitive.Root>
));
Switch.displayName = "Switch";
