import * as React from "react";
import * as TooltipPrimitive from "@radix-ui/react-tooltip";
import { cn } from "@/lib/utils";

const TooltipProvider = TooltipPrimitive.Provider;
const TooltipRoot = TooltipPrimitive.Root;
const TooltipTrigger = TooltipPrimitive.Trigger;

const TooltipContent = React.forwardRef(function TooltipContent(
  { className, sideOffset = 6, ...props },
  ref
) {
  return (
    <TooltipPrimitive.Portal>
      <TooltipPrimitive.Content
        ref={ref}
        sideOffset={sideOffset}
        collisionPadding={10}
        className={cn(
          "z-[120] max-w-[260px] rounded-[var(--radius-sm)] px-2 py-1",
          "bg-[var(--n-900)] text-[var(--n-25)] dark:bg-[var(--n-100)] dark:text-[var(--n-900)]",
          "text-[length:var(--fs-xs)] font-medium leading-[var(--lh-snug)]",
          "shadow-[var(--shadow-lg)]",
          "data-[state=delayed-open]:animate-in data-[state=delayed-open]:fade-in-0 data-[state=delayed-open]:zoom-in-95",
          "data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=closed]:zoom-out-95",
          className
        )}
        {...props}
      />
    </TooltipPrimitive.Portal>
  );
});

/**
 * Convenience wrapper — the 95% case.
 * Renders nothing extra when `label` is empty, so callers can pass a
 * conditional label without branching.
 */
function Tooltip({ label, children, side = "top", align = "center", delay = 250, ...props }) {
  if (!label) return children;
  return (
    <TooltipRoot delayDuration={delay} {...props}>
      <TooltipTrigger asChild>{children}</TooltipTrigger>
      <TooltipContent side={side} align={align}>
        {label}
      </TooltipContent>
    </TooltipRoot>
  );
}

export { Tooltip, TooltipRoot, TooltipTrigger, TooltipContent, TooltipProvider };
