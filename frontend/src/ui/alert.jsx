import * as React from "react";
import { cva } from "class-variance-authority";
import { AlertTriangle, CheckCircle2, Info, OctagonAlert } from "lucide-react";
import { cn } from "@/lib/utils";

const alertVariants = cva(
  "flex min-w-0 items-start gap-3 rounded-[var(--radius-md)] border px-3.5 py-3 text-[length:var(--fs-sm)]",
  {
    variants: {
      tone: {
        info: "border-[var(--blue-line)] bg-[var(--blue-soft)] text-[var(--blue-ink)]",
        success: "border-[var(--sage-line)] bg-[var(--sage-soft)] text-[var(--sage-ink)]",
        warning: "border-[var(--accent-line)] bg-[var(--accent-soft)] text-[var(--accent-ink)]",
        danger: "border-[var(--rose-line)] bg-[var(--rose-soft)] text-[var(--rose-ink)]",
        neutral: "border-[var(--border)] bg-[var(--surface-2)] text-[var(--text-muted)]",
      },
    },
    defaultVariants: { tone: "info" },
  }
);

const defaultIcons = {
  info: Info,
  success: CheckCircle2,
  warning: AlertTriangle,
  danger: OctagonAlert,
  neutral: Info,
};

function Alert({ className, tone = "info", icon, title, children, ...props }) {
  const Ico = icon === null ? null : icon || defaultIcons[tone];
  return (
    <div
      role={tone === "danger" ? "alert" : "status"}
      className={cn(alertVariants({ tone }), className)}
      {...props}
    >
      {Ico ? <Ico className="mt-px size-4 shrink-0" aria-hidden="true" /> : null}
      <div className="min-w-0 flex-1">
        {title ? <p className="m-0 font-semibold">{title}</p> : null}
        {children ? <div className={cn("min-w-0", title && "mt-0.5 opacity-90")}>{children}</div> : null}
      </div>
    </div>
  );
}

export { Alert, alertVariants };
