"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { cn } from "@/lib/utils";
import { Flame, Kanban, Gavel, CalendarClock, Laptop } from "lucide-react";

const navItems = [
  { href: "/new-deals", label: "New Deals", icon: Flame, highlight: true },
  { href: "/pipeline", label: "CRM", icon: Kanban },
  { href: "/foreclosures", label: "Foreclosure Leads", icon: Gavel },
  { href: "/auctions", label: "Auctions", icon: CalendarClock },
  { href: "/join", label: "Add a Scanner", icon: Laptop },
];

export function Sidebar() {
  const pathname = usePathname();
  return (
    <aside className="fixed left-0 top-0 h-screen w-64 border-r border-border bg-card/40 p-5">
      <div className="mb-8 flex items-center gap-2">
        <div className="flex h-8 w-8 items-center justify-center rounded-lg bg-primary font-extrabold text-primary-foreground">D</div>
        <div>
          <p className="flex items-center gap-1.5 font-bold leading-tight">
            DealFinder <span className="rounded bg-primary/15 px-1.5 py-0.5 text-[10px] font-bold text-primary">V2</span>
          </p>
          <p className="text-xs leading-tight text-muted-foreground">Foreclosures · Auctions</p>
        </div>
      </div>
      <nav className="space-y-1 text-sm">
        {navItems.map((item) => {
          const active = pathname === item.href || pathname.startsWith(item.href + "/");
          const Icon = item.icon;
          if (item.highlight) {
            return (
              <Link key={item.href} href={item.href}
                className={cn("mb-1 flex items-center gap-2 rounded-lg border px-3 py-2 font-bold transition-colors",
                  active ? "border-primary bg-primary text-primary-foreground" : "border-primary/40 bg-primary/10 text-primary hover:bg-primary/20")}>
                <Icon className="h-4 w-4" /> {item.label}
              </Link>
            );
          }
          return (
            <Link key={item.href} href={item.href}
              className={cn("flex items-center gap-2 rounded-lg px-3 py-2 font-medium transition-colors",
                active ? "bg-accent text-foreground" : "text-muted-foreground hover:bg-accent hover:text-foreground")}>
              <Icon className="h-4 w-4" /> {item.label}
            </Link>
          );
        })}
      </nav>
      <p className="absolute bottom-5 left-5 right-5 text-[11px] text-muted-foreground">
        Central FL · door-knock + auction finder
      </p>
    </aside>
  );
}
