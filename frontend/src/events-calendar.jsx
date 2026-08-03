import React, { useMemo, useRef, useState, useEffect } from "react";
import { Calendar, dateFnsLocalizer } from "react-big-calendar";
import { format, parse, startOfWeek, getDay, differenceInMinutes } from "date-fns";
import { enUS } from "date-fns/locale";
// react-big-calendar's stylesheet is NOT imported here. A JS-side CSS
// import lands UNLAYERED, and an unlayered declaration outranks every
// layered one regardless of specificity, so the library's defaults would
// beat our theming. It is pulled into layer(legacy) in design/index.css.

import { Icon } from "./icons.jsx";
import { UserStack } from "./primitives.jsx";
import { cn } from "@/lib/utils";
import {
  Badge,
  Button,
  Dialog, DialogBody, DialogContent, DialogDescription, DialogHeader, DialogTitle,
  DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuLabel, DropdownMenuSeparator, DropdownMenuTrigger,
  EmptyState,
  Popover, PopoverContent, PopoverTrigger,
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
  Separator,
  Tabs, TabsContent, TabsList, TabsTrigger,
  Tooltip, TooltipProvider,
} from "@/ui";

const locales = { "en-US": enUS };
const localizer = dateFnsLocalizer({
  format,
  parse,
  startOfWeek: (d) => startOfWeek(d, { weekStartsOn: 0 }),
  getDay,
  locales,
});

const TYPE_TONE = {
  "Partner":        "accent",
  "AI":             "sage",
  "Project":        "blue",
  "Meetings":       "muted",
  "Board Meetings": "blue",
  "Event":          "rose",
};

const VIEW_LABEL = { month: "Month", week: "Week", day: "Day", agenda: "Agenda" };
const DESKTOP_VIEWS = ["month", "week", "day"];

/* ----------------------------------------------------------------------
   Presentation maps. These carry no data or behaviour — they translate the
   tone key an event already resolves to into the Beacon token that paints
   it, so a theme swap repaints the calendar without touching this file.
   ---------------------------------------------------------------------- */
const TONE_STYLE = {
  accent: { line: "var(--accent)",    fill: "var(--accent-softer)", edge: "var(--accent-line)" },
  sage:   { line: "var(--sage)",      fill: "var(--sage-soft)",     edge: "var(--sage-line)"   },
  blue:   { line: "var(--blue)",      fill: "var(--blue-soft)",     edge: "var(--blue-line)"   },
  rose:   { line: "var(--rose)",      fill: "var(--rose-soft)",     edge: "var(--rose-line)"   },
  muted:  { line: "var(--text-soft)", fill: "var(--surface-2)",     edge: "var(--border)"      },
};

const toneVars = (tone) => {
  const t = TONE_STYLE[tone] || TONE_STYLE.muted;
  return { "--evt-line": t.line, "--evt-fill": t.fill, "--evt-edge": t.edge };
};

// Status semantics are fixed product-wide (see design/README §2) and match
// StatusChip in primitives.jsx so the calendar, the list and the drawer all
// tell the same story. Status is never carried by colour alone: every place
// it appears it is paired with an icon and a readable label.
const STATUS_META = {
  "Booked":    { label: "Booked",    icon: "calendarClock", tone: "info",    ink: "var(--blue-ink)"   },
  "Scheduled": { label: "Scheduled", icon: "clock",         tone: "brand",   ink: "var(--accent-ink)" },
  "Happened":  { label: "Happened",  icon: "checkCircle",   tone: "neutral", ink: "var(--text-muted)" },
};
const CANCELLED_META = { label: "Cancelled", icon: "ban", tone: "danger", ink: "var(--rose-ink)" };

// Read-only lookup: an Outlook cancellation outranks the stored status, which
// is exactly how the existing chips already treat `outlookIsCancelled`.
function statusMeta(r) {
  if (r?.outlookIsCancelled) return CANCELLED_META;
  return STATUS_META[r?.status] || null;
}

// Icon adapters so EmptyState (which takes a component) can use the Beacon
// registry instead of importing lucide-react into a page.
const CalendarGlyph = (props) => <Icon name="calendarDays" {...props} />;

/* ----------------------------------------------------------------------
   BRIDGE — not the calendar's theme, and not meant to live here forever.

   react-big-calendar's stylesheet is imported from JS, so it is emitted
   OUTSIDE the cascade layers declared in design/index.css. Unlayered
   declarations beat every layered one regardless of specificity, so the
   library's hard-coded `#ddd` hairlines, `#e6e6e6` off-range wash,
   `#eaf6ff` today tint, `#3174ad` links and `height:100%` currently
   outrank both styles.css and any Tailwind utility. The result is a grid
   that collapses to zero height and reads as a light-mode widget dropped
   into the dark theme.

   The real fix is one line in design/index.css:
     @import "react-big-calendar/lib/css/react-big-calendar.css" layer(legacy);
   (with the JS-side imports removed). The moment that lands, the existing
   `.cal-shell .rbc-*` rules in styles.css win on their own and this whole
   block can be deleted. Until then these wrapper-scoped utilities hand the
   grid chrome back to the tokens so both themes are finished.
   ---------------------------------------------------------------------- */
