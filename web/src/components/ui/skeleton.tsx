import * as React from "react";
import { cn } from "@/lib/utils";

// Base pulsing placeholder block. Compose with width/height utility classes
// at the call site (e.g. `<Skeleton className="h-4 w-32" />`).
function Skeleton({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="skeleton"
      className={cn("animate-pulse rounded-md bg-muted", className)}
      {...props}
    />
  );
}

export { Skeleton };
