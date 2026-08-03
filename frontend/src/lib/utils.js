import { clsx } from "clsx";
import { twMerge } from "tailwind-merge";

/**
 * Merge conditional class names, with later Tailwind utilities winning over
 * earlier conflicting ones. Every component in src/ui uses this so a caller
 * can always override a default with `className`.
 */
export function cn(...inputs) {
  return twMerge(clsx(inputs));
}
