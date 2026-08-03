import * as React from "react";
import * as DialogPrimitive from "@radix-ui/react-dialog";
import { cva } from "class-variance-authority";
import { X } from "lucide-react";
import { cn } from "@/lib/utils";

/** Edge-anchored panel. Used for the mobile nav drawer and record drawers. */
const Sheet = DialogPrimitive.Root;
const SheetTrigger = DialogPrimitive.Trigger;
const SheetClose = DialogPrimitive.Close;
const SheetPortal = DialogPrimitive.Portal;

const SheetOverlay = React.forwardRef(function SheetOverlay({ className, ...props }, ref) {
  return (
    <DialogPrimitive.Overlay
      ref={ref}
      className={cn(
        "fixed inset-0 z-[100] bg-[var(--scrim)] backdrop-blur-[2px]",
        "data-[state=open]:animate-in data-[state=open]:fade-in-0",
        "data-[state=closed]:animate-out data-[state=closed]:fade-out-0",
        className
      )}
      {...props}
    />
  );
});

const sheetVariants = cva(
  [
    "fixed z-[101] flex flex-col gap-0 overflow-hidden",
    "bg-[var(--surface)] text-[var(--text)] shadow-[var(--shadow-xl)]",
    "transition ease-[var(--ease-out)] duration-[var(--dur-normal)]",
    "data-[state=open]:animate-in data-[state=closed]:animate-out",
  ].join(" "),
  {
    variants: {
      side: {
        top: "inset-x-0 top-0 max-h-[85dvh] border-b border-[var(--border)] data-[state=open]:slide-in-from-top data-[state=closed]:slide-out-to-top",
        bottom:
          "inset-x-0 bottom-0 max-h-[85dvh] rounded-t-[var(--radius-xl)] border-t border-[var(--border)] pb-[env(safe-area-inset-bottom)] data-[state=open]:slide-in-from-bottom data-[state=closed]:slide-out-to-bottom",
        left: "inset-y-0 left-0 h-dvh w-[min(88vw,340px)] border-r border-[var(--border)] data-[state=open]:slide-in-from-left data-[state=closed]:slide-out-to-left",
        right:
          "inset-y-0 right-0 h-dvh w-[min(94vw,620px)] border-l border-[var(--border)] data-[state=open]:slide-in-from-right data-[state=closed]:slide-out-to-right",
      },
    },
    defaultVariants: { side: "right" },
  }
);

const SheetContent = React.forwardRef(function SheetContent(
  { className, children, side = "right", showClose = true, ...props },
  ref
) {
  return (
    <SheetPortal>
      <SheetOverlay />
      <DialogPrimitive.Content ref={ref} className={cn(sheetVariants({ side }), className)} {...props}>
        {children}
        {showClose ? (
          <DialogPrimitive.Close
            className={cn(
              "absolute right-3 top-3 grid size-8 place-items-center rounded-[var(--radius-sm)]",
              "text-[var(--text-soft)] transition-colors hover:bg-[var(--surface-2)] hover:text-[var(--text)]",
              "focus-visible:outline-none focus-visible:shadow-[var(--focus-ring)]"
            )}
          >
            <X className="size-4" aria-hidden="true" />
            <span className="sr-only">Close</span>
          </DialogPrimitive.Close>
        ) : null}
      </DialogPrimitive.Content>
    </SheetPortal>
  );
});

function SheetHeader({ className, ...props }) {
  return (
    <div
      className={cn(
        "flex shrink-0 flex-col gap-1 border-b border-[var(--border)] px-5 pb-3.5 pt-4 pr-12",
        className
      )}
      {...props}
    />
  );
}

function SheetBody({ className, ...props }) {
  return <div className={cn("min-h-0 flex-1 overflow-y-auto px-5 py-4", className)} {...props} />;
}

function SheetFooter({ className, ...props }) {
  return (
    <div
      className={cn(
        "flex shrink-0 items-center justify-end gap-2 border-t border-[var(--border)]",
        "bg-[var(--surface-2)] px-5 py-3",
        className
      )}
      {...props}
    />
  );
}

const SheetTitle = React.forwardRef(function SheetTitle({ className, ...props }, ref) {
  return (
    <DialogPrimitive.Title
      ref={ref}
      className={cn(
        "m-0 font-[family-name:var(--font-display)] text-[length:var(--fs-lg)] font-semibold",
        "tracking-[var(--tracking-tight)] text-[var(--text)]",
        className
      )}
      {...props}
    />
  );
});

const SheetDescription = React.forwardRef(function SheetDescription({ className, ...props }, ref) {
  return (
    <DialogPrimitive.Description
      ref={ref}
      className={cn("m-0 text-[length:var(--fs-sm)] text-[var(--text-muted)]", className)}
      {...props}
    />
  );
});

export {
  Sheet,
  SheetPortal,
  SheetOverlay,
  SheetTrigger,
  SheetClose,
  SheetContent,
  SheetHeader,
  SheetBody,
  SheetFooter,
  SheetTitle,
  SheetDescription,
};
