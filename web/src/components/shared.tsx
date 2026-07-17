import { memo, type ReactNode } from "react";
import {
  ChevronLeft,
  ChevronRight,
  Check,
  ArrowLeft,
  Search,
  X,
} from "lucide-react";
import { Link } from "react-router-dom";
import { Area, AreaChart, CartesianGrid, XAxis, YAxis } from "recharts";
import { cn, fmtNum, fmtTokens } from "@/lib/utils";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { Table, TableBody, TableCell, TableRow } from "@/components/ui/table";
import {
  ChartContainer,
  ChartTooltip,
  ChartTooltipContent,
  type ChartConfig,
} from "@/components/ui/chart";

export function PageHeader({
  title,
  desc,
  meta,
  actions,
}: {
  title: ReactNode;
  desc?: string;
  // Rendered next to the title — e.g. a count badge that used to live in a
  // redundant card header below.
  meta?: ReactNode;
  actions?: ReactNode;
}) {
  return (
    <div className="mb-3 flex flex-wrap items-end justify-between gap-3">
      {/* min-w-0 lets this shrink below its content's natural width — without
          it, a flex row item defaults to min-width:auto, which locks the
          block to the description text's unwrapped width and gets clipped by
          an ancestor's overflow-hidden instead of wrapping on narrow/mobile
          viewports. */}
      <div className="min-w-0">
        <div className="flex flex-wrap items-center gap-2.5">
          <h1 className="text-lg font-semibold tracking-tight text-foreground">
            {title}
          </h1>
          {meta}
        </div>
        {desc && <p className="mt-0.5 text-xs text-muted-foreground">{desc}</p>}
      </div>
      {actions && (
        <div className="flex flex-wrap items-center gap-2">{actions}</div>
      )}
    </div>
  );
}

// A table's own search box — designed to read as PART of the table (sits
// inside its header strip, borderless + recessed) rather than a separate
// filter control floating above it. One shared component so every table's
// search looks and behaves identically app-wide. `count`/`total` (optional)
// render a live "N of M" hint while filtering, right next to the clear button.
export function TableSearch({
  value,
  onChange,
  placeholder = "Search…",
  count,
  total,
  className,
}: {
  value: string;
  onChange: (v: string) => void;
  placeholder?: string;
  count?: number;
  total?: number;
  className?: string;
}) {
  const showCount = !!value && count != null && total != null;
  return (
    <div className={cn("relative w-full sm:w-64", className)}>
      <Search className="pointer-events-none absolute top-1/2 left-2.5 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" />
      <input
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder}
        className={cn(
          "h-8 w-full rounded-md border border-transparent bg-muted/60 py-1.5 pl-8 text-xs text-foreground transition-colors outline-none",
          showCount ? "pr-16" : "pr-7",
          "placeholder:text-muted-foreground",
          "hover:bg-muted",
          "focus-visible:border-ring focus-visible:bg-background focus-visible:ring-2 focus-visible:ring-ring/50",
        )}
      />
      {value && (
        <div className="absolute top-1/2 right-1 flex -translate-y-1/2 items-center gap-1">
          {showCount && (
            <span className="pointer-events-none text-[0.65rem] tabular-nums text-muted-foreground/70">
              {count}/{total}
            </span>
          )}
          <Button
            type="button"
            variant="ghost"
            size="icon-xs"
            onClick={() => onChange("")}
            aria-label="Clear search"
            className="text-muted-foreground hover:text-foreground"
          >
            <X className="h-3 w-3" />
          </Button>
        </div>
      )}
    </div>
  );
}

export const Stat = memo(function Stat({
  label,
  value,
  hint,
  accent,
}: {
  label: string;
  value: ReactNode;
  hint?: string;
  accent?: boolean;
}) {
  return (
    <Card className="gap-0.5 p-3">
      <div className="text-xs text-muted-foreground">{label}</div>
      <div
        className={cn(
          "text-xl font-bold tabular-nums leading-none",
          accent ? "text-primary" : "text-foreground",
        )}
      >
        {value}
      </div>
      {hint && <div className="text-xs text-muted-foreground">{hint}</div>}
    </Card>
  );
});

