import * as React from "react";
import {
  NavLink,
  Outlet,
  useNavigate,
  useMatch,
  useResolvedPath,
} from "react-router-dom";
import {
  Activity,
  Boxes,
  Cpu,
  Gauge,
  KeyRound,
  LineChart,
  ScrollText,
  Settings as SettingsIcon,
  UsersRound,
  LogOut,
  PanelLeftClose,
  PanelLeftOpen,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { clearToken } from "@/lib/api";
import { Button } from "@/components/ui/button";
import { ThemeToggle } from "@/components/theme-toggle";
import {
  Sheet,
  SheetContent,
  SheetHeader,
  SheetTitle,
  SheetDescription,
} from "@/components/ui/sheet";
import { Separator } from "@/components/ui/separator";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
  TooltipProvider,
} from "@/components/ui/tooltip";

const navGroups = [
  {
    label: "Overview",
    items: [
      { to: "/", label: "Overview", icon: Activity, end: true },
      { to: "/users", label: "Users", icon: UsersRound },
    ],
  },
  {
    label: "Access",
    items: [
      { to: "/providers", label: "Providers", icon: Boxes, end: true },
      { to: "/providers/usage", label: "Provider Usage", icon: Gauge },
      { to: "/models", label: "Models", icon: Cpu },
      { to: "/keys", label: "API Keys", icon: KeyRound },
    ],
  },
  {
    label: "Observability",
    items: [
      { to: "/usage", label: "Usage", icon: LineChart },
      { to: "/logs", label: "Request Logs", icon: ScrollText },
    ],
  },
  {
    label: "System",
    items: [{ to: "/settings", label: "Settings", icon: SettingsIcon }],
  },
];

const NavItem = React.memo(function NavItem({
  item,
  collapsed,
  onClick,
}: {
  item: {
    to: string;
    label: string;
    icon: React.ComponentType<{ className?: string }>;
    end?: boolean;
  };
  collapsed: boolean;
  onClick?: () => void;
}) {
  // Compute active state ourselves rather than via NavLink's className
  // callback: this node is rendered through Radix's <Slot> (TooltipTrigger
  // asChild), and Slot can't merge a *function* className — it would stringify
  // it, dropping every real class and collapsing the flex layout. A plain
  // string className merges correctly.
  const resolved = useResolvedPath(item.to);
  const active = !!useMatch({
    path: resolved.pathname,
    end: item.end ?? false,
  });
  const content = (
    <NavLink
      to={item.to}
      end={item.end}
      onClick={onClick}
      className={cn(
        "group flex items-center gap-3 overflow-hidden rounded-lg px-3 py-2 text-sm font-medium transition-colors duration-200 ease-in-out",
        active
          ? "bg-sidebar-accent text-sidebar-accent-foreground"
          : "text-sidebar-foreground/60 hover:bg-sidebar-accent/50 hover:text-sidebar-foreground",
      )}
    >
      {/* Dim the icon with element opacity (not a color alpha) so the stroked
          SVG doesn't double-up alpha at self-intersections. The label keeps its
          color alpha above — flat text has no overlap to worry about. */}
      <item.icon
        className={cn(
          "h-4 w-4 shrink-0 transition-opacity duration-200",
          active
            ? "opacity-100"
            : "text-sidebar-foreground opacity-60 group-hover:opacity-100",
        )}
      />
      {/* Stays mounted so it fades instead of popping; the parent's
          overflow-hidden clips it as the width animates. */}
      <span
        aria-hidden={collapsed}
        className={cn(
          "min-w-0 flex-1 truncate whitespace-nowrap transition-opacity duration-250 ease-sidebar",
          collapsed && "opacity-0",
        )}
      >
        {item.label}
      </span>
    </NavLink>
  );

  // The trigger stays mounted in the same tree whether or not it's collapsed —
  // swapping between a bare node and a wrapped one would remount the NavLink and
  // kill the opacity transition. Only the tooltip content is gated on collapsed.
  return (
    <Tooltip>
      <TooltipTrigger asChild>{content}</TooltipTrigger>
      {collapsed && (
        <TooltipContent side="right" sideOffset={8}>
          {item.label}
        </TooltipContent>
      )}
    </Tooltip>
  );
});

