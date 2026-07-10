import * as React from "react";
import { Check } from "lucide-react";
import { cn } from "@/lib/utils";

interface CheckboxProps extends Omit<
  React.ComponentProps<"button">,
  "onChange"
> {
  checked?: boolean;
  onCheckedChange?: (checked: boolean) => void;
}

function Checkbox({
  checked = false,
  onCheckedChange,
  className,
  ...props
}: CheckboxProps) {
  return (
    <button
      type="button"
      role="checkbox"
      aria-checked={checked}
      onClick={() => onCheckedChange?.(!checked)}
      className={cn(
        "peer flex size-3.5 shrink-0 cursor-pointer items-center justify-center rounded-xs border transition-colors focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:outline-none disabled:cursor-not-allowed disabled:opacity-50",
        checked
          ? "border-primary bg-primary text-primary-foreground"
          : "border-input bg-transparent",
        className,
      )}
      {...props}
    >
      {checked && <Check className="size-3" strokeWidth={3} />}
    </button>
  );
}

export { Checkbox };
