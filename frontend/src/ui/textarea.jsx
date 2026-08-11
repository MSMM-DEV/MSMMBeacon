import * as React from "react";
import { cn } from "@/lib/utils";
import { inputBase } from "./input.jsx";

const Textarea = React.forwardRef(function Textarea({ className, rows = 4, ...props }, ref) {
  return (
    <textarea
      ref={ref}
      rows={rows}
      className={cn(inputBase, "min-h-[72px] py-2 leading-[var(--lh-snug)] resize-y", className)}
      {...props}
    />
  );
});

export { Textarea };