const RBC_BRIDGE = [
  // A definite box: `height:100%` inside an auto-height parent collapses.
  "[&_.rbc-calendar]:h-[clamp(520px,70vh,860px)]!",
  // Hairlines.
  "[&_:is(.rbc-header,.rbc-month-view,.rbc-month-row,.rbc-day-bg,.rbc-time-view,.rbc-time-header,.rbc-time-header-content,.rbc-time-content,.rbc-timeslot-group,.rbc-time-slot,.rbc-day-slot,.rbc-allday-cell,.rbc-time-gutter,.rbc-agenda-view,.rbc-agenda-view_table,.rbc-agenda-view_th,.rbc-agenda-view_td,.rbc-agenda-view_tr,.rbc-overlay,.rbc-overlay-header)]:border-[var(--border)]!",
  // Time-grid blocks render their own time range inside the card, so the
  // library's own label above it is a duplicate.
  "[&_.rbc-day-slot_.rbc-event-label]:hidden!",
  // Day washes.
  "[&_.rbc-off-range-bg]:bg-transparent!",
  "[&_.rbc-off-range]:text-[var(--text-soft)]!",
  "[&_.rbc-today]:bg-[var(--accent-softer)]!",
  // Current-time rule in week / day.
  "[&_.rbc-current-time-indicator]:bg-[var(--accent)]!",
  // "+2 more" affordance and the overlay it opens.
  "[&_.rbc-show-more]:bg-transparent!",
  "[&_.rbc-show-more]:text-[var(--accent)]!",
  "[&_.rbc-overlay]:bg-[var(--surface)]!",
  "[&_.rbc-overlay]:text-[var(--text)]!",
  // Drag-to-create selection wash.
  "[&_.rbc-slot-selection]:bg-[var(--accent-soft)]!",
  "[&_.rbc-slot-selection]:text-[var(--accent-ink)]!",
  // Phone agenda: three nowrap columns cannot fit a 360px screen, so the
  // table unrolls into a stacked list, date, then time, then the event.
  "max-sm:[&_:is(.rbc-agenda-table,.rbc-agenda-table_tbody,.rbc-agenda-table_tr,.rbc-agenda-table_td)]:block!",
  "max-sm:[&_.rbc-agenda-table_thead]:hidden!",
  "max-sm:[&_.rbc-agenda-table_td]:w-full!",
  "max-sm:[&_.rbc-agenda-table_td]:border-l-0!",
  "max-sm:[&_.rbc-agenda-table_td]:border-b-0!",
  "max-sm:[&_.rbc-agenda-table_td]:px-3!",
  "max-sm:[&_.rbc-agenda-table_td]:py-0!",
  "max-sm:[&_.rbc-agenda-date-cell]:pt-3!",
  "max-sm:[&_.rbc-agenda-date-cell]:font-semibold!",
  "max-sm:[&_.rbc-agenda-date-cell]:text-[var(--text)]!",
  "max-sm:[&_.rbc-agenda-time-cell]:pt-2!",
  "max-sm:[&_.rbc-agenda-event-cell]:pt-1!",
  "max-sm:[&_.rbc-agenda-event-cell]:pb-3!",
].join(" ");

