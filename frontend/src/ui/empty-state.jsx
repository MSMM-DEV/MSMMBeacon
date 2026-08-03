import * as React from "react";
import { Inbox } from "lucide-react";
import { cn } from "@/lib/utils";

/**
 * The single empty state used everywhere. Every caller must supply a
 * `title` and a `description` that says what would put content here, so no
 * screen in the app ever bottoms out at a bare "No data".
 */
function EmptyState({ icon: Ico = Inbox, title, description, action, className, compact = false }) {
  return (
    <div className={cn("bx-empty", compact && "px-4 py-8", className)}>
      <span className="bx-empty-icon">
        <Ico className="size-5" aria-hidden="true" strokeWidth={1.6} />
      </span>
      <h3>{title}</h3>
      {description ? <p>{description}</p> : null}
      {action ? <div className="mt-1 flex flex-wrap justify-center gap-2">{action}</div> : null}
    </div>
  );
}

export { EmptyState };
