import * as React from "react";
import { cn } from "@/lib/utils";

/**
 * Surface container.
 *
 * Used for genuinely grouped, self-contained content only. Lists, tables and
 * form sections that already sit on the page canvas do NOT get a card — the
 * page is not a deck of boxes.
 */
const Card = React.forwardRef(function Card({ className, interactive, ...props }, ref) {
  return (
    <div
      ref={ref}
      className={cn(
        "min-w-0 rounded-[var(--radius-lg)] border border-[var(--border)] bg-[var(--surface)]",
        "shadow-[var(--shadow-sm)]",
        interactive &&
          "cursor-pointer transition-[box-shadow,border-color,translate] duration-[var(--dur-fast)] ease-[var(--ease-out)] hover:-translate-y-px hover:border-[var(--border-strong)] hover:shadow-[var(--shadow-md)] focus-visible:outline-none focus-visible:shadow-[var(--focus-ring)]",
        className
      )}
      {...props}
    />
  );
});

const CardHeader = React.forwardRef(function CardHeader({ className, ...props }, ref) {
  return (
    <div
      ref={ref}
      className={cn(
        "flex items-start justify-between gap-3 px-4 pt-3.5 pb-3 border-b border-[var(--border)]",
        className
      )}
      {...props}
    />
  );
});

const CardTitle = React.forwardRef(function CardTitle({ className, as: As = "h3", ...props }, ref) {
  return (
    <As
      ref={ref}
      className={cn(
        "m-0 text-[length:var(--fs-md)] font-semibold tracking-[var(--tracking-snug)] text-[var(--text)]",
        className
      )}
      {...props}
    />
  );
});

const CardDescription = React.forwardRef(function CardDescription({ className, ...props }, ref) {
  return (
    <p
      ref={ref}
      className={cn("m-0 mt-0.5 text-[length:var(--fs-xs)] text-[var(--text-muted)]", className)}
      {...props}
    />
  );
});

const CardContent = React.forwardRef(function CardContent({ className, ...props }, ref) {
  return <div ref={ref} className={cn("min-w-0 p-4", className)} {...props} />;
});

const CardFooter = React.forwardRef(function CardFooter({ className, ...props }, ref) {
  return (
    <div
      ref={ref}
      className={cn(
        "flex items-center gap-2 px-4 py-3 border-t border-[var(--border)] bg-[var(--surface-2)] rounded-b-[var(--radius-lg)]",
        className
      )}
      {...props}
    />
  );
});

export { Card, CardHeader, CardTitle, CardDescription, CardContent, CardFooter };
