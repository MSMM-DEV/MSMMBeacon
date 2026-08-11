import * as React from "react";
import { cn } from "@/lib/utils";

function Skeleton({ className, ...props }) {
  return <div aria-hidden="true" className={cn("bx-skeleton h-4 w-full", className)} {...props} />;
}

/** Placeholder for a data table while rows are loading. */
function SkeletonTable({ rows = 6, cols = 5, className }) {
  return (
    <div className={cn("min-w-0 overflow-hidden rounded-[var(--radius-lg)] border border-[var(--border)]", className)}>
      <div className="flex gap-4 border-b border-[var(--border)] bg-[var(--surface-2)] px-4 py-2.5">
        {Array.from({ length: cols }).map((_, i) => (
          <Skeleton key={i} className="h-3 flex-1" />
        ))}
      </div>
      {Array.from({ length: rows }).map((_, r) => (
        <div key={r} className="flex gap-4 border-b border-[var(--border)] px-4 py-3 last:border-0">
          {Array.from({ length: cols }).map((_, c) => (
            <Skeleton
              key={c}
              className="h-3.5 flex-1"
              style={{ opacity: 1 - r * 0.09, maxWidth: c === 0 ? "22%" : undefined }}
            />
          ))}
        </div>
      ))}
    </div>
  );
}

export { Skeleton, SkeletonTable };
