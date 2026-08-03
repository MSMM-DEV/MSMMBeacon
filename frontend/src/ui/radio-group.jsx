import * as React from "react";
import * as RadioGroupPrimitive from "@radix-ui/react-radio-group";
import { cn } from "@/lib/utils";

const RadioGroup = React.forwardRef(function RadioGroup({ className, ...props }, ref) {
  return <RadioGroupPrimitive.Root ref={ref} className={cn("grid gap-2", className)} {...props} />;
});

const RadioGroupItem = React.forwardRef(function RadioGroupItem({ className, ...props }, ref) {
  return (
    <RadioGroupPrimitive.Item
      ref={ref}
      className={cn(
        "grid size-4 shrink-0 place-items-center rounded-full border border-[var(--border-strong)]",
        "bg-[var(--surface)] transition-colors duration-[var(--dur-fast)]",
        "hover:border-[var(--accent)]",
        "focus-visible:outline-none focus-visible:shadow-[var(--focus-ring)]",
        "disabled:cursor-not-allowed disabled:opacity-45",
        "data-[state=checked]:border-[var(--accent-solid)]",
        className
      )}
      {...props}
    >
      <RadioGroupPrimitive.Indicator className="block size-[7px] rounded-full bg-[var(--accent-solid)]" />
    </RadioGroupPrimitive.Item>
  );
});

export { RadioGroup, RadioGroupItem };
