import * as React from "react";
import { cva } from "class-variance-authority";
import { cn } from "@/lib/utils";

/**
 * Status badge. Soft tinted fill + hairline border rather than a saturated
 * pill, so a table with forty of them still reads as a table.
 */
const badgeVariants = cva(
  [
    "inline-flex items-center gap-1.5 shrink-0 whitespace-nowrap align-middle",
    "rounded-[var(--radius-full)] border",
    "px-2 py-[2px] text-[length:var(--fs-2xs)] font-semibold",
    "tracking-[var(--tracking-snug)]",
    "[&_svg]:size-3 [&_svg]:shrink-0",
  ].join(" "),
  {
    variants: {
      tone: {
        neutral: "bg-[var(--surface-2)] border-[var(--border)] text-[var(--text-muted)]",
        brand:   "bg-[var(--accent-soft)] border-[var(--accent-line)] text-[var(--accent-ink)]",
        success: "bg-[var(--sage-soft)] border-[var(--sage-line)] text-[var(--sage-ink)]",
        danger:  "bg-[var(--rose-soft)] border-[var(--rose-line)] text-[var(--rose-ink)]",
        info:    "bg-[var(--blue-soft)] border-[var(--blue-line)] text-[var(--blue-ink)]",
        solid:   "bg-[var(--accent-solid)] border-transparent text-[var(--accent-on)]",
        outline: "bg-transparent border-[var(--border-strong)] text-[var(--text-muted)]",
      },
      size: {
        sm: "px-1.5 py-0 text-[length:var(--fs-2xs)]",
        md: "px-2 py-[2px]",
      },
    },
    defaultVariants: { tone: "neutral", size: "md" },
  }
);

const Badge = React.forwardRef(function Badge({ className, tone, size, dot, ...props }, ref) {
  return (
    <span ref={ref} className={cn(badgeVariants({ tone, size }), className)} {...props}>
      {dot ? (
        <span
          aria-hidden="true"
          className="size-[6px] shrink-0 rounded-full bg-current opacity-80"
        />
      ) : null}
      {props.children}
    </span>
  );
});

export { Badge, badgeVariants };
