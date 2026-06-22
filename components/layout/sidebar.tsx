import { Home, Search } from "lucide-react";

export function Sidebar() {
  return (
    <aside className="fixed left-0 top-0 h-screen w-64 border-r border-border bg-card/40 p-5">
      <div className="flex items-center gap-2 mb-8">
        <div className="h-8 w-8 rounded-lg bg-primary flex items-center justify-center text-primary-foreground font-extrabold">D</div>
        <div>
          <p className="font-bold leading-tight">DealFinder</p>
          <p className="text-xs text-muted-foreground leading-tight">Foreclosure leads</p>
        </div>
      </div>
      <nav className="space-y-1 text-sm">
        <a href="/foreclosures" className="flex items-center gap-2 rounded-lg bg-accent px-3 py-2 font-medium">
          <Search className="h-4 w-4" /> Foreclosure Leads
        </a>
      </nav>
      <p className="absolute bottom-5 left-5 right-5 text-[11px] text-muted-foreground">
        Orange County, FL · door-knock finder
      </p>
    </aside>
  );
}
