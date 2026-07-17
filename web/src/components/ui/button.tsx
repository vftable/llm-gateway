import * as React from "react";
import { cva, type VariantProps } from "class-variance-authority";
import { cn } from "@/lib/utils";

const buttonVariants = cva(
  // Unified control font: 13px (text-[0.8125rem]) — one step down from text-sm so
  // buttons sit in scale with the surrounding 12px content instead of reading
  // oversized. Matches Input / Select / Textarea / Combobox. Size variants that
  // need a different font (xs -> 12px, lg -> 14px) override this.
  "inline-flex items-center justify-center gap-1.5 whitespace-nowrap rounded-lg text-[0.8125rem] font-medium cursor-pointer transition-[color,background-color,border-color,box-shadow,transform] outline-none select-none focus-visible:border-ring focus-visible:ring-2 focus-visible:ring-ring/50 active:translate-y-px disabled:pointer-events-none disabled:opacity-50 [&_svg]:pointer-events-none [&_svg]:shrink-0 [&_svg:not([class*='size-'])]:size-4",
  {
    variants: {
      variant: {
        default: "bg-primary text-primary-foreground hover:bg-primary/80",
        outline:
          "border-border bg-background hover:bg-muted hover:text-foreground dark:border-input dark:bg-input/30 dark:hover:bg-input/50",
        secondary:
          "bg-secondary text-secondary-foreground hover:bg-secondary/80",
        // Recessed action for buttons that sit ON a card/panel: a subtly darker
        // fill than the surface (bg-background reads darker than --card in dark
        // mode) plus a hairline border, so the button keeps a defined shape at
        // rest instead of vanishing like `ghost`. Same recipe as the model-chain
        // provider refresh button. Hover lifts to the accent.
        soft: "border border-border bg-background text-foreground hover:bg-accent hover:text-accent-foreground",
        ghost: "hover:bg-muted hover:text-foreground dark:hover:bg-muted/50",
        destructive:
          "bg-destructive/10 text-destructive hover:bg-destructive/20 dark:bg-destructive/20 dark:hover:bg-destructive/30",
        link: "text-primary underline-offset-4 hover:underline",
      },
      size: {
        default: "h-8 px-3.5",
        xs: "h-6 gap-1 rounded-md px-2 text-xs [&_svg:not([class*='size-'])]:size-3",
        sm: "h-7 gap-1 rounded-lg px-2.5 [&_svg:not([class*='size-'])]:size-3.5",
        lg: "h-10 gap-1.5 px-4 text-sm",
        icon: "h-8 w-8",
        "icon-xs": "h-6 w-6 rounded-md [&_svg:not([class*='size-'])]:size-3",
        "icon-sm": "h-7 w-7 rounded-lg",
        "icon-lg": "h-10 w-10",
      },
    },
    defaultVariants: {
      variant: "default",
      size: "default",
    },
  },
);

export interface ButtonProps
  extends
    React.ButtonHTMLAttributes<HTMLButtonElement>,
    VariantProps<typeof buttonVariants> {}

const Button = React.forwardRef<HTMLButtonElement, ButtonProps>(
  ({ className, variant, size, ...props }, ref) => {
    return (
      <button
        className={cn(buttonVariants({ variant, size, className }))}
        ref={ref}
        {...props}
      />
    );
  },
);
Button.displayName = "Button";

export { Button, buttonVariants };
