import * as React from "react";
import * as DialogPrimitive from "@radix-ui/react-dialog";
import { X } from "lucide-react";
import { cn } from "@/lib/utils";

const Dialog = DialogPrimitive.Root;
const DialogTrigger = DialogPrimitive.Trigger;
const DialogClose = DialogPrimitive.Close;
const DialogPortal = DialogPrimitive.Portal;

const DialogOverlay = React.forwardRef(function DialogOverlay({ className, ...props }, ref) {
  return (
    <DialogPrimitive.Overlay
      ref={ref}
      className={cn(
        "fixed inset-0 z-[100] bg-[var(--scrim)] backdrop-blur-[3px]",
        "data-[state=open]:animate-in data-[state=open]:fade-in-0",
        "data-[state=closed]:animate-out data-[state=closed]:fade-out-0",
        className
      )}
      {...props}
    />
  );
});

/**
 * Modal shell.
 *
 * Sized with dvh + an internal scroll region so a tall form never runs off
 * a phone screen or under the iOS keyboard; the header and footer stay
 * pinned while the body scrolls.
 */
const DialogContent = React.forwardRef(function DialogContent(
  { className, children, size = "md", showClose = true, ...props },
  ref
) {
  const width = {
    sm: "sm:max-w-[420px]",
    md: "sm:max-w-[560px]",
    lg: "sm:max-w-[760px]",
    xl: "sm:max-w-[1000px]",
    full: "sm:max-w-[min(1280px,calc(100vw-48px))]",
  }[size];

  return (
    <DialogPortal>
      <DialogOverlay />
      <DialogPrimitive.Content
        ref={ref}
        className={cn(
          "fixed z-[101] flex flex-col overflow-hidden",
          "border border-[var(--border)] bg-[var(--surface)] text-[var(--text)]",
          "shadow-[var(--shadow-xl)]",
          // Phone: bottom sheet pinned to the bottom edge.
          "inset-x-0 bottom-0 max-h-[92dvh] rounded-t-[var(--radius-xl)]",
          "data-[state=open]:animate-in data-[state=open]:slide-in-from-bottom-4 data-[state=open]:fade-in-0",
          "data-[state=closed]:animate-out data-[state=closed]:slide-out-to-bottom-4 data-[state=closed]:fade-out-0",
          // Tablet and up: centred dialog.
          "sm:inset-x-auto sm:bottom-auto sm:left-1/2 sm:top-1/2 sm:w-[calc(100vw-48px)]",
          "sm:max-h-[min(88dvh,880px)] sm:-translate-x-1/2 sm:-translate-y-1/2",
          "sm:rounded-[var(--radius-xl)]",
          "sm:data-[state=open]:zoom-in-95 sm:data-[state=closed]:zoom-out-95",
          "sm:data-[state=open]:slide-in-from-bottom-0 sm:data-[state=closed]:slide-out-to-bottom-0",
          "duration-[var(--dur-normal)]",
          width,
          className
        )}
        {...props}
      >
        {children}
        {showClose ? (
          <DialogPrimitive.Close
            className={cn(
              "absolute right-3 top-3 grid size-8 place-items-center rounded-[var(--radius-sm)]",
              "text-[var(--text-soft)] transition-colors duration-[var(--dur-fast)]",
              "hover:bg-[var(--surface-2)] hover:text-[var(--text)]",
              "focus-visible:outline-none focus-visible:shadow-[var(--focus-ring)]"
            )}
          >
            <X className="size-4" aria-hidden="true" />
            <span className="sr-only">Close</span>
          </DialogPrimitive.Close>
        ) : null}
      </DialogPrimitive.Content>
    </DialogPortal>
  );
});

function DialogHeader({ className, ...props }) {
  return (
    <div
      className={cn(
        "flex shrink-0 flex-col gap-1 border-b border-[var(--border)]",
        "px-5 pb-3.5 pt-4 pr-12",
        className
      )}
      {...props}
    />
  );
}

/** Scrolling body. Always the only scroll container inside a dialog. */
function DialogBody({ className, ...props }) {
  return (
    <div
      className={cn("min-h-0 flex-1 overflow-y-auto overflow-x-hidden px-5 py-4", className)}
      {...props}
    />
  );
}

function DialogFooter({ className, ...props }) {
  return (
    <div
      className={cn(
        "flex shrink-0 flex-col-reverse gap-2 border-t border-[var(--border)] bg-[var(--surface-2)]",
        "px-5 py-3 pb-[max(12px,env(safe-area-inset-bottom))]",
        "sm:flex-row sm:items-center sm:justify-end",
        className
      )}
      {...props}
    />
  );
}

const DialogTitle = React.forwardRef(function DialogTitle({ className, ...props }, ref) {
  return (
    <DialogPrimitive.Title
      ref={ref}
      className={cn(
        "m-0 font-[family-name:var(--font-display)] text-[length:var(--fs-lg)] font-semibold",
        "leading-[var(--lh-tight)] tracking-[var(--tracking-tight)] text-[var(--text)]",
        className
      )}
      {...props}
    />
  );
});

const DialogDescription = React.forwardRef(function DialogDescription({ className, ...props }, ref) {
  return (
    <DialogPrimitive.Description
      ref={ref}
      className={cn("m-0 text-[length:var(--fs-sm)] text-[var(--text-muted)]", className)}
      {...props}
    />
  );
});

export {
  Dialog,
  DialogPortal,
  DialogOverlay,
  DialogTrigger,
  DialogClose,
  DialogContent,
  DialogHeader,
  DialogBody,
  DialogFooter,
  DialogTitle,
  DialogDescription,
};
