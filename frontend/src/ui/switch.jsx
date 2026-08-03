import * as React from "react";
import * as SwitchPrimitive from "@radix-ui/react-switch";
import { cn } from "@/lib/utils";

const Switch = React.forwardRef(function Switch({ className, ...props }, ref) {
  return (
    <SwitchPrimitive.Root
      ref={ref}
      className={cn(
        "peer inline-flex h-[20px] w-[34px] shrink-0 cursor-pointer items-center rounded-full",
        "border border-transparent p-[2px]",
        "bg-[var(--n-300)] dark:bg-[var(--n-700)]",
        "transition-colors duration-[var(--dur-fast)] ease-[var(--ease-out)]",
        "focus-visible:outline-none focus-visible:shadow-[var(--focus-ring)]",
        "disabled:cursor-not-allowed disabled:opacity-45",
        "data-[state=checked]:bg-[var(--accent-solid)]",
        className
      )}
      {...props}
    >
      <SwitchPrimitive.Thumb
        className={cn(
          "pointer-events-none block size-[14px] rounded-full bg-white shadow-[var(--shadow-xs)]",
          "transition-transform duration-[var(--dur-fast)] ease-[var(--ease-spring)]",
          "data-[state=checked]:translate-x-[14px] data-[state=unchecked]:translate-x-0"
        )}
      />
    </SwitchPrimitive.Root>
  );
});

export { Switch };
