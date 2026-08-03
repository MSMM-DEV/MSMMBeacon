import * as React from "react";
import { cn } from "@/lib/utils";

function Kbd({ className, ...props }) {
  return (
    <kbd
      className={cn(
        "inline-flex h-[19px] min-w-[19px] items-center justify-center gap-0.5 rounded-[var(--radius-xs)]",
        "border border-[var(--border)] border-b-[var(--border-strong)] bg-[var(--surface-2)] px-1.5",
        "font-[family-name:var(--font-mono)] text-[10px] font-medium text-[var(--text-soft)]",
        className
      )}
      {...props}
    />
  );
}

export { Kbd };
