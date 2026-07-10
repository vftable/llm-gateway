import * as React from "react";
import { cn } from "@/lib/utils";

interface SwitchProps extends Omit<React.ComponentProps<"button">, "onChange"> {
  checked?: boolean;
  onCheckedChange?: (checked: boolean) => void;
}

function Switch({
  checked = false,
  onCheckedChange,
  className,
  ...props
}: SwitchProps) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      onClick={() => onCheckedChange?.(!checked)}
      className={cn(
        "peer inline-flex h-5 w-9 shrink-0 cursor-pointer items-center rounded-full border-2 border-transparent transition-colors focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:outline-none disabled:cursor-not-allowed disabled:opacity-50",
        checked ? "bg-primary" : "bg-input",
        className,
      )}
      {...props}
    >
      <span
        className={cn(
          // Positional slide — same snappy S-curve as the sidebar's own motion.
          "pointer-events-none block size-4 rounded-full bg-background shadow-lg ring-0 transform-gpu will-change-transform transition-transform duration-200 ease-sidebar",
          checked ? "translate-x-4" : "translate-x-0",
        )}
      />
    </button>
  );
}

export { Switch };