function useIsMobile(breakpoint = 640) {
  const [isMobile, setIsMobile] = useState(
    typeof window !== "undefined" && window.innerWidth <= breakpoint
  );
  useEffect(() => {
    const onResize = () => setIsMobile(window.innerWidth <= breakpoint);
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, [breakpoint]);
  return isMobile;
}

const toRBCEvent = (row) => {
  const startISO = row.dateTime || row.date;
  if (!startISO) return null;
  const start = new Date(startISO);
  if (Number.isNaN(start.getTime())) return null;
  const endISO = row.outlookEndDateTime;
  let end;
  if (endISO) {
    end = new Date(endISO);
    if (Number.isNaN(end.getTime())) end = new Date(start.getTime() + 60 * 60 * 1000);
  } else if (row.dateTime) {
    end = new Date(start.getTime() + 60 * 60 * 1000);
  } else {
    end = start;
  }
  return {
    id: row.id,
    title: row.title || "(untitled)",
    start,
    end,
    allDay: !row.dateTime && !!row.date,
    resource: row,
  };
};

const fmtTime = (d) => {
  if (!(d instanceof Date) || Number.isNaN(d.getTime())) return "";
  const h = d.getHours();
  const m = d.getMinutes();
  const hh = ((h + 11) % 12) + 1;
  const ampm = h < 12 ? "am" : "pm";
  return m === 0 ? `${hh}${ampm}` : `${hh}:${String(m).padStart(2, "0")}${ampm}`;
};

/* ======================================================================
   Shared event signals
   ====================================================================== */

/** Star rating read-out. Colour comes from the shared --stars-N ramp, but the
 *  glyph and the number carry the meaning on their own. */
function StarChip({ stars, className }) {
  if (!(stars > 0)) return null;
  const label = `${stars} of 5 stars`;
  return (
    <span
      className={cn(
        "inline-flex shrink-0 items-center gap-px rounded-[var(--radius-full)]",
        "border border-[var(--border)] bg-[var(--surface)] px-1",
        "text-[length:var(--fs-2xs)] font-semibold leading-[1.4]",
        className
      )}
      style={{ color: `var(--stars-${stars})` }}
      role="img"
      aria-label={label}
    >
      <Icon name="star" size={9} stroke={2.2} />
      <span className="num" aria-hidden="true">{stars}</span>
    </span>
  );
}

/** External-invitee count. `+3` on tight surfaces, `+3 external` where there
 *  is room for the noun. */
function ExternalChip({ count, withLabel = false, className }) {
  if (!(count > 0)) return null;
  const label = `${count} external invitee${count === 1 ? "" : "s"}`;
  return (
    <span
      className={cn(
        "inline-flex shrink-0 items-center gap-1 rounded-[var(--radius-full)]",
        "border border-[var(--border)] bg-[var(--surface)] px-1.5",
        "text-[length:var(--fs-2xs)] font-semibold leading-[1.4] text-[var(--text-muted)]",
        className
      )}
      role="img"
      aria-label={label}
    >
      <span className="num" aria-hidden="true">+{count}</span>
      {withLabel && <span aria-hidden="true">external</span>}
    </span>
  );
}

/** Full status badge: tone + icon + word. Used wherever a row has room. */
function StatusBadge({ resource, className }) {
  const s = statusMeta(resource);
  if (!s) return null;
  return (
    <Badge tone={s.tone} size="sm" className={cn("shrink-0 gap-1 py-px", className)}>
      <Icon name={s.icon} size={10} stroke={2} />
      {s.label}
    </Badge>
  );
}

/** Compact status mark for the month pill, where a full badge would not fit.
 *  The icon shape distinguishes the states; the .sr-only word names them. */
function StatusMark({ resource }) {
  const s = statusMeta(resource);
  if (!s) return null;
  return (
    <span className="inline-flex shrink-0 items-center" style={{ color: s.ink }}>
      <Icon name={s.icon} size={11} stroke={2} />
      <span className="sr-only">{s.label}</span>
    </span>
  );
}

/** Hover / focus summary for an event chip. Radix handles the a11y wiring;
 *  the trigger stays a plain element so the click still reaches rbc. */
function EventTooltip({ event, side = "top", children }) {
  const r = event.resource || {};
  const s = statusMeta(r);
  const ext = (r.outlookExternalAttendees || []).length;
  const meta = [r.type, s?.label].filter(Boolean).join(" · ");
  return (
    <Tooltip
      side={side}
      delay={350}
      label={
        <span className="flex flex-col gap-0.5">
          <span className="font-semibold">{event.title}</span>
          <span className="num opacity-80">
            {event.allDay ? "All day" : `${fmtTime(event.start)} to ${fmtTime(event.end)}`}
          </span>
          {meta ? <span className="opacity-80">{meta}</span> : null}
          {r.stars > 0 ? (
            <span className="opacity-80">
              <span className="num">{r.stars}</span> of <span className="num">5</span> stars
            </span>
          ) : null}
          {ext > 0 ? (
            <span className="opacity-80">
              <span className="num">{ext}</span> external {ext === 1 ? "invitee" : "invitees"}
            </span>
          ) : null}
          {r.source === "outlook" ? <span className="opacity-80">Synced from Outlook</span> : null}
        </span>
      }
    >
      {children}
    </Tooltip>
  );
}

/* ======================================================================
   Event chips
   ====================================================================== */

// Month view: compact horizontal pill (room is tight — title + signals only).
function EventBlock({ event }) {
  const r = event.resource;
  const externalCount = (r.outlookExternalAttendees || []).length;
  const tone = TYPE_TONE[r.type] || "muted";
  const stars = r.stars;
  return (
    <EventTooltip event={event}>
      <div
        style={toneVars(tone)}
        className={cn(
          "relative flex min-h-[22px] w-full min-w-0 cursor-pointer items-stretch overflow-hidden",
          "rounded-[var(--radius-xs)] border border-[var(--evt-edge)] bg-[var(--evt-fill)]",
          "transition-[box-shadow,translate] duration-[var(--dur-fast)] ease-[var(--ease-out)]",
          "hover:-translate-y-px hover:shadow-[var(--shadow-sm)] active:translate-y-0",
          r.outlookIsCancelled && "opacity-60"
        )}
      >
        <span aria-hidden="true" className="w-[3px] shrink-0 bg-[var(--evt-line)]" />
        <span className="flex min-w-0 flex-1 items-center gap-1 px-1.5 py-px">
          {r.source === "outlook" && (
            <span className="inline-flex shrink-0 items-center text-[var(--text-soft)]">
              <Icon name="link" size={9} stroke={2} />
              <span className="sr-only">Synced from Outlook</span>
            </span>
          )}
          <span
            className={cn(
              "min-w-0 flex-1 truncate text-[length:var(--fs-xs)] font-medium leading-[1.35] text-[var(--text)]",
              r.outlookIsCancelled && "text-[var(--text-soft)] line-through"
            )}
          >
            {event.title}
          </span>
          <StarChip stars={stars} />
          <ExternalChip count={externalCount} />
          <StatusMark resource={r} />
        </span>
      </div>
    </EventTooltip>
  );
}

// Week / Day view: tall card that fills the absolutely-positioned rbc-event slot
// so the visual block actually spans start → end. Density adapts to duration so
// 15-minute events don't overflow their time and 4-hour events don't waste space.
function TimeBlockEvent({ event }) {
  const r = event.resource;
  const tone = TYPE_TONE[r.type] || "muted";
  const stars = r.stars;
  const externalCount = (r.outlookExternalAttendees || []).length;
  const minutes = Math.max(0, differenceInMinutes(event.end, event.start));
  // Density tiers control how much chrome we render inside the block.
  // <30 min: title only (cramped). 30–59: title + time. ≥60: title + time + signals.
  const density = minutes < 30 ? "xs" : minutes < 60 ? "sm" : "lg";
  const showTime = density !== "xs";
  const showSignals = density === "lg";
  return (
    <EventTooltip event={event} side="right">
      <div
        style={toneVars(tone)}
        className={cn(
          "relative mx-0.5 flex h-full cursor-pointer items-stretch overflow-hidden",
          "rounded-[var(--radius-xs)] border border-[var(--evt-edge)] bg-[var(--evt-fill)]",
          "transition-[box-shadow,filter] duration-[var(--dur-fast)] ease-[var(--ease-out)]",
          "hover:z-[2] hover:shadow-[var(--shadow-md)]",
          r.outlookIsCancelled && "opacity-60"
        )}
      >
        <span aria-hidden="true" className="w-[3px] shrink-0 bg-[var(--evt-line)]" />
        <span
          className={cn(
            "flex min-w-0 flex-1 flex-col items-start gap-0.5 overflow-hidden",
            density === "lg" ? "px-2 py-1" : "px-1.5 py-px"
          )}
        >
          <span className="flex w-full min-w-0 shrink-0 items-center gap-1">
            {r.source === "outlook" && (
              <span className="inline-flex shrink-0 items-center text-[var(--text-soft)]">
                <Icon name="link" size={9} stroke={2} />
                <span className="sr-only">Synced from Outlook</span>
              </span>
            )}
            <span
              className={cn(
                "min-w-0 flex-1 truncate font-medium leading-[1.3] text-[var(--text)]",
                density === "xs" ? "text-[length:var(--fs-2xs)]" : "text-[length:var(--fs-xs)]",
                r.outlookIsCancelled && "text-[var(--text-soft)] line-through"
              )}
            >
              {event.title}
            </span>
            {stars > 0 && showSignals && <StarChip stars={stars} />}
            {showSignals && <ExternalChip count={externalCount} />}
            <StatusMark resource={r} />
          </span>
          {showTime && (
            <span className="num shrink-0 truncate font-[family-name:var(--font-mono)] text-[length:var(--fs-2xs)] font-medium leading-[1.3] text-[var(--text-muted)]">
              {fmtTime(event.start)} – {fmtTime(event.end)}
            </span>
          )}
        </span>
      </div>
    </EventTooltip>
  );
}

// Agenda view — also the phone fallback, so it has to stay readable and
// wrap cleanly at 360px rather than squashing into a grid.
function AgendaEventRow({ event }) {
  const r = event.resource;
  const tone = TYPE_TONE[r.type] || "muted";
  const stars = r.stars;
  const externalCount = (r.outlookExternalAttendees || []).length;
  return (
    <EventTooltip event={event}>
      <div
        style={toneVars(tone)}
        className={cn(
          "flex min-w-0 cursor-pointer flex-wrap items-center gap-x-2 gap-y-1 py-0.5",
          r.outlookIsCancelled && "opacity-70"
        )}
      >
        <span
          aria-hidden="true"
          className="size-2 shrink-0 rounded-full bg-[var(--evt-line)]"
        />
        <span
          className={cn(
            "min-w-[7rem] flex-1 truncate text-[length:var(--fs-sm)] font-medium text-[var(--text)]",
            r.outlookIsCancelled && "text-[var(--text-soft)] line-through"
          )}
        >
          {event.title}
        </span>
        <StatusBadge resource={r} />
        <StarChip stars={stars} />
        <ExternalChip count={externalCount} />
        {r.source === "outlook" && (
          <Badge tone="outline" size="sm" className="gap-1 py-px">
            <Icon name="link" size={10} stroke={2} />
            Outlook
          </Badge>
        )}
        {(r.attendees || []).length > 0 && (
          <span className="inline-flex shrink-0">
            <UserStack ids={r.attendees} max={3} />
          </span>
        )}
      </div>
    </EventTooltip>
  );
}

/* ======================================================================
   Legend
   ====================================================================== */

function LegendHeading({ children }) {
  return (
    <h3 className="m-0 mb-1.5 text-[length:var(--fs-2xs)] font-semibold uppercase tracking-[var(--tracking-caps)] text-[var(--text-soft)]">
      {children}
    </h3>
  );
}

/** What every mark on a chip means. Types are named in words next to their
 *  swatch, statuses carry an icon and a label, so nothing here relies on
 *  colour on its own. */
function CalendarLegend() {
  const statuses = [
    STATUS_META["Booked"],
    STATUS_META["Scheduled"],
    STATUS_META["Happened"],
    CANCELLED_META,
  ];
  return (
    <div className="flex flex-col gap-3">
      <section>
        <LegendHeading>Event type</LegendHeading>
        <ul className="m-0 grid list-none grid-cols-2 gap-x-3 gap-y-1 p-0">
          {Object.keys(TYPE_TONE).map((type) => (
            <li
              key={type}
              className="flex min-w-0 items-center gap-2 text-[length:var(--fs-sm)] text-[var(--text)]"
            >
              <span
                aria-hidden="true"
                className="h-3.5 w-[3px] shrink-0 rounded-[1px]"
                style={{ background: TONE_STYLE[TYPE_TONE[type]].line }}
              />
              <span className="truncate">{type}</span>
            </li>
          ))}
        </ul>
      </section>

      <Separator />

      <section>
        <LegendHeading>Status</LegendHeading>
        <ul className="m-0 flex list-none flex-wrap gap-1.5 p-0">
          {statuses.map((s) => (
            <li key={s.label}>
              <Badge tone={s.tone} size="sm" className="gap-1 py-px">
                <Icon name={s.icon} size={10} stroke={2} />
                {s.label}
              </Badge>
            </li>
          ))}
        </ul>
        <p className="m-0 mt-1.5 text-[length:var(--fs-xs)] leading-[var(--lh-snug)] text-[var(--text-muted)]">
          Cancelled events stay on the grid with their title struck through.
        </p>
      </section>

      <Separator />

      <section>
        <LegendHeading>Marks on a chip</LegendHeading>
        <ul className="m-0 flex list-none flex-col gap-1.5 p-0 text-[length:var(--fs-xs)] text-[var(--text-muted)]">
          <li className="flex items-center gap-2">
            <span className="inline-flex size-4 shrink-0 items-center justify-center text-[var(--text-soft)]">
              <Icon name="link" size={11} stroke={2} />
            </span>
            <span>Synced from Outlook</span>
          </li>
          <li className="flex items-center gap-2">
            <StarChip stars={4} />
            <span>Star rating on the event</span>
          </li>
          <li className="flex items-center gap-2">
            <ExternalChip count={2} />
            <span>External invitees on the meeting</span>
          </li>
        </ul>
      </section>
    </div>
  );
}

/* ======================================================================
   Notices: sync progress, unplaced rows, empty dataset
   ====================================================================== */

/** Rows the calendar cannot place because they carry no usable date. They are
 *  dropped from the grid either way; this only makes that visible. */
function UnplacedNotice({ rows }) {
  const [open, setOpen] = useState(false);
  const n = rows.length;
  return (
    <div
      className={cn(
        "flex flex-wrap items-center gap-x-2 gap-y-1.5 rounded-[var(--radius-sm)]",
        "border border-[var(--accent-line)] bg-[var(--accent-softer)] px-3 py-2",
        "text-[length:var(--fs-sm)] text-[var(--accent-ink)]"
      )}
    >
      <Icon name="warn" size={15} />
      <span className="min-w-0 flex-1">
        <span className="num font-semibold">{n}</span>{" "}
        {n === 1 ? "event has no usable date, so it is" : "events have no usable date, so they are"}{" "}
        not shown on the calendar.
      </span>
      <Button
        variant="ghost"
        size="xs"
        className="shrink-0 text-[var(--accent-ink)] hover:bg-[var(--accent-soft)]"
        onClick={() => setOpen(true)}
      >
        Review
      </Button>
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent size="sm">
          <DialogHeader>
            <DialogTitle>Events without a date</DialogTitle>
            <DialogDescription>
              Add a date on the Events list and these will appear on the calendar.
            </DialogDescription>
          </DialogHeader>
          <DialogBody>
            <ul className="m-0 flex list-none flex-col p-0">
              {rows.map((row, i) => (
                <li
                  key={row.id ?? i}
                  className="flex min-w-0 items-baseline gap-2 border-b border-[var(--border)] py-2 last:border-b-0"
                >
                  <span className="num shrink-0 text-[length:var(--fs-xs)] text-[var(--text-soft)]">
                    {i + 1}
                  </span>
                  <span className="min-w-0 flex-1 break-words text-[length:var(--fs-sm)] text-[var(--text)]">
                    {row.title || "(untitled)"}
                  </span>
                  {row.type ? (
                    <Badge tone="neutral" size="sm" className="shrink-0">{row.type}</Badge>
                  ) : (
                    <span className="shrink-0 text-[var(--text-soft)]">–</span>
                  )}
                </li>
              ))}
            </ul>
          </DialogBody>
        </DialogContent>
      </Dialog>
    </div>
  );
}

/* ======================================================================
   Toolbar
   ====================================================================== */

function CalendarToolbar({
  label, onNavigate, onView, view,
  viewsAvailable, onSyncNow, isAdmin, syncing,
  notice,
}) {
  const [keyOpen, setKeyOpen] = useState(false);
  const canSync = Boolean(isAdmin && onSyncNow);
  const showViews = viewsAvailable.length > 1;

  const navBtn =
    "h-9 w-9 rounded-[calc(var(--radius)-3px)] text-[var(--text-muted)] hover:bg-[var(--surface)] hover:text-[var(--text)] sm:h-8 sm:w-8";

  return (
    <>
      <div className="mb-3 flex flex-col gap-3 border-b border-[var(--border)] pb-3 sm:flex-row sm:items-end sm:justify-between sm:gap-4">
        <div className="min-w-0">
          <span className="block text-[length:var(--fs-2xs)] font-semibold uppercase tracking-[var(--tracking-caps)] text-[var(--text-soft)]">
            {VIEW_LABEL[view] || "Calendar"} view
          </span>
          <h2 className="num m-0 truncate font-[family-name:var(--font-display)] text-[length:var(--fs-xl)] font-semibold leading-[var(--lh-tight)] tracking-[var(--tracking-tight)] text-[var(--text)] sm:text-[length:var(--fs-2xl)]">
            {label}
          </h2>
        </div>

        <div className="flex min-w-0 flex-wrap items-center gap-2 sm:justify-end">
          {/* Period navigation */}
          <div className="inline-flex shrink-0 items-center gap-0.5 rounded-[var(--radius)] border border-[var(--border)] bg-[var(--surface-2)] p-0.5">
            <Tooltip label="Previous">
              <Button
                variant="ghost"
                size="icon"
                aria-label="Previous"
                className={navBtn}
                onClick={() => onNavigate("PREV")}
              >
                <Icon name="chevronLeft" size={16} />
              </Button>
            </Tooltip>
            <Button
              variant="ghost"
              size="sm"
              className="h-9 rounded-[calc(var(--radius)-3px)] px-3 text-[var(--text)] hover:bg-[var(--surface)] sm:h-8"
              onClick={() => onNavigate("TODAY")}
            >
              Today
            </Button>
            <Tooltip label="Next">
              <Button
                variant="ghost"
                size="icon"
                aria-label="Next"
                className={navBtn}
                onClick={() => onNavigate("NEXT")}
              >
                <Icon name="chevronRight" size={16} />
              </Button>
            </Tooltip>
          </div>

          {/* View switching — segmented where there is room, a select where
              the toolbar would otherwise wrap onto three rows. */}
          {showViews && (
            <>
              <Tabs
                value={view}
                onValueChange={(v) => onView(v)}
                className="hidden shrink-0 md:block"
              >
                <TabsList variant="segmented" aria-label="Calendar view">
                  {viewsAvailable.map((v) => (
                    <TabsTrigger key={v} value={v}>{VIEW_LABEL[v]}</TabsTrigger>
                  ))}
                </TabsList>
                {viewsAvailable.map((v) => (
                  <TabsContent key={v} value={v} className="sr-only">
                    {VIEW_LABEL[v]} view
                  </TabsContent>
                ))}
              </Tabs>

              <Select value={view} onValueChange={(v) => onView(v)}>
                <SelectTrigger
                  size="sm"
                  aria-label="Calendar view"
                  className="h-9 w-[104px] shrink-0 sm:h-8 md:hidden"
                >
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {viewsAvailable.map((v) => (
                    <SelectItem key={v} value={v}>{VIEW_LABEL[v]}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </>
          )}

          {/* Key — a popover from tablet up, the same content in a sheet-style
              dialog on a phone where a popover would fill the screen anyway. */}
          <Popover>
            <PopoverTrigger asChild>
              <Button
                variant="ghost"
                size="sm"
                aria-label="Calendar key"
                className="hidden h-8 shrink-0 px-2 sm:inline-flex"
              >
                <Icon name="info" size={15} />
                <span className="hidden lg:inline">Key</span>
              </Button>
            </PopoverTrigger>
            <PopoverContent align="end" className="w-[290px]">
              <CalendarLegend />
            </PopoverContent>
          </Popover>

          {canSync && (
            <Tooltip label="Pull the latest from Outlook">
              <Button
                variant="default"
                size="sm"
                className="hidden h-8 shrink-0 sm:inline-flex"
                onClick={onSyncNow}
                disabled={syncing}
                loading={syncing}
              >
                {!syncing && <Icon name="bolt" size={14} />}
                <span>{syncing ? "Syncing…" : "Sync"}</span>
              </Button>
            </Tooltip>
          )}

          {/* Phone: secondary actions collapse into one menu so the toolbar
              stays a single row at 360px. */}
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button
                variant="ghost"
                size="icon"
                aria-label="Calendar actions"
                className="h-9 w-9 shrink-0 sm:hidden"
              >
                <Icon name="more" size={16} />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end">
              <DropdownMenuLabel>Calendar</DropdownMenuLabel>
              <DropdownMenuItem onSelect={() => setKeyOpen(true)}>
                <Icon name="info" size={16} />
                Show key
              </DropdownMenuItem>
              {canSync && (
                <>
                  <DropdownMenuSeparator />
                  <DropdownMenuItem disabled={syncing} onSelect={() => onSyncNow()}>
                    <Icon name="bolt" size={16} />
                    {syncing ? "Syncing…" : "Sync from Outlook"}
                  </DropdownMenuItem>
                </>
              )}
            </DropdownMenuContent>
          </DropdownMenu>

          <Dialog open={keyOpen} onOpenChange={setKeyOpen}>
            <DialogContent size="sm">
              <DialogHeader>
                <DialogTitle>Calendar key</DialogTitle>
                <DialogDescription>
                  What the colours, icons and counts on an event mean.
                </DialogDescription>
              </DialogHeader>
              <DialogBody>
                <CalendarLegend />
              </DialogBody>
            </DialogContent>
          </Dialog>
        </div>
      </div>

      {notice}
    </>
  );
}

/* ======================================================================
   Calendar
   ====================================================================== */

export function EventsCalendar({
  events = [],
  onOpenDrawer,
  onCreateAtSlot,
  viewMode = "month",
  setViewMode,
  isAdmin = false,
  onSyncNow,
  syncing = false,
}) {
  const isMobile = useIsMobile();
  const [date, setDate] = useState(new Date());

  const rbcEvents = useMemo(
    () => events.map(toRBCEvent).filter(Boolean),
    [events]
  );

  // Display-only companion to `rbcEvents`: the rows that fell out of the map
  // above. Nothing about their handling changes, they are just surfaced.
  const unplaced = useMemo(
    () => events.filter((row) => toRBCEvent(row) === null),
    [events]
  );

  const eventPropGetter = (event) => {
    const r = event.resource;
    const tone = TYPE_TONE[r.type] || "muted";
    return {
      className:
        `cal-event-wrap tone-${tone}` +
        (r.outlookIsCancelled ? " cancelled" : "") +
        (r.source === "outlook" ? " outlook" : "") +
        // react-big-calendar's own stylesheet ships unlayered, so its solid
        // blue .rbc-event chrome outranks anything the Beacon layers set.
        // These marked utilities hand the surface back to the chip inside.
        " bg-transparent! border-0! p-0! rounded-none! shadow-none! text-inherit!" +
        " outline-none! focus-visible:shadow-[var(--focus-ring)]!",
    };
  };

  const dayPropGetter = (d) => {
    const t = new Date();
    const isToday =
      d.getFullYear() === t.getFullYear() &&
      d.getMonth() === t.getMonth() &&
      d.getDate() === t.getDate();
    return isToday ? { className: "cal-day-today bg-[var(--accent-softer)]!" } : {};
  };

  const effectiveView = isMobile ? "agenda" : viewMode;
  const viewsAvailable = useMemo(
    () => (isMobile ? ["agenda"] : DESKTOP_VIEWS),
    [isMobile]
  );

  // Open week/day at the start of the business day so users don't land at 12am.
  const scrollToTime = useMemo(() => {
    const t = new Date();
    t.setHours(7, 0, 0, 0);
    return t;
  }, []);

  const isEmpty = events.length === 0;

  // Status strip that sits between the toolbar and the grid: sync progress,
  // rows that could not be placed, and the empty state.
  const notice = useMemo(() => {
    if (!syncing && unplaced.length === 0 && !isEmpty) return null;
    return (
      <div className="mb-3 flex flex-col gap-2">
        {syncing && (
          <p
            role="status"
            aria-live="polite"
            className="m-0 flex items-center gap-2 rounded-[var(--radius-sm)] border border-[var(--border)] bg-[var(--surface-2)] px-3 py-2 text-[length:var(--fs-sm)] text-[var(--text-muted)]"
          >
            <Icon name="spinner" size={14} className="animate-spin" />
            Syncing events from Outlook. The calendar refreshes when it finishes.
          </p>
        )}
        {unplaced.length > 0 && <UnplacedNotice rows={unplaced} />}
        {isEmpty && (
          <EmptyState
            compact
            icon={CalendarGlyph}
            title="Nothing on the calendar yet"
            description={
              onCreateAtSlot
                ? "Events added on the Events list, or synced from Outlook, show up here. You can also click any day or time slot below to start one."
                : "Events added on the Events list, or synced from Outlook, show up here."
            }
            action={
              isAdmin && onSyncNow ? (
                <Button variant="default" size="sm" onClick={() => onSyncNow()} disabled={syncing}>
                  <Icon name="bolt" size={14} />
                  Sync from Outlook
                </Button>
              ) : null
            }
          />
        )}
      </div>
    );
  }, [syncing, unplaced, isEmpty, isAdmin, onSyncNow, onCreateAtSlot]);

  // The toolbar's live inputs, read through a ref so `calendarComponents`
  // below can be created exactly once.
  const toolbarExtras = useRef(null);
  toolbarExtras.current = { viewsAvailable, onSyncNow, isAdmin, syncing, notice };

  // `components` must keep a stable identity. react-big-calendar renders
  // `components.toolbar` as a component type, so a new object on every render
  // is a new type, which unmounts and remounts the whole toolbar. That tears
  // down any open Radix menu or popover mid-interaction and can leave the
  // library's scroll/pointer lock behind.
  const calendarComponents = useMemo(
    () => ({
      event: EventBlock,                  // month + fallback
      toolbar: (props) => <CalendarToolbar {...props} {...toolbarExtras.current} />,
      week:   { event: TimeBlockEvent },  // tall card for time-grid views
      day:    { event: TimeBlockEvent },
      agenda: { event: AgendaEventRow },
    }),
    []
  );

  return (
    <div
      className={cn(
        `cal-shell cal-view-${effectiveView}`,
        "relative min-w-0 rounded-[var(--radius-lg)] border border-[var(--border)]",
        "bg-[var(--surface)] p-3 shadow-[var(--shadow-sm)] sm:p-5",
        RBC_BRIDGE
      )}
    >
      <TooltipProvider delayDuration={350} skipDelayDuration={200}>
        <Calendar
          localizer={localizer}
          events={rbcEvents}
          view={effectiveView}
          onView={(v) => { if (!isMobile && setViewMode) setViewMode(v); }}
          date={date}
          onNavigate={setDate}
          startAccessor="start"
          endAccessor="end"
          views={{ month: true, week: true, day: true, agenda: true }}
          eventPropGetter={eventPropGetter}
          dayPropGetter={dayPropGetter}
          popup
          selectable
          // The chips carry their own styled Tooltip; leaving rbc's default
          // `title` accessor on would stack a raw browser tooltip under it.
          tooltipAccessor={null}
          step={30}
          timeslots={2}
          scrollToTime={scrollToTime}
          components={calendarComponents}
          onSelectEvent={(e) => onOpenDrawer && onOpenDrawer(e.resource)}
          onSelectSlot={(slot) =>
            onCreateAtSlot && onCreateAtSlot({ start: slot.start, end: slot.end })
          }
          formats={{
            monthHeaderFormat:    (d, _c, l) => l.format(d, "MMMM yyyy"),
            dayHeaderFormat:      (d, _c, l) => l.format(d, "EEEE · MMM d"),
            dayRangeHeaderFormat: ({ start, end }, _c, l) =>
              `${l.format(start, "MMM d")} – ${l.format(end, "MMM d, yyyy")}`,
            weekdayFormat:        (d, _c, l) => l.format(d, "EEE").toUpperCase(),
            // Week-view column headers: "MON · 26" — uppercase day code, then date.
            dayFormat:            (d, _c, l) =>
              `${l.format(d, "EEE").toUpperCase()} · ${l.format(d, "d")}`,
            timeGutterFormat:     (d, _c, l) =>
              d.getMinutes() === 0
                ? l.format(d, "h a").toLowerCase().replace(" ", "")
                : "",
            eventTimeRangeFormat: ({ start, end }, _c, l) =>
              `${l.format(start, "h:mma").toLowerCase()} – ${l.format(end, "h:mma").toLowerCase()}`,
            agendaTimeFormat:     (d, _c, l) => l.format(d, "h:mma").toLowerCase(),
            agendaDateFormat:     (d, _c, l) => l.format(d, "EEE MMM d"),
            agendaHeaderFormat:   ({ start, end }, _c, l) =>
              `${l.format(start, "MMM d")} – ${l.format(end, "MMM d, yyyy")}`,
          }}
          messages={{
            noEventsInRange: (
              <span className="inline-flex flex-wrap items-center justify-center gap-2 text-[length:var(--fs-sm)] text-[var(--text-muted)]">
                <Icon name="calendarDays" size={15} />
                <span>Nothing scheduled in this range. Try Today, or step forward a period.</span>
              </span>
            ),
          }}
          length={30}
        />
      </TooltipProvider>
    </div>
  );
}

export default EventsCalendar;
