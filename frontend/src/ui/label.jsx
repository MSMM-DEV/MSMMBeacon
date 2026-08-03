import * as React from "react";
import * as LabelPrimitive from "@radix-ui/react-label";
import { cn } from "@/lib/utils";

const Label = React.forwardRef(function Label({ className, required, children, ...props }, ref) {
  return (
    <LabelPrimitive.Root
      ref={ref}
      className={cn(
        "flex items-center gap-1 text-[length:var(--fs-xs)] font-semibold uppercase tracking-[var(--tracking-caps)]",
        "text-[var(--text-soft)] select-none",
        "peer-disabled:cursor-not-allowed peer-disabled:opacity-60",
        className
      )}
      {...props}
    >
      {children}
      {required ? (
        <span className="text-[var(--destructive)]" aria-hidden="true">
          *
        </span>
      ) : null}
    </LabelPrimitive.Root>
  );
});

/** Label + control + hint/error, vertically stacked. */
function Field({ label, htmlFor, required, hint, error, children, className }) {
  return (
    <div className={cn("flex min-w-0 flex-col gap-1.5", className)}>
      {label ? (
        <Label htmlFor={htmlFor} required={required}>
          {label}
        </Label>
      ) : null}
      {children}
      {error ? (
        <p className="text-[length:var(--fs-xs)] text-[var(--destructive)]">{error}</p>
      ) : hint ? (
        <p className="text-[length:var(--fs-xs)] text-[var(--text-soft)]">{hint}</p>
      ) : null}
    </div>
  );
}

export { Label, Field };
