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
  const showCustom =
    allowCustom && q.length > 0 && !options.includes(q);

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button
          type="button"
          className={cn(
            "flex h-9 w-full items-center justify-between gap-2 rounded-md border border-border bg-transparent px-3 py-2 text-sm placeholder:text-muted-foreground focus:outline-none focus:ring-1 focus:ring-ring cursor-pointer",
            mono && "font-mono",
            className,
          )}
        >
          <span
            className={cn("min-w-0 truncate", !value && "text-muted-foreground")}
          >
            {value || placeholder}
          </span>
          {options.length > 0 && (
            <span className="shrink-0 text-[0.65rem] text-muted-foreground">
              {options.length}
            </span>
          )}
        </button>
      </PopoverTrigger>
      <PopoverContent
        className="w-[280px] p-0"
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
              {allowCustom ? "Type and press Enter for a custom value" : emptyText}
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
            {options.map((o) => (
              <CommandItem
                key={o}
                value={o}
                onSelect={() => pick(o)}
                className={cn(
                  mono && "font-mono",
                  o === value && "bg-accent text-accent-foreground",
                )}
              >
                {o}
              </CommandItem>
            ))}
          </CommandList>
        </Command>
      </PopoverContent>
    </Popover>
  );
}
