import { cn } from "@/lib/utils";

type BadgeProps = React.HTMLAttributes<HTMLSpanElement> & {
  variant?: "default" | "secondary" | "outline";
};

const VARIANTS: Record<string, string> = {
  default: "bg-primary text-primary-foreground",
  secondary: "bg-accent text-foreground",
  outline: "border border-border text-muted-foreground",
};

export function Badge({ className, children, variant = "secondary", ...props }: BadgeProps) {
  return (
    <span className={cn("inline-flex items-center rounded-md px-2 py-0.5 text-xs font-semibold", VARIANTS[variant], className)} {...props}>
      {children}
    </span>
  );
}
