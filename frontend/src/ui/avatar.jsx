import * as React from "react";
import * as AvatarPrimitive from "@radix-ui/react-avatar";
import { cn } from "@/lib/utils";

const sizes = {
  xs: "size-5 text-[9.5px]",
  sm: "size-6 text-[10.5px]",
  md: "size-8 text-[12px]",
  lg: "size-10 text-[14px]",
};

const Avatar = React.forwardRef(function Avatar({ className, size = "sm", ...props }, ref) {
  return (
    <AvatarPrimitive.Root
      ref={ref}
      className={cn(
        "relative grid shrink-0 place-items-center overflow-hidden rounded-full",
        "font-semibold uppercase tracking-[var(--tracking-wide)] select-none",
        "ring-1 ring-inset ring-black/[.06] dark:ring-white/[.08]",
        sizes[size] || sizes.sm,
        className
      )}
      {...props}
    />
  );
});

const AvatarImage = React.forwardRef(function AvatarImage({ className, ...props }, ref) {
  return (
    <AvatarPrimitive.Image ref={ref} className={cn("size-full object-cover", className)} {...props} />
  );
});

const AvatarFallback = React.forwardRef(function AvatarFallback({ className, ...props }, ref) {
  return (
    <AvatarPrimitive.Fallback
      ref={ref}
      className={cn(
        "grid size-full place-items-center bg-[var(--surface-3)] text-[var(--text-muted)]",
        className
      )}
      {...props}
    />
  );
});

export { Avatar, AvatarImage, AvatarFallback };
