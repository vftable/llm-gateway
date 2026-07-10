// shadcn's canonical sonner wrapper, adapted to this app's own useTheme hook
// (@/hooks/use-theme) instead of next-themes — the project has no next-themes
// dependency, and useTheme already drives the .dark class + <meta
// name="color-scheme"> everywhere else in the app, so this reuses that same
// source of truth rather than adding a second theme provider.
//
// Themed via sonner's own --normal-bg/--normal-text/--normal-border CSS vars
// (mapped to the app's --popover palette) instead of a hardcoded
// toastOptions.style object, so the toast repaints with the rest of the app
// on a theme toggle. `font-mono` on the toaster's own className cascades to
// every toast (title, description, action/cancel buttons) as a real Tailwind
// utility resolving to --font-mono, replacing the old inline
// `fontFamily: "JetBrains Mono, monospace"` — which named the NON-variable
// family even though only "JetBrains Mono Variable" is loaded
// (@fontsource-variable/jetbrains-mono), so it silently fell back to the
// browser's generic monospace font on every toast.
import type { CSSProperties } from "react";
import { Toaster as Sonner, type ToasterProps } from "sonner";
import { useTheme } from "@/hooks/use-theme";
import { cn } from "@/lib/utils";

function Toaster({ className, ...props }: ToasterProps) {
  const { theme } = useTheme();

  return (
    <Sonner
      theme={theme}
      position="bottom-right"
      className={cn("toaster group font-mono", className)}
      style={
        {
          "--normal-bg": "var(--popover)",
          "--normal-text": "var(--popover-foreground)",
          "--normal-border": "var(--border)",
        } as CSSProperties
      }
      toastOptions={{ className: "font-mono text-xs" }}
      {...props}
    />
  );
}

export { Toaster };
