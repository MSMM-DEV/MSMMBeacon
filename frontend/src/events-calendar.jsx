import React, { useMemo, useState, useEffect } from "react";
import { Calendar, dateFnsLocalizer } from "react-big-calendar";
import { format, parse, startOfWeek, getDay, differenceInMinutes } from "date-fns";
import { enUS } from "date-fns/locale";
import "react-big-calendar/lib/css/react-big-calendar.css";

import { Icon } from "./icons.jsx";
import { UserStack } from "./primitives.jsx";

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

// Month view: compact horizontal pill (room is tight — title + signals only).
function EventBlock({ event }) {
  const r = event.resource;
  const externalCount = (r.outlookExternalAttendees || []).length;
  const tone = TYPE_TONE[r.type] || "muted";
  const stars = r.stars;
  return (
    <div className={`cal-event cal-event-pill tone-${tone}${r.outlookIsCancelled ? " cancelled" : ""}`}>
      <span className="cal-event-stripe" aria-hidden />
      <span className="cal-event-body">
        {r.source === "outlook" && (
          <span className="cal-event-source" title="Synced from Outlook">
            <Icon name="link" size={9} stroke={2} />
          </span>
        )}
        <span className="cal-event-title">{event.title}</span>
        {stars > 0 && (
          <span
            className={`cal-event-stars stars-set-${stars}`}
            title={`${stars} of 5 stars`}
            aria-label={`${stars} of 5 stars`}
          >
            ★{stars}
          </span>
        )}
        {externalCount > 0 && (
          <span
            className="cal-event-ext"
            title={`${externalCount} external invitee${externalCount === 1 ? "" : "s"}`}
          >
            +{externalCount}
          </span>
        )}
      </span>
    </div>
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
    <div
      className={
        `cal-event cal-event-block tone-${tone} density-${density}` +
        (r.outlookIsCancelled ? " cancelled" : "")
      }
    >
      <span className="cal-event-stripe" aria-hidden />
      <span className="cal-event-block-body">
        <span className="cal-event-block-head">
          {r.source === "outlook" && (
            <span className="cal-event-source" title="Synced from Outlook">
              <Icon name="link" size={9} stroke={2} />
            </span>
          )}
          <span className="cal-event-title">{event.title}</span>
          {stars > 0 && showSignals && (
            <span
              className={`cal-event-stars stars-set-${stars}`}
              title={`${stars} of 5 stars`}
            >
              ★{stars}
            </span>
          )}
        </span>
        {showTime && (
          <span className="cal-event-time">
            {fmtTime(event.start)} – {fmtTime(event.end)}
          </span>
        )}
        {showSignals && externalCount > 0 && (
          <span className="cal-event-meta">
            <span
              className="cal-event-ext"
              title={`${externalCount} external invitee${externalCount === 1 ? "" : "s"}`}
            >
              +{externalCount} external
            </span>
          </span>
        )}
      </span>
    </div>
  );
}

function AgendaEventRow({ event }) {
  const r = event.resource;
  const tone = TYPE_TONE[r.type] || "muted";
  const stars = r.stars;
  return (
    <div className={`cal-agenda-row${r.outlookIsCancelled ? " cancelled" : ""}`}>
      <span className={`cal-agenda-dot tone-${tone}`} aria-hidden />
      <span className="cal-agenda-title">{event.title}</span>
      {stars > 0 && (
        <span className={`cal-agenda-stars stars-set-${stars}`} title={`${stars} of 5 stars`}>
          {"★".repeat(stars)}
        </span>
      )}
      {r.source === "outlook" && <span className="cal-agenda-source">Outlook</span>}
      {(r.attendees || []).length > 0 && (
        <span className="cal-agenda-attendees">
          <UserStack ids={r.attendees} max={3} />
        </span>
      )}
    </div>
  );
}

