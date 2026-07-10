import * as React from "react";
import { cn } from "@/lib/utils";

const Textarea = React.forwardRef<
  HTMLTextAreaElement,
  React.TextareaHTMLAttributes<HTMLTextAreaElement>
>(({ className, ...props }, ref) => (
  <textarea
    ref={ref}
    className={cn(
      // Shared control surface — matches Button / Input / Select / Combobox.
      // 13px (text-[0.8125rem]) keeps controls in scale with the 12px content.
      "scrollbar-thin flex min-h-20 w-full rounded-lg border border-input bg-transparent px-3 py-2 text-[0.8125rem] transition-colors outline-none",
      "placeholder:text-muted-foreground",
      "focus-visible:border-ring focus-visible:ring-2 focus-visible:ring-ring/50",
      "disabled:cursor-not-allowed disabled:opacity-50",
      "resize-y",
      "aria-invalid:border-destructive aria-invalid:ring-2 aria-invalid:ring-destructive/20",
      "dark:bg-input/30",
      className,
    )}
    {...props}
  />
));
Textarea.displayName = "Textarea";

export { Textarea };