// Footer pagination bar. Client-side tables pass pageCount; server-side lists
// (offset queries with unknown total) pass hasNext instead. Renders nothing
// when there is only one page.
export function Pagination({
  page,
  pageCount,
  hasNext,
  onChange,
  className,
}: {
  page: number;
  pageCount?: number;
  hasNext?: boolean;
  onChange: (page: number) => void;
  className?: string;
}) {
  const more = pageCount != null ? page < pageCount - 1 : !!hasNext;
  if (page === 0 && !more) return null;
  return (
    <div
      className={cn(
        "flex items-center justify-between border-t border-border px-4 py-2",
        className,
      )}
    >
      <span className="text-xs tabular-nums text-muted-foreground">
        {pageCount != null
          ? `page ${page + 1} of ${pageCount}`
          : `page ${page + 1}`}
      </span>
      <div className="flex gap-1">
        <Button
          variant="ghost"
          size="sm"
          disabled={page === 0}
          onClick={() => onChange(page - 1)}
        >
          <ChevronLeft className="h-3.5 w-3.5" />
          Prev
        </Button>
        <Button
          variant="ghost"
          size="sm"
          disabled={!more}
          onClick={() => onChange(page + 1)}
        >
          Next
          <ChevronRight className="h-3.5 w-3.5" />
        </Button>
      </div>
    </div>
  );
}

// Placeholder rows for a table that's still loading \u2014 mirrors real TableRow/
// TableCell markup (borders, padding, hover) so the layout doesn't jump once
// data lands. `widths` gives each column a distinct skeleton bar width so the
// fake rows read as columns instead of one uniform gray block; cycles if
// there are more columns than widths given.
export function TableSkeleton({
  rows = 6,
  cols = 4,
  widths = ["60%", "80%", "40%", "50%"],
}: {
  rows?: number;
  cols?: number;
  widths?: string[];
}) {
  return (
    <Table>
      <TableBody>
        {Array.from({ length: rows }).map((_, r) => (
          <TableRow key={r} className="hover:bg-transparent">
            {Array.from({ length: cols }).map((_, c) => (
              <TableCell key={c}>
                <Skeleton
                  className="h-4"
                  style={{ width: widths[c % widths.length] }}
                />
              </TableCell>
            ))}
          </TableRow>
        ))}
      </TableBody>
    </Table>
  );
}

// Placeholder grid of Stat-shaped cards (label + big number), for dashboards
// that render a `grid-cols-*` row of Stat before data arrives.
export function StatGridSkeleton({ count = 4 }: { count?: number }) {
  return (
    <>
      {Array.from({ length: count }).map((_, i) => (
        <Card key={i} className="gap-2 p-3">
          <Skeleton className="h-3 w-16" />
          <Skeleton className="h-7 w-20" />
        </Card>
      ))}
    </>
  );
}

// Placeholder grid of provider/model-card-shaped tiles.
export function CardGridSkeleton({
  count = 6,
  className,
}: {
  count?: number;
  className?: string;
}) {
  return (
    <div
      className={cn(
        "grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3",
        className,
      )}
    >
      {Array.from({ length: count }).map((_, i) => (
        <Card key={i} className="gap-3 p-4">
          <div className="flex items-center gap-2.5">
            <Skeleton className="size-8 shrink-0 rounded-full" />
            <div className="flex-1 space-y-1.5">
              <Skeleton className="h-3.5 w-2/3" />
              <Skeleton className="h-2.5 w-1/3" />
            </div>
          </div>
          <Skeleton className="h-2.5 w-full" />
          <Skeleton className="h-2.5 w-4/5" />
        </Card>
      ))}
    </div>
  );
}

// Placeholder for a grid of small usage/quota cards (key mask + a couple of
// progress-bar-shaped rows), matching KeyUsageBlock's rounded-card layout.
export function UsageBlockGridSkeleton({ count = 4 }: { count?: number }) {
  return (
    <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
      {Array.from({ length: count }).map((_, i) => (
        <div
          key={i}
          className="rounded-lg border border-border/70 bg-muted/20 p-3"
        >
          <div className="mb-2.5 flex items-center justify-between gap-2">
            <Skeleton className="h-3 w-24" />
            <Skeleton className="h-3 w-10" />
          </div>
          <div className="space-y-1.5">
            <Skeleton className="h-2 w-full" />
            <Skeleton className="h-2 w-full" />
          </div>
        </div>
      ))}
    </div>
  );
}

// Placeholder key/value rows for the Provider Overview-style two-column list.
export function KeyValueSkeleton({ rows = 8 }: { rows?: number }) {
  return (
    <div className="grid grid-cols-1 gap-x-8 gap-y-2 sm:grid-cols-2">
      {Array.from({ length: rows }).map((_, i) => (
        <div
          key={i}
          className="flex items-center justify-between gap-3 border-b border-border/60 py-1.5"
        >
          <Skeleton className="h-3 w-24" />
          <Skeleton className="h-3 w-16" />
        </div>
      ))}
    </div>
  );
}

