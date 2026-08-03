import * as React from "react";
import { Slot } from "@radix-ui/react-slot";
import { cva } from "class-variance-authority";
import { Loader2 } from "lucide-react";
import { cn } from "@/lib/utils";

/**
 * Beacon button.
 *
 * Deviates from stock shadcn in three deliberate ways:
 *  • surfaces are token-driven (warm palette) rather than slate;
 *  • the resting state carries a 1px inset highlight so solid buttons read
 *    as physical objects against the paper canvas instead of flat swatches;
 *  • `:active` translates 1px down — the whole app shares this press feel.
 */
const buttonVariants = cva(
  [
    "inline-flex items-center justify-center gap-1.5 shrink-0 whitespace-nowrap",
    "font-medium select-none",
    "rounded-[var(--radius-sm)]",
    "transition-[background-color,border-color,color,box-shadow,translate] duration-[var(--dur-fast)] ease-[var(--ease-out)]",
    "focus-visible:outline-none focus-visible:shadow-[var(--focus-ring)]",
    "disabled:pointer-events-none disabled:opacity-45",
    "active:translate-y-px",
    "[&_svg]:pointer-events-none [&_svg]:shrink-0",
  ].join(" "),
  {
    variants: {
      variant: {
        primary:
          "bg-[var(--accent-solid)] text-[var(--accent-on)] shadow-[var(--shadow-xs),inset_0_1px_0_rgba(255,255,255,.18)] hover:bg-[var(--accent-hover)]",
        default:
          "bg-[var(--surface)] text-[var(--text)] border border-[var(--border-strong)] shadow-[var(--shadow-xs)] hover:bg-[var(--surface-2)] hover:border-[var(--border-strong)]",
        subtle:
          "bg-[var(--surface-2)] text-[var(--text)] hover:bg-[var(--surface-3)]",
        outline:
          "bg-transparent text-[var(--text)] border border-[var(--border-strong)] hover:bg-[var(--surface-2)]",
        ghost:
          "bg-transparent text-[var(--text-muted)] hover:bg-[var(--surface-2)] hover:text-[var(--text)]",
        destructive:
          "bg-[var(--destructive)] text-[var(--destructive-foreground)] shadow-[var(--shadow-xs),inset_0_1px_0_rgba(255,255,255,.16)] hover:brightness-[1.06]",
        "destructive-soft":
          "bg-[var(--rose-soft)] text-[var(--rose-ink)] border border-[var(--rose-line)] hover:brightness-[.97]",
        success:
          "bg-[var(--success)] text-[var(--success-foreground)] shadow-[var(--shadow-xs),inset_0_1px_0_rgba(255,255,255,.16)] hover:brightness-[1.06]",
        link:
          "bg-transparent text-[var(--accent)] underline-offset-4 hover:underline p-0 h-auto",
      },
      size: {
        // NOTE the `length:` hint. Without it Tailwind reads `text-[var(--x)]`
        // as a COLOUR utility, which both emits an invalid `color` declaration
        // and makes tailwind-merge drop the variant's real text colour.
        xs: "h-[var(--control-h-sm)] px-2 text-[length:var(--fs-xs)] [&_svg]:size-3.5",
        sm: "h-[calc(var(--control-h)-2px)] px-2.5 text-[length:var(--fs-sm)] [&_svg]:size-4",
        md: "h-[var(--control-h)] px-3.5 text-[length:var(--fs-sm)] [&_svg]:size-4",
        lg: "h-[var(--control-h-lg)] px-5 text-[length:var(--fs-md)] [&_svg]:size-[18px]",
        icon: "h-[var(--control-h)] w-[var(--control-h)] p-0 [&_svg]:size-4",
        "icon-sm": "h-[var(--control-h-sm)] w-[var(--control-h-sm)] p-0 [&_svg]:size-3.5",
        "icon-lg": "h-[var(--control-h-lg)] w-[var(--control-h-lg)] p-0 [&_svg]:size-[18px]",
      },
      block: { true: "w-full", false: "" },
    },
    defaultVariants: { variant: "default", size: "md", block: false },
  }
);

const Button = React.forwardRef(function Button(
  { className, variant, size, block, asChild = false, loading = false, children, disabled, ...props },
  ref
) {
  const Comp = asChild ? Slot : "button";
  return (
    <Comp
      ref={ref}
      type={asChild ? undefined : props.type || "button"}
      className={cn(buttonVariants({ variant, size, block }), className)}
      disabled={asChild ? undefined : disabled || loading}
      aria-busy={loading || undefined}
      data-loading={loading || undefined}
      {...props}
    >
      {loading ? (
        <>
          <Loader2 className="animate-spin" aria-hidden="true" />
          {children}
        </>
      ) : (
        children
      )}
    </Comp>
  );
});

export { Button, buttonVariants };
