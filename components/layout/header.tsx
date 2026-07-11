import { RefreshCw, Loader2 } from "lucide-react";

export function Header({
  title, totalProperties, hotDeals, onRefresh, isRefreshing,
}: {
  title: string;
  totalProperties?: number;
  hotDeals?: number;
  onRefresh?: () => void;
  isRefreshing?: boolean;
}) {
  return (
    <header className="flex items-center justify-between pl-16 pr-4 py-4 lg:px-6 border-b border-border bg-card/30">
      <div>
        <h1 className="text-xl font-bold">{title}</h1>
        <p className="text-xs text-muted-foreground">
          {totalProperties ?? 0} filings · {hotDeals ?? 0} worth knocking
        </p>
      </div>
      {onRefresh && (
        <button
          onClick={onRefresh}
          className="inline-flex items-center gap-2 rounded-lg bg-primary px-4 py-2 text-sm font-medium text-primary-foreground hover:opacity-90"
        >
          {isRefreshing ? <Loader2 className="h-4 w-4 animate-spin" /> : <RefreshCw className="h-4 w-4" />}
          {isRefreshing ? "Scanning…" : "Scan"}
        </button>
      )}
    </header>
  );
}
