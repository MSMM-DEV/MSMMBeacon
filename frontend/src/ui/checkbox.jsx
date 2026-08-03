import * as React from "react";
import * as CheckboxPrimitive from "@radix-ui/react-checkbox";
import { Check, Minus } from "lucide-react";
import { cn } from "@/lib/utils";

const Checkbox = React.forwardRef(function Checkbox({ className, ...props }, ref) {
  return (
    <CheckboxPrimitive.Root
      ref={ref}
      className={cn(
        "peer grid size-4 shrink-0 place-items-center rounded-[var(--radius-xs)]",
        "border border-[var(--border-strong)] bg-[var(--surface)]",
        "transition-[background-color,border-color,box-shadow] duration-[var(--dur-fast)] ease-[var(--ease-out)]",
        "hover:border-[var(--accent)]",
        "focus-visible:outline-none focus-visible:shadow-[var(--focus-ring)]",
        "disabled:cursor-not-allowed disabled:opacity-45",
        "data-[state=checked]:border-[var(--accent-solid)] data-[state=checked]:bg-[var(--accent-solid)]",
        "data-[state=checked]:text-[var(--accent-on)]",
        "data-[state=indeterminate]:border-[var(--accent-solid)] data-[state=indeterminate]:bg-[var(--accent-solid)]",
        "data-[state=indeterminate]:text-[var(--accent-on)]",
        className
      )}
      {...props}
    >
      <CheckboxPrimitive.Indicator className="grid place-items-center text-current">
        {props.checked === "indeterminate" ? (
          <Minus className="size-3" strokeWidth={3} aria-hidden="true" />
        ) : (
          <Check className="size-3" strokeWidth={3.2} aria-hidden="true" />
        )}
      </CheckboxPrimitive.Indicator>
    </CheckboxPrimitive.Root>
  );
});

export { Checkbox };