function CalendarToolbar({
  label, onNavigate, onView, view,
  viewsAvailable, onSyncNow, isAdmin, syncing,
}) {
  return (
    <div className="cal-toolbar">
      <div className="cal-toolbar-l">
        <h2 className="cal-month-label">{label}</h2>
      </div>
      <div className="cal-toolbar-r">
        <div className="cal-nav">
          <button className="cal-nav-btn" onClick={() => onNavigate("PREV")} aria-label="Previous">
            <span className="cal-chev" aria-hidden>‹</span>
          </button>
          <button className="cal-today-btn" onClick={() => onNavigate("TODAY")}>Today</button>
          <button className="cal-nav-btn" onClick={() => onNavigate("NEXT")} aria-label="Next">
            <span className="cal-chev" aria-hidden>›</span>
          </button>
        </div>
        {viewsAvailable.length > 1 && (
          <div className="cal-views">
            {viewsAvailable.map((v) => (
              <button
                key={v}
                className={"cal-view-btn" + (v === view ? " active" : "")}
                onClick={() => onView(v)}
              >
                {VIEW_LABEL[v]}
              </button>
            ))}
          </div>
        )}
        {isAdmin && onSyncNow && (
          <button
            className={"cal-sync-btn" + (syncing ? " syncing" : "")}
            onClick={onSyncNow}
            disabled={syncing}
            title="Pull latest from Outlook"
          >
            <Icon name="bolt" size={13} />
            <span>{syncing ? "Syncing…" : "Sync"}</span>
          </button>
        )}
      </div>
    </div>
  );
}

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

  const eventPropGetter = (event) => {
    const r = event.resource;
    const tone = TYPE_TONE[r.type] || "muted";
    return {
      className:
        `cal-event-wrap tone-${tone}` +
        (r.outlookIsCancelled ? " cancelled" : "") +
        (r.source === "outlook" ? " outlook" : ""),
    };
  };

  const dayPropGetter = (d) => {
    const t = new Date();
    const isToday =
      d.getFullYear() === t.getFullYear() &&
      d.getMonth() === t.getMonth() &&
      d.getDate() === t.getDate();
    return isToday ? { className: "cal-day-today" } : {};
  };

  const effectiveView = isMobile ? "agenda" : viewMode;
  const viewsAvailable = isMobile ? ["agenda"] : DESKTOP_VIEWS;

  // Open week/day at the start of the business day so users don't land at 12am.
  const scrollToTime = useMemo(() => {
    const t = new Date();
    t.setHours(7, 0, 0, 0);
    return t;
  }, []);

  return (
    <div className={`cal-shell cal-view-${effectiveView}`}>
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
        step={30}
        timeslots={2}
        scrollToTime={scrollToTime}
        components={{
          event: EventBlock,                  // month + fallback
          toolbar: (props) => (
            <CalendarToolbar
              {...props}
              viewsAvailable={viewsAvailable}
              onSyncNow={onSyncNow}
              isAdmin={isAdmin}
              syncing={syncing}
            />
          ),
          week:   { event: TimeBlockEvent },  // tall card for time-grid views
          day:    { event: TimeBlockEvent },
          agenda: { event: AgendaEventRow },
        }}
        onSelectEvent={(e) => onOpenDrawer && onOpenDrawer(e.resource)}
        onSelectSlot={(slot) =>
          onCreateAtSlot && onCreateAtSlot({ start: slot.start, end: slot.end })
        }
        formats={{
          monthHeaderFormat:    (d, _c, l) => l.format(d, "MMMM yyyy"),
          dayHeaderFormat:      (d, _c, l) => l.format(d, "EEEE · MMM d"),
          dayRangeHeaderFormat: ({ start, end }, _c, l) =>
            `${l.format(start, "MMM d")} — ${l.format(end, "MMM d, yyyy")}`,
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
            `${l.format(start, "MMM d")} — ${l.format(end, "MMM d, yyyy")}`,
        }}
        messages={{ noEventsInRange: "No events scheduled in this range." }}
        length={30}
      />
    </div>
  );
}

export default EventsCalendar;