// Placeholder form skeleton \u2014 a handful of label+control rows, for settings
// pages / forms hydrating from an async fetch (e.g. Settings before load).
export function FormSkeleton({ rows = 4 }: { rows?: number }) {
  return (
    <div className="space-y-4">
      {Array.from({ length: rows }).map((_, i) => (
        <div key={i} className="space-y-1.5">
          <Skeleton className="h-3 w-28" />
          <Skeleton className="h-9 w-full" />
        </div>
      ))}
    </div>
  );
}

// Placeholder for a full routed detail/editor page: back-link + title row +
// underline tabs + a form-shaped body. Used while the record itself (not just
// a list) is still loading, so the shell doesn't pop in piece by piece.
export function PageSkeleton({ tabs = 3 }: { tabs?: number }) {
  return (
    <div className="space-y-4">
      <Skeleton className="h-3.5 w-32" />
      <div className="flex items-end justify-between gap-3">
        <div className="space-y-2">
          <Skeleton className="h-6 w-48" />
          <Skeleton className="h-3 w-64" />
        </div>
        <Skeleton className="h-9 w-24" />
      </div>
      <div className="flex gap-4 border-b border-border/60 pb-2">
        {Array.from({ length: tabs }).map((_, i) => (
          <Skeleton key={i} className="h-4 w-16" />
        ))}
      </div>
      <FormSkeleton />
    </div>
  );
}

export function EmptyState({ msg }: { msg: string }) {
  return (
    <div className="p-8 text-center text-xs text-muted-foreground">{msg}</div>
  );
}

const tokenChartConfig = {
  tokens: { label: "Tokens", color: "var(--chart-1)" },
} satisfies ChartConfig;

// Gradient-filled area chart for token usage over time, built on Recharts via
// the shadcn chart primitives. Reads well for sparse and trending data alike
// (a single non-zero bucket shows a clear peak, not a lone bar). Each point is
// `{ label, tokens }`; `label` is the X-axis tick + tooltip title.
export function TokenChart({
  data,
  minHeight = 160,
}: {
  data: Array<{ label: string; tokens: number }>;
  minHeight?: number;
}) {
  return (
    <ChartContainer
      config={tokenChartConfig}
      // `aspect-auto` cancels ChartContainer's default `aspect-video` (16:9),
      // which otherwise inflates the chart height as the card grows wider.
      // `flex-1` + `min-h-0` let the chart grow to fill the card content's
      // available height (CardContent is a flex column), while the inline
      // min-height sets a floor so it never collapses below a usable size. The
      // chart follows the card's natural height instead of forcing its own.
      className="aspect-auto h-full min-h-0 w-full flex-1"
      style={{ minHeight }}
    >
      <AreaChart data={data} margin={{ left: 4, right: 8, top: 4 }}>
        <defs>
          <linearGradient id="fillTokens" x1="0" y1="0" x2="0" y2="1">
            <stop
              offset="5%"
              stopColor="var(--color-tokens)"
              stopOpacity={0.7}
            />
            <stop
              offset="95%"
              stopColor="var(--color-tokens)"
              stopOpacity={0.05}
            />
          </linearGradient>
        </defs>
        <CartesianGrid vertical={false} strokeOpacity={0.4} />
        <XAxis
          dataKey="label"
          tickLine={false}
          axisLine={false}
          tickMargin={8}
          minTickGap={24}
          interval="preserveStartEnd"
          className="text-[0.6rem]"
        />
        <YAxis
          width={40}
          tickLine={false}
          axisLine={false}
          tickMargin={4}
          tickCount={5}
          allowDecimals={false}
          tickFormatter={(v: number) => fmtTokens(v)}
          className="text-[0.6rem]"
        />
        <ChartTooltip
          cursor={{ strokeOpacity: 0.3 }}
          content={
            <ChartTooltipContent
              indicator="line"
              formatter={(value) => (
                <span className="flex w-full items-center justify-between gap-3">
                  <span className="text-muted-foreground">Tokens</span>
                  <span className="font-mono font-medium tabular-nums text-foreground">
                    {fmtNum(value as number)}
                  </span>
                </span>
              )}
            />
          }
        />
        <Area
          dataKey="tokens"
          type="monotone"
          fill="url(#fillTokens)"
          stroke="var(--color-tokens)"
          strokeWidth={2}
          dot={false}
          activeDot={{ r: 4 }}
        />
      </AreaChart>
    </ChartContainer>
  );
}

export function Field({
  label,
  children,
  hint,
}: {
  label: ReactNode;
  children: ReactNode;
  hint?: string;
}) {
  return (
    <div>
      <label className="text-xs font-medium text-foreground mb-1 block">
        {label}
      </label>
      {children}
      {hint && (
        <p className="mt-1 text-[0.65rem] text-muted-foreground">{hint}</p>
      )}
    </div>
  );
}

