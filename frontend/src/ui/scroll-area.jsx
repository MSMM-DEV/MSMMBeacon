import * as React from "react";
import * as ScrollAreaPrimitive from "@radix-ui/react-scroll-area";
import { cn } from "@/lib/utils";

const ScrollArea = React.forwardRef(function ScrollArea(
  { className, children, viewportClassName, orientation = "vertical", ...props },
  ref
) {
  return (
    <ScrollAreaPrimitive.Root
      ref={ref}
      className={cn("relative min-w-0 overflow-hidden", className)}
      scrollHideDelay={400}
      {...props}
    >
      <ScrollAreaPrimitive.Viewport
        className={cn("size-full min-w-0 rounded-[inherit] [&>div]:!min-w-0", viewportClassName)}
      >
        {children}
      </ScrollAreaPrimitive.Viewport>
      <ScrollBar orientation="vertical" />
      {orientation === "both" || orientation === "horizontal" ? (
        <ScrollBar orientation="horizontal" />
      ) : null}
      <ScrollAreaPrimitive.Corner />
    </ScrollAreaPrimitive.Root>
  );
});

const ScrollBar = React.forwardRef(function ScrollBar(
  { className, orientation = "vertical", ...props },
  ref
) {
  return (
    <ScrollAreaPrimitive.ScrollAreaScrollbar
      ref={ref}
      orientation={orientation}
      className={cn(
        "flex touch-none select-none p-0.5 transition-opacity duration-[var(--dur-normal)]",
        "data-[state=hidden]:opacity-0",
        orientation === "vertical" && "h-full w-2.5 border-l border-l-transparent",
        orientation === "horizontal" && "h-2.5 flex-col border-t border-t-transparent",
        className
      )}
      {...props}
    >
      <ScrollAreaPrimitive.ScrollAreaThumb className="relative flex-1 rounded-full bg-[var(--border-strong)]" />
    </ScrollAreaPrimitive.ScrollAreaScrollbar>
  );
});

export { ScrollArea, ScrollBar };
