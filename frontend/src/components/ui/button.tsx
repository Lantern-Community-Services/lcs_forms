import { cva, type VariantProps } from "class-variance-authority";
import { forwardRef, type ButtonHTMLAttributes } from "react";
import { cn } from "@/lib/utils";

const buttonVariants = cva(
  "inline-flex items-center justify-center gap-2 whitespace-nowrap rounded-input font-heading font-semibold transition-colors focus-visible:outline focus-visible:outline-2 focus-visible:outline-navy disabled:opacity-45 disabled:pointer-events-none",
  {
    variants: {
      variant: {
        // The faint inset edge (a darker shade of the fill) keeps the button's
        // shape visible when a custom theme's colour is close to the page.
        primary: "bg-navy text-navy-fg ring-1 ring-inset ring-navy-700/30 hover:bg-navy-600 active:bg-navy-700",
        // A visible edge (strongline, not the hairline dividers) so it reads as a button on white.
        secondary: "border border-strongline bg-surface text-ink hover:bg-rowhover",
        ghost: "text-accent hover:bg-subtle2",
        // Solid fills that hold white text at 4.5:1 or better, light and dark (index.css --st-*-fill).
        danger: "bg-status-redFill text-white hover:opacity-90",
        outlineDanger: "border border-status-redDot text-status-redText hover:bg-status-redBg",
        success: "bg-status-greenFill text-white hover:opacity-90",
      },
      // On a phone or tablet (`touch:`) every size reaches a finger-sized target.
      size: {
        sm: "h-8 px-3 text-label touch:min-h-11",
        md: "h-9 px-4 text-body touch:min-h-11",
        lg: "h-11 px-5 text-body-lg touch:min-h-12",
        icon: "h-9 w-9 p-0 touch:min-h-11 touch:min-w-11",
      },
    },
    defaultVariants: { variant: "primary", size: "md" },
  }
);

export interface ButtonProps
  extends ButtonHTMLAttributes<HTMLButtonElement>,
    VariantProps<typeof buttonVariants> {}

export const Button = forwardRef<HTMLButtonElement, ButtonProps>(
  ({ className, variant, size, ...props }, ref) => (
    <button ref={ref} className={cn(buttonVariants({ variant, size }), className)} {...props} />
  )
);
Button.displayName = "Button";

export { buttonVariants };
