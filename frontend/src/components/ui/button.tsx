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
        secondary: "border border-hairline bg-surface text-ink hover:bg-rowhover hover:border-strongline",
        ghost: "text-accent hover:bg-subtle2",
        danger: "bg-status-redText text-white hover:opacity-90",
        outlineDanger: "border border-status-redDot text-status-redText hover:bg-status-redBg",
        success: "bg-status-greenDot text-white hover:opacity-90",
      },
      size: {
        sm: "h-8 px-3 text-[13px]",
        md: "h-9 px-4 text-[13.5px]",
        lg: "h-11 px-5 text-[15px]",
        icon: "h-9 w-9 p-0",
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
