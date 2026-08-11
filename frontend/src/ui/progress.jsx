import * as React from "react";
import * as ProgressPrimitive from "@radix-ui/react-progress";
import { cn } from "@/lib/utils";

const tones = {
  brand: "bg-[var(--accent-solid)]",
  success: "bg-[var(--success)]",
  danger: "bg-[var(--destructive)]",
  info: "bg-[var(--info)]",
  neutral: "bg-[var(--n-400)]",
};

const Progress = React.forwardRef(function Progress(
  { className, value = 0, tone = "brand", ...props },
  ref
) {
  const pct = Math.max(0, Math.min(100, Number(value) || 0));
  return (
    <ProgressPrimitive.Root
      ref={ref}
      value={pct}
      className={cn(
        "relative h-1.5 w-full min-w-0 overflow-hidden rounded-full bg-[var(--surface-3)]",
        className
      )}
      {...props}
    >
      <ProgressPrimitive.Indicator
        className={cn(
          "h-full w-full rounded-full transition-transform duration-[var(--dur-slow)] ease-[var(--ease-out)]",
          tones[tone] || tones.brand
        )}
        style={{ transform: `translateX(-${100 - pct}%)` }}
      />
    </ProgressPrimitive.Root>
  );
});

export { Progress };
