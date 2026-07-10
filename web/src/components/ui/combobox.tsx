import * as React from "react";
import { cn } from "@/lib/utils";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import {
  Command,
  CommandEmpty,
  CommandInput,
  CommandItem,
  CommandList,
} from "@/components/ui/command";

// Generic searchable combobox with an optional "type a custom value" affordance.
// Backed by cmdk for keyboard navigation. Used by the model editor and the
// Add-Provider wizard's upstream-model picker. When `allowCustom` is set, the
// current query is offered as a selectable custom entry (Enter selects it).
export function Combobox({
  value,
  onChange,
  options,
  descriptions,
  placeholder = "Select…",
  searchPlaceholder = "Filter…",
  emptyText = "No match",
  allowCustom = false,
  mono = false,
  className,
}: {
  value: string;
  onChange: (v: string) => void;
  options: string[];
  /** Optional secondary label per option value (e.g. a display name). */
  descriptions?: Record<string, string | undefined>;
  placeholder?: string;
  searchPlaceholder?: string;
  emptyText?: string;
  allowCustom?: boolean;
  mono?: boolean;
  className?: string;
}) {
  const [open, setOpen] = React.useState(false);
  const [query, setQuery] = React.useState("");

  const pick = (v: string) => {
    onChange(v);
    setOpen(false);
    setQuery("");
  };

  const q = query.trim();
  const showCustom = allowCustom && q.length > 0 && !options.includes(q);

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button
          type="button"
          role="combobox"
          aria-expanded={open}
          className={cn(
            // Shared control surface — matches Button / Input / Select / Textarea.
            // 13px (text-[0.8125rem]) keeps controls in scale with the 12px content.
            "flex h-9 w-full cursor-pointer items-center justify-between gap-2 rounded-lg border border-input bg-transparent px-3 py-2 text-[0.8125rem] transition-colors outline-none",
            "placeholder:text-muted-foreground",
            "focus:border-ring focus:ring-2 focus:ring-ring/50",
            "dark:bg-input/30",
            mono && "font-mono",
            className,
          )}
        >
          <span
            className={cn(
              "min-w-0 truncate",
              !value && "text-muted-foreground",
            )}
          >
            {value || placeholder}
          </span>
          {options.length > 0 && (
            <span className="shrink-0 rounded-full bg-muted px-1.5 text-[0.65rem] tabular-nums text-muted-foreground">
              {options.length}
            </span>
          )}
        </button>
      </PopoverTrigger>
      <PopoverContent
        className="w-[var(--radix-popover-trigger-width)] min-w-60 p-0"
        align="start"
        onOpenAutoFocus={(e) => e.preventDefault()}
      >
        <Command
          filter={(v, search) =>
            v.toLowerCase().includes(search.toLowerCase()) ? 1 : 0
          }
        >
          <CommandInput
            placeholder={searchPlaceholder}
            value={query}
            onValueChange={setQuery}
            className={mono ? "font-mono" : undefined}
            onKeyDown={(e) => {
              if (e.key === "Enter" && showCustom) {
                e.preventDefault();
                pick(q);
              }
            }}
          />
          <CommandList>
            <CommandEmpty>
              {allowCustom
                ? "Type and press Enter for a custom value"
                : emptyText}
            </CommandEmpty>
            {showCustom && (
              <CommandItem
                value={q}
                onSelect={() => pick(q)}
                className={mono ? "font-mono" : undefined}
              >
                Use “{q}”
              </CommandItem>
            )}
            {options.map((o) => {
              const desc = descriptions?.[o];
              return (
                <CommandItem
                  key={o}
                  value={o}
                  onSelect={() => pick(o)}
                  className={cn(
                    "gap-2",
                    o === value && "bg-accent text-accent-foreground",
                  )}
                >
                  <span className={cn("min-w-0 truncate", mono && "font-mono")}>
                    {o}
                  </span>
                  {desc && (
                    <span className="ml-auto min-w-0 shrink truncate text-[0.7rem] text-muted-foreground">
                      {desc}
                    </span>
                  )}
                </CommandItem>
              );
            })}
          </CommandList>
        </Command>
      </PopoverContent>
    </Popover>
  );
}
