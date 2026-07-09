import { memo, type ReactNode } from "react";
import { ChevronLeft, ChevronRight, Check, ArrowLeft } from "lucide-react";
import { Link } from "react-router-dom";
import { Area, AreaChart, CartesianGrid, XAxis, YAxis } from "recharts";
import { cn, fmtNum, fmtTokens } from "@/lib/utils";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
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
    <div className="mb-5 flex flex-wrap items-end justify-between gap-3">
      <div>
        <div className="flex items-center gap-2.5">
          <h1 className="text-xl font-semibold tracking-tight text-foreground">
            {title}
          </h1>
          {meta}
        </div>
        {desc && <p className="text-xs text-muted-foreground mt-1">{desc}</p>}
      </div>
      {actions && <div className="flex items-center gap-2">{actions}</div>}
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
    <Card className="gap-1 p-3">
      <div className="text-xs text-muted-foreground">{label}</div>
      <div
        className={cn(
          "text-2xl font-bold tabular-nums",
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

export function Spinner({ label }: { label?: string }) {
  return (
    <div className="flex items-center gap-2 p-8 justify-center text-muted-foreground text-xs">
      <span className="inline-block h-3 w-3 animate-spin border border-primary border-t-transparent" />
      {label || "Loading\u2026"}
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
  label: string;
  children: ReactNode;
  hint?: string;
}) {
  return (
    <div>
      <label className="text-xs font-medium text-foreground mb-1.5 block">
        {label}
      </label>
      {children}
      {hint && (
        <p className="mt-1 text-[0.65rem] text-muted-foreground">{hint}</p>
      )}
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