// A titled group of settings — a light header + a divided body. No nested card
// chrome (the page already provides the surface), so rows use the full width.
export function FormSection({
  title,
  desc,
  children,
  className,
}: {
  title: string;
  desc?: string;
  children: ReactNode;
  className?: string;
}) {
  return (
    <section className={cn("space-y-1", className)}>
      <div className="pb-1">
        <h3 className="text-sm font-semibold text-foreground">{title}</h3>
        {desc && <p className="text-xs text-muted-foreground">{desc}</p>}
      </div>
      <div className="divide-y divide-border/60 rounded-lg border border-border">
        {children}
      </div>
    </section>
  );
}

// One horizontal setting row inside a FormSection: label + optional hint on the
// left, the control aligned on the right. Labels line up across rows, actions
// share the same right edge — much clearer than stacked cards.
export function SettingRow({
  label,
  hint,
  children,
  htmlFor,
}: {
  label: ReactNode;
  hint?: ReactNode;
  children: ReactNode;
  htmlFor?: string;
}) {
  return (
    <div className="flex flex-col gap-2 px-3 py-2.5 sm:flex-row sm:items-center sm:justify-between sm:gap-6">
      <div className="min-w-0 sm:max-w-[46%]">
        <label
          htmlFor={htmlFor}
          className="block text-sm font-medium text-foreground"
        >
          {label}
        </label>
        {hint && (
          <p className="mt-0.5 text-xs leading-snug text-muted-foreground">
            {hint}
          </p>
        )}
      </div>
      <div className="w-full min-w-0 sm:w-auto sm:max-w-[54%] sm:flex-1">
        {children}
      </div>
    </div>
  );
}

// Underline section-tab bar (the pattern Settings uses). Controlled: the caller
// owns the active id and renders the matching panel. Presentational.
export function SectionTabs<T extends string>({
  sections,
  active,
  onChange,
  className,
}: {
  sections: ReadonlyArray<{ id: T; label: string; badge?: ReactNode }>;
  active: T;
  onChange: (id: T) => void;
  className?: string;
}) {
  return (
    <div className={cn("flex gap-1 border-b border-border/60", className)}>
      {sections.map((s) => (
        <button
          key={s.id}
          type="button"
          onClick={() => onChange(s.id)}
          className={cn(
            "relative flex cursor-pointer items-center gap-1.5 px-3 py-2 text-sm font-medium transition-colors",
            active === s.id
              ? "text-foreground"
              : "text-muted-foreground hover:text-foreground",
          )}
        >
          {s.label}
          {s.badge}
          {active === s.id && (
            <span className="absolute right-0 bottom-0 left-0 h-0.5 rounded-full bg-primary" />
          )}
        </button>
      ))}
    </div>
  );
}

// A "← Back to X" breadcrumb link for detail pages.
export function BackLink({ to, label }: { to: string; label: string }) {
  return (
    <Link
      to={to}
      className="inline-flex items-center gap-1 text-xs font-medium text-muted-foreground transition-colors hover:text-foreground"
    >
      <ArrowLeft className="h-3.5 w-3.5" />
      {label}
    </Link>
  );
}

// Horizontal step indicator for multi-step flows (the Add-Provider wizard).
// Shows numbered dots joined by connector lines; completed steps get a check,
// the current step is highlighted, future steps are muted. Presentational only.
export function Stepper({
  steps,
  current,
  className,
}: {
  steps: string[];
  current: number;
  className?: string;
}) {
  return (
    <div className={cn("flex items-center", className)}>
      {steps.map((label, i) => {
        const done = i < current;
        const active = i === current;
        return (
          <div key={label} className="flex flex-1 items-center last:flex-none">
            <div className="flex items-center gap-2">
              <span
                className={cn(
                  "flex size-6 shrink-0 items-center justify-center rounded-full border text-[0.7rem] font-medium tabular-nums transition-colors",
                  done && "border-primary bg-primary text-primary-foreground",
                  active && "border-primary text-primary",
                  !done && !active && "border-border text-muted-foreground",
                )}
              >
                {done ? <Check className="h-3.5 w-3.5" /> : i + 1}
              </span>
              <span
                className={cn(
                  "whitespace-nowrap text-xs font-medium transition-colors",
                  active ? "text-foreground" : "text-muted-foreground",
                )}
              >
                {label}
              </span>
            </div>
            {i < steps.length - 1 && (
              <span
                className={cn(
                  "mx-3 h-px flex-1 transition-colors",
                  done ? "bg-primary" : "bg-border",
                )}
              />
            )}
          </div>
        );
      })}
    </div>
  );
}