function SidebarNav({
  collapsed,
  onNavigate,
}: {
  collapsed: boolean;
  onNavigate?: () => void;
}) {
  return (
    <nav className="no-scrollbar flex-1 overflow-y-auto overflow-x-hidden px-2 py-2">
      {navGroups.map((group, i) => (
        <React.Fragment key={group.label}>
          {i > 0 && (
            <Separator className={cn("my-2", collapsed && "mx-2 w-auto")} />
          )}
          {/* Grid-rows 0fr→1fr animates the header's height closed while it
              fades, so collapsing doesn't leave an empty slot in the rail. */}
          <div
            aria-hidden={collapsed}
            className={cn(
              "grid transition-[grid-template-rows,opacity] duration-250 ease-sidebar",
              collapsed
                ? "grid-rows-[0fr] opacity-0"
                : "grid-rows-[1fr] opacity-100",
            )}
          >
            <div className="overflow-hidden">
              <div className="mb-1 truncate whitespace-nowrap px-3 pt-2 text-[0.65rem] font-semibold uppercase tracking-wider text-sidebar-foreground/40">
                {group.label}
              </div>
            </div>
          </div>
          <div className="flex flex-col gap-0.5">
            {group.items.map((item) => (
              <NavItem
                key={item.to}
                item={item}
                collapsed={collapsed}
                onClick={onNavigate}
              />
            ))}
          </div>
        </React.Fragment>
      ))}
    </nav>
  );
}

function SidebarFooter({ collapsed }: { collapsed: boolean }) {
  const navigate = useNavigate();
  const logout = () => {
    clearToken();
    navigate("/login");
  };

  // Styled identically to NavItem so the icon lines up with the nav icons
  // above it in both expanded and collapsed states.
  const button = (
    <button
      type="button"
      onClick={logout}
      className="group flex w-full items-center gap-3 overflow-hidden rounded-lg px-3 py-2 text-sm font-medium text-sidebar-foreground/60 transition-colors duration-200 ease-in-out hover:bg-sidebar-accent/50 hover:text-sidebar-foreground"
    >
      <LogOut className="h-4 w-4 shrink-0 text-sidebar-foreground opacity-60 transition-opacity duration-200 group-hover:opacity-100" />
      <span
        aria-hidden={collapsed}
        className={cn(
          "min-w-0 flex-1 truncate whitespace-nowrap text-left transition-opacity duration-250 ease-sidebar",
          collapsed && "opacity-0",
        )}
      >
        Sign out
      </span>
    </button>
  );

  return (
    <div className="border-t border-sidebar-border px-2 py-2">
      <Tooltip>
        <TooltipTrigger asChild>{button}</TooltipTrigger>
        {collapsed && (
          <TooltipContent side="right" sideOffset={8}>
            Sign out
          </TooltipContent>
        )}
      </Tooltip>
    </div>
  );
}

