/**
 * Barrel for the Beacon component kit (shadcn/ui vendored + Beacon additions).
 * Import from "@/ui" in feature code; never reach into a file directly.
 */
export { Button, buttonVariants } from "./button.jsx";
export { Input, InputGroup, inputBase } from "./input.jsx";
export { Textarea } from "./textarea.jsx";
export { Label, Field } from "./label.jsx";
export { Badge, badgeVariants } from "./badge.jsx";
export { Card, CardHeader, CardTitle, CardDescription, CardContent, CardFooter } from "./card.jsx";
export { Separator } from "./separator.jsx";
export { Skeleton, SkeletonTable } from "./skeleton.jsx";
export { Checkbox } from "./checkbox.jsx";
export { Switch } from "./switch.jsx";
export { RadioGroup, RadioGroupItem } from "./radio-group.jsx";
export { Avatar, AvatarImage, AvatarFallback } from "./avatar.jsx";
export { Progress } from "./progress.jsx";
export { ScrollArea, ScrollBar } from "./scroll-area.jsx";
export { Alert, alertVariants } from "./alert.jsx";
export { EmptyState } from "./empty-state.jsx";
export { Kbd } from "./kbd.jsx";
export { Tabs, TabsList, TabsTrigger, TabsContent, TabCount } from "./tabs.jsx";

export {
  Dialog, DialogPortal, DialogOverlay, DialogTrigger, DialogClose, DialogContent,
  DialogHeader, DialogBody, DialogFooter, DialogTitle, DialogDescription,
} from "./dialog.jsx";

export {
  Sheet, SheetPortal, SheetOverlay, SheetTrigger, SheetClose, SheetContent,
  SheetHeader, SheetBody, SheetFooter, SheetTitle, SheetDescription,
} from "./sheet.jsx";

export {
  DropdownMenu, DropdownMenuTrigger, DropdownMenuContent, DropdownMenuItem,
  DropdownMenuCheckboxItem, DropdownMenuRadioItem, DropdownMenuLabel,
  DropdownMenuSeparator, DropdownMenuShortcut, DropdownMenuGroup, DropdownMenuPortal,
  DropdownMenuSub, DropdownMenuSubContent, DropdownMenuSubTrigger, DropdownMenuRadioGroup,
} from "./dropdown-menu.jsx";

export { Popover, PopoverTrigger, PopoverContent, PopoverAnchor, PopoverClose } from "./popover.jsx";
export { Tooltip, TooltipRoot, TooltipTrigger, TooltipContent, TooltipProvider } from "./tooltip.jsx";

export {
  Select, SelectGroup, SelectValue, SelectTrigger, SelectContent, SelectLabel,
  SelectItem, SelectSeparator,
} from "./select.jsx";

export {
  AlertDialog, AlertDialogTrigger, AlertDialogContent, AlertDialogHeader,
  AlertDialogFooter, AlertDialogTitle, AlertDialogDescription, AlertDialogAction,
  AlertDialogCancel,
} from "./alert-dialog.jsx";
