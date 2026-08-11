import * as React from "react";
import * as DropdownMenuPrimitive from "@radix-ui/react-dropdown-menu";
import { Check, ChevronRight, Circle } from "lucide-react";
import { cn } from "@/lib/utils";

const DropdownMenu = DropdownMenuPrimitive.Root;
const DropdownMenuTrigger = DropdownMenuPrimitive.Trigger;
const DropdownMenuGroup = DropdownMenuPrimitive.Group;
const DropdownMenuPortal = DropdownMenuPrimitive.Portal;
const DropdownMenuSub = DropdownMenuPrimitive.Sub;
const DropdownMenuRadioGroup = DropdownMenuPrimitive.RadioGroup;

const surface = [
  "z-[110] min-w-[11rem] overflow-hidden rounded-[var(--radius-md)] p-1",
  "border border-[var(--border)] bg-[var(--surface)] text-[var(--text)]",
  "shadow-[var(--shadow-lg)]",
  "data-[state=open]:animate-in data-[state=open]:fade-in-0 data-[state=open]:zoom-in-95",
  "data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=closed]:zoom-out-95",
  "data-[side=bottom]:slide-in-from-top-1 data-[side=top]:slide-in-from-bottom-1",
  "data-[side=left]:slide-in-from-right-1 data-[side=right]:slide-in-from-left-1",
].join(" ");

const item = [
  "relative flex cursor-pointer select-none items-center gap-2 rounded-[var(--radius-sm)]",
  "px-2 py-1.5 text-[length:var(--fs-sm)] outline-none",
  "transition-colors duration-[var(--dur-instant)]",
  "focus:bg-[var(--surface-2)] focus:text-[var(--text)]",
  "data-[disabled]:pointer-events-none data-[disabled]:opacity-45",
  "[&_svg]:size-4 [&_svg]:shrink-0 [&_svg]:text-[var(--text-soft)]",
].join(" ");

const DropdownMenuSubTrigger = React.forwardRef(function DropdownMenuSubTrigger(
  { className, inset, children, ...props },
  ref
) {
  return (
    <DropdownMenuPrimitive.SubTrigger
      ref={ref}
      className={cn(item, "data-[state=open]:bg-[var(--surface-2)]", inset && "pl-8", className)}
      {...props}
    >
      {children}
      <ChevronRight className="ml-auto" aria-hidden="true" />
    </DropdownMenuPrimitive.SubTrigger>
  );
});

const DropdownMenuSubContent = React.forwardRef(function DropdownMenuSubContent({ className, ...props }, ref) {
  return <DropdownMenuPrimitive.SubContent ref={ref} className={cn(surface, className)} {...props} />;
});

const DropdownMenuContent = React.forwardRef(function DropdownMenuContent(
  { className, sideOffset = 6, collisionPadding = 12, ...props },
  ref
) {
  return (
    <DropdownMenuPrimitive.Portal>
      <DropdownMenuPrimitive.Content
        ref={ref}
        sideOffset={sideOffset}
        collisionPadding={collisionPadding}
        className={cn(surface, "max-h-[min(60dvh,26rem)] overflow-y-auto", className)}
        {...props}
      />
    </DropdownMenuPrimitive.Portal>
  );
});

const DropdownMenuItem = React.forwardRef(function DropdownMenuItem(
  { className, inset, destructive, ...props },
  ref
) {
  return (
    <DropdownMenuPrimitive.Item
      ref={ref}
      className={cn(
        item,
        inset && "pl-8",
        destructive &&
          "text-[var(--destructive)] focus:bg-[var(--rose-soft)] focus:text-[var(--rose-ink)] [&_svg]:text-current",
        className
      )}
      {...props}
    />
  );
});

const DropdownMenuCheckboxItem = React.forwardRef(function DropdownMenuCheckboxItem(
  { className, children, checked, ...props },
  ref
) {
  return (
    <DropdownMenuPrimitive.CheckboxItem
      ref={ref}
      checked={checked}
      className={cn(item, "pl-8", className)}
      {...props}
    >
      <span className="absolute left-2 grid size-4 place-items-center">
        <DropdownMenuPrimitive.ItemIndicator>
          <Check className="size-3.5 !text-[var(--accent)]" aria-hidden="true" />
        </DropdownMenuPrimitive.ItemIndicator>
      </span>
      {children}
    </DropdownMenuPrimitive.CheckboxItem>
  );
});

const DropdownMenuRadioItem = React.forwardRef(function DropdownMenuRadioItem(
  { className, children, ...props },
  ref
) {
  return (
    <DropdownMenuPrimitive.RadioItem ref={ref} className={cn(item, "pl-8", className)} {...props}>
      <span className="absolute left-2 grid size-4 place-items-center">
        <DropdownMenuPrimitive.ItemIndicator>
          <Circle className="size-2 fill-current !text-[var(--accent)]" aria-hidden="true" />
        </DropdownMenuPrimitive.ItemIndicator>
      </span>
      {children}
    </DropdownMenuPrimitive.RadioItem>
  );
});

const DropdownMenuLabel = React.forwardRef(function DropdownMenuLabel({ className, inset, ...props }, ref) {
  return (
    <DropdownMenuPrimitive.Label
      ref={ref}
      className={cn(
        "px-2 py-1.5 text-[length:var(--fs-2xs)] font-semibold uppercase",
        "tracking-[var(--tracking-caps)] text-[var(--text-soft)]",
        inset && "pl-8",
        className
      )}
      {...props}
    />
  );
});

const DropdownMenuSeparator = React.forwardRef(function DropdownMenuSeparator({ className, ...props }, ref) {
  return (
    <DropdownMenuPrimitive.Separator
      ref={ref}
      className={cn("-mx-1 my-1 h-px bg-[var(--border)]", className)}
      {...props}
    />
  );
});

function DropdownMenuShortcut({ className, ...props }) {
  return (
    <span
      className={cn(
        "ml-auto pl-4 text-[length:var(--fs-2xs)] tracking-[var(--tracking-wide)] text-[var(--text-soft)]",
        className
      )}
      {...props}
    />
  );
}

export {
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuCheckboxItem,
  DropdownMenuRadioItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuShortcut,
  DropdownMenuGroup,
  DropdownMenuPortal,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  DropdownMenuRadioGroup,
};