function Sidebar({ className, ...props }: React.ComponentProps<"aside">) {
  const [collapsed, setCollapsed] = React.useState(false);

  // The toggle is laid out exactly like a nav item (same px-3 slot inside the
  // same px-2 gutter), so its icon sits in the icon column in both states and
  // nothing jumps when the width animates.
  const toggle = (
    <button
      type="button"
      onClick={() => setCollapsed((c) => !c)}
      className="flex items-center gap-3 overflow-hidden rounded-lg px-3 py-2 text-sm font-medium text-sidebar-foreground/60 transition-colors duration-200 ease-in-out hover:bg-sidebar-accent/50 hover:text-sidebar-foreground"
    >
      {collapsed ? (
        <PanelLeftOpen className="h-4 w-4 shrink-0" />
      ) : (
        <PanelLeftClose className="h-4 w-4 shrink-0" />
      )}
    </button>
  );

  return (
    <aside
      className={cn(
        "hidden md:flex flex-col overflow-hidden border-r border-sidebar-border bg-sidebar transition-[width] duration-250 ease-sidebar",
        collapsed ? "w-[3.5rem]" : "w-[16rem]",
        className,
      )}
      {...props}
    >
      <div className="flex h-14 shrink-0 items-center border-b border-sidebar-border px-2">
        {/* flex-1 + min-w-0 lets this shrink to zero width as the rail closes
            (the toggle keeps its intrinsic size), so it fades while sliding
            shut instead of unmounting abruptly. */}
        <div
          aria-hidden={collapsed}
          className={cn(
            "min-w-0 flex-1 overflow-hidden transition-[opacity,padding] duration-250 ease-sidebar",
            collapsed ? "px-0 opacity-0" : "px-3",
          )}
        >
          <div className="truncate whitespace-nowrap text-sm font-semibold text-sidebar-foreground">
            LLM Gateway
          </div>
          <div className="truncate whitespace-nowrap text-[0.65rem] text-sidebar-foreground/50">
            control plane
          </div>
        </div>
        <Tooltip>
          <TooltipTrigger asChild>{toggle}</TooltipTrigger>
          {collapsed && (
            <TooltipContent side="right" sideOffset={8}>
              Expand sidebar
            </TooltipContent>
          )}
        </Tooltip>
      </div>
      <SidebarNav collapsed={collapsed} />
      <SidebarFooter collapsed={collapsed} />
    </aside>
  );
}

function MobileSidebar() {
  const [open, setOpen] = React.useState(false);

  return (
    <>
      <Button
        variant="ghost"
        size="icon"
        className="md:hidden h-8 w-8"
        onClick={() => setOpen(true)}
      >
        <PanelLeftOpen className="h-4 w-4" />
      </Button>
      <Sheet open={open} onOpenChange={setOpen}>
        <SheetContent side="left" className="w-[16rem] p-0">
          <SheetHeader className="sr-only">
            <SheetTitle>Navigation</SheetTitle>
            <SheetDescription>Main navigation menu</SheetDescription>
          </SheetHeader>
          <div className="flex h-full flex-col">
            <div className="flex h-14 shrink-0 items-center border-b border-sidebar-border px-5">
              <div className="min-w-0 flex-1">
                <div className="truncate text-sm font-semibold text-sidebar-foreground">
                  LLM Gateway
                </div>
                <div className="truncate text-[0.65rem] text-sidebar-foreground/50">
                  control plane
                </div>
              </div>
            </div>
            <SidebarNav collapsed={false} onNavigate={() => setOpen(false)} />
            <SidebarFooter collapsed={false} />
          </div>
        </SheetContent>
      </Sheet>
    </>
  );
}

function TopBar() {
  const [time, setTime] = React.useState(() => formatTime());

  React.useEffect(() => {
    const interval = setInterval(() => setTime(formatTime()), 1000);
    return () => clearInterval(interval);
  }, []);

  return (
    <header className="flex h-14 items-center gap-2 border-b border-border/40 bg-background px-4">
      <MobileSidebar />
      <div className="flex-1" />
      <div className="flex items-center gap-4 text-xs text-muted-foreground">
        <span className="hidden sm:inline font-mono tabular-nums">{time}</span>
        <span className="flex items-center gap-1.5">
          <span className="h-1.5 w-1.5 rounded-full bg-success" />
          operational
        </span>
      </div>
      <ThemeToggle />
    </header>
  );
}

function formatTime(): string {
  const now = new Date();
  const date = now.toISOString().slice(0, 10);
  const utc = now.toUTCString().slice(17, 25);
  return `${date} ${utc} UTC`;
}

export function Layout() {
  return (
    <TooltipProvider>
      <div className="flex h-screen w-screen overflow-hidden">
        <Sidebar />
        <div className="flex flex-1 flex-col overflow-hidden">
          <TopBar />
          <main
            className="no-scrollbar flex-1 overflow-y-auto p-6"
            style={{ contain: "layout style" }}
          >
            <Outlet />
          </main>
        </div>
      </div>
    </TooltipProvider>
  );
}
