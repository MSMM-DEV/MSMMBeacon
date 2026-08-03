import * as React from "react";
import * as TabsPrimitive from "@radix-ui/react-tabs";
import { cn } from "@/lib/utils";

const Tabs = TabsPrimitive.Root;

/**
 * Two visual treatments:
 *  • `underline` (default) — a rule under a horizontally scrollable strip.
 *    Correct for page-level section switching; scales to any number of tabs.
 *  • `segmented` — an enclosed control. Correct for 2–4 mutually exclusive
 *    view modes sitting inside a toolbar.
 */
const TabsList = React.forwardRef(function TabsList({ className, variant = "underline", ...props }, ref) {
  return (
    <TabsPrimitive.List
      ref={ref}
      className={cn(
        "flex min-w-0 items-center",
        variant === "underline" &&
          "gap-1 overflow-x-auto border-b border-[var(--border)] [scrollbar-width:none] [&::-webkit-scrollbar]:hidden",
        variant === "segmented" &&
          "gap-0.5 rounded-[var(--radius)] border border-[var(--border)] bg-[var(--surface-2)] p-0.5",
        className
      )}
      data-variant={variant}
      {...props}
    />
  );
});

const TabsTrigger = React.forwardRef(function TabsTrigger({ className, ...props }, ref) {
  return (
    <TabsPrimitive.Trigger
      ref={ref}
      className={cn(
        "group inline-flex shrink-0 items-center justify-center gap-1.5 whitespace-nowrap",
        "text-[length:var(--fs-sm)] font-medium text-[var(--text-muted)]",
        "transition-[color,background-color,border-color] duration-[var(--dur-fast)] ease-[var(--ease-out)]",
        "focus-visible:outline-none focus-visible:shadow-[var(--focus-ring)]",
        "disabled:pointer-events-none disabled:opacity-45",
        "[&_svg]:size-4 [&_svg]:shrink-0",
        // underline
        "group-data-[variant=underline]/list:h-9",
        "[[data-variant=underline]>&]:h-9 [[data-variant=underline]>&]:rounded-t-[var(--radius-sm)]",
        "[[data-variant=underline]>&]:border-b-2 [[data-variant=underline]>&]:border-transparent",
        "[[data-variant=underline]>&]:px-3 [[data-variant=underline]>&]:-mb-px",
        "[[data-variant=underline]>&:hover]:text-[var(--text)]",
        "[[data-variant=underline]>&[data-state=checked]]:text-[var(--text)]",
        "[[data-variant=underline]>&[data-state=active]]:border-[var(--accent)]",
        "[[data-variant=underline]>&[data-state=active]]:text-[var(--text)]",
        // segmented
        "[[data-variant=segmented]>&]:h-[calc(var(--control-h)-6px)]",
        "[[data-variant=segmented]>&]:rounded-[calc(var(--radius)-3px)]",
        "[[data-variant=segmented]>&]:px-3",
        "[[data-variant=segmented]>&:hover]:text-[var(--text)]",
        "[[data-variant=segmented]>&[data-state=active]]:bg-[var(--surface)]",
        "[[data-variant=segmented]>&[data-state=active]]:text-[var(--text)]",
        "[[data-variant=segmented]>&[data-state=active]]:shadow-[var(--shadow-xs)]",
        className
      )}
      {...props}
    />
  );
});

const TabsContent = React.forwardRef(function TabsContent({ className, ...props }, ref) {
  return (
    <TabsPrimitive.Content
      ref={ref}
      className={cn(
        "min-w-0 focus-visible:outline-none",
        "data-[state=active]:animate-in data-[state=active]:fade-in-0",
        className
      )}
      {...props}
    />
  );
});

/** Count pill for a tab trigger. */
function TabCount({ children, className }) {
  return (
    <span
      className={cn(
        "ml-0.5 rounded-[var(--radius-full)] bg-[var(--surface-3)] px-1.5",
        "text-[length:var(--fs-2xs)] font-semibold tabular-nums text-[var(--text-muted)]",
        "group-data-[state=active]:bg-[var(--accent-soft)] group-data-[state=active]:text-[var(--accent-ink)]",
        className
      )}
    >
      {children}
    </span>
  );
}

export { Tabs, TabsList, TabsTrigger, TabsContent, TabCount };
