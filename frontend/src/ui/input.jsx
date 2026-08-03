import * as React from "react";
import { cn } from "@/lib/utils";

const inputBase = [
  "flex w-full min-w-0 rounded-[var(--radius-sm)]",
  "border border-[var(--input)] bg-[var(--surface)] text-[var(--text)]",
  "px-2.5 text-[length:var(--fs-sm)]",
  "shadow-[var(--shadow-xs)]",
  "placeholder:text-[var(--text-soft)]",
  "transition-[border-color,box-shadow,background-color] duration-[var(--dur-fast)] ease-[var(--ease-out)]",
  "hover:border-[var(--border-strong)]",
  "focus-visible:outline-none focus-visible:border-[var(--ring)] focus-visible:shadow-[var(--focus-ring)]",
  "disabled:cursor-not-allowed disabled:opacity-55 disabled:bg-[var(--surface-2)]",
  "aria-[invalid=true]:border-[var(--destructive)] aria-[invalid=true]:focus-visible:shadow-[0_0_0_2px_var(--bg),0_0_0_4px_var(--destructive)]",
  "file:border-0 file:bg-transparent file:text-[length:var(--fs-sm)] file:font-medium file:text-[var(--text)]",
].join(" ");

const Input = React.forwardRef(function Input({ className, type = "text", ...props }, ref) {
  return (
    <input
      ref={ref}
      type={type}
      className={cn(inputBase, "h-[var(--control-h)]", className)}
      {...props}
    />
  );
});

/** Input with a leading (and optional trailing) adornment slot. */
const InputGroup = React.forwardRef(function InputGroup(
  { className, leading, trailing, inputClassName, ...props },
  ref
) {
  return (
    <div className={cn("relative flex w-full min-w-0 items-center", className)}>
      {leading ? (
        <span className="pointer-events-none absolute left-2.5 grid place-items-center text-[var(--text-soft)] [&_svg]:size-4">
          {leading}
        </span>
      ) : null}
      <input
        ref={ref}
        className={cn(
          inputBase,
          "h-[var(--control-h)]",
          leading && "pl-8",
          trailing && "pr-8",
          inputClassName
        )}
        {...props}
      />
      {trailing ? (
        <span className="absolute right-2 grid place-items-center text-[var(--text-soft)] [&_svg]:size-4">
          {trailing}
        </span>
      ) : null}
    </div>
  );
});

export { Input, InputGroup, inputBase };
