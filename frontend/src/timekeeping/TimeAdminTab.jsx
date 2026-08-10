// TimeAdminTab — admin-only shell for the timekeeping system.
//
// View picker: Team · Leaves · NFC enrollment · Settings
//
// Within Team, the user chooses a range mode (Day / Week / Month / Custom)
// and which people are visible. All of this is persisted per-admin via
// localStorage (useAdminTimePrefs) so refreshing the page returns the admin
// to exactly the same view they left.
//
// A small "Reclassify now" button kicks the timeclock-classify Edge Function
// against the current admin so the impact of a settings change is visible.

import React, { useState, useEffect, useCallback } from "react";
import { Icon } from "@/icons";
import {
  Button, InputGroup, Tabs, TabsList, TabsTrigger, TabsContent,
  Tooltip, TooltipProvider,
} from "@/ui";
import {
  todayInCT, tkRunClassifier, getCurrentBeaconUser, loadTeamDay,
} from "../data";
import {
  livePresence, PRESENCE_IN, PRESENCE_OUT,
} from "../timekeeping-presence.js";
import { useAdminTimePrefs } from "./useAdminTimePrefs";
import { TeamRangeView }     from "./TeamRangeView";
import { PeopleFilter }      from "./PeopleFilter";
import { NfcEnrollPanel }    from "./NfcEnrollPanel";
import { TimeSettingsPanel } from "./TimeSettingsPanel";
import { UserDayModal }      from "./UserDayModal";
import { LeavesPanel }       from "./LeavesPanel";

// Approval was retired (everyone edits their own time directly), so there's no
// Approvals view anymore. Admins can still open & edit anyone's day from Team.
// Leaves carries the leave-request queue + team balances.
const VIEWS = [
  { key: "team",      label: "Team",            icon: "users" },
  { key: "leaves",    label: "Leaves",          icon: "calendar" },
  { key: "nfc",       label: "NFC enrollment",  icon: "link" },
  { key: "settings",  label: "Settings",        icon: "settings" },
];

const RANGES = [
  { key: "day",    label: "Day"    },
  { key: "week",   label: "Week"   },
  { key: "month",  label: "Month"  },
  { key: "custom", label: "Custom" },
];

export function TimeAdminTab({ onOpenUserDay }) {
  const me      = getCurrentBeaconUser();
  const adminId = me?.id;

  const [view, setView]     = useState("team");
  const [prefs, updatePrefs] = useAdminTimePrefs(adminId);
  const [userDay, setUserDay] = useState(null);   // { userId, date } | null

  // Bumped by the Day editor after a direct admin edit so the Team canvas +
  // people signals refetch on change/close.
  const [dataVersion, setDataVersion] = useState(0);

  // Stable open-user-day handler used by the Team canvas.
  const openUserDay = useCallback((payload) => {
    setUserDay(payload);
    onOpenUserDay?.(payload);   // allow parent to mirror the focus too
  }, [onOpenUserDay]);

  // Bumped by the Day editor after any direct edit, so the Team canvas and
  // people signals all refetch on close/change.
  const bumpData = useCallback(() => setDataVersion(v => v + 1), []);

  // Lightweight signals fetch: who's active today, and each person's live
  // punch state. Used by the PeopleFilter quick-picks and by the In/Out
  // filter. Cheap query (today's snapshot only) so it can run on every tab
  // open.
  //
  // This is the ONLY source for live presence, deliberately. `loadTeamRange`
  // fetches open intervals with `is_out = false` only, so a Week/Month row
  // can tell you somebody is IN but cannot tell "punched out" apart from
  // "never punched today" — and those are different answers to "who is out".
  // Reading presence here means the filter means the same thing in every
  // range, and the same thing the In chip does.
  const [signals, setSignals] = useState({
    activeToday: new Set(), currentlyIn: new Set(), currentlyOut: new Set(),
  });
  useEffect(() => {
    if (view !== "team") return;
    let cancelled = false;
    (async () => {
      try {
        const rows = await loadTeamDay(todayInCT());
        if (cancelled) return;
        const at = new Set(), ci = new Set(), co = new Set();
        for (const r of rows) {
          if (r.intervals.length > 0) at.add(r.user.id);
          // `livePresence` is the ONE rule — see timekeeping-presence.js. The
          // In chip on the row reads the same function, which is what stops a
          // person showing an "In" chip while the filter counts them as Out.
          const p = livePresence(r.intervals);
          if (p === PRESENCE_IN)  ci.add(r.user.id);
          if (p === PRESENCE_OUT) co.add(r.user.id);
        }
        setSignals({ activeToday: at, currentlyIn: ci, currentlyOut: co });
      } catch { /* non-critical */ }
    })();
    return () => { cancelled = true; };
  }, [view, prefs.anchorDate, prefs.range, dataVersion]);

  const [reBusy, setReBusy] = useState(false);
  const [reMsg,  setReMsg]  = useState(null);

  const runReclassify = async () => {
    setReBusy(true); setReMsg(null);
    try {
      const { data } = await tkRunClassifier();
      const tagged = data?.intervals_tagged ?? 0;
      const alerts = data?.alerts_inserted  ?? 0;
      setReMsg(`Tagged ${tagged} intervals · ${alerts} alerts queued.`);
    } catch (e) {
      setReMsg(`Failed: ${e.message || e}`);
    } finally {
      setReBusy(false);
      setTimeout(() => setReMsg(null), 6000);
    }
  };

  const setRange = useCallback((next) => {
    // When jumping to a range, anchor it sensibly relative to today.
    const t = todayInCT();
    updatePrefs(prev => {
      const patch = { range: next };
      if (!prev.anchorDate) patch.anchorDate = t;
      if (next === "custom") {
        if (!prev.customStart) patch.customStart = t;
        if (!prev.customEnd)   patch.customEnd   = t;
      }
      return patch;
    });
  }, [updatePrefs]);

  return (
    <TooltipProvider delayDuration={280}>
      <div className="tka">
        <Tabs value={view} onValueChange={setView} className="flex min-w-0 flex-col gap-5">

          {/* Section switcher + global tools, sharing one hairline. */}
          <div className="tka-tabbar">
            <TabsList aria-label="Admin sections" className="tka-tablist border-b-0">
              {VIEWS.map(v => (
                <TabsTrigger key={v.key} value={v.key}>
                  <Icon name={v.icon} size={15}/>
                  <span>{v.label}</span>
                </TabsTrigger>
              ))}
            </TabsList>

            <div className="tka-tabtools">
              {reMsg && (
                <span className="tka-toolmsg" role="status">{reMsg}</span>
              )}
              <Button
                variant="default"
                size="sm"
                onClick={runReclassify}
                disabled={reBusy}
                loading={reBusy}
              >
                {!reBusy && <Icon name="bolt" size={14}/>}
                {reBusy ? "Running" : "Reclassify now"}
              </Button>
            </div>
          </div>

          <TabsContent value="team" className="flex min-w-0 flex-col gap-4">
            {/* Team-specific control bar — range selector, search, people filter */}
            <div className="tka-controls">
              <Tabs value={prefs.range} onValueChange={setRange} className="min-w-0">
                <TabsList variant="segmented" aria-label="Range">
                  {RANGES.map(r => (
                    <TabsTrigger key={r.key} value={r.key}>{r.label}</TabsTrigger>
                  ))}
                </TabsList>
              </Tabs>

              <div className="tka-controls-right">
                <PresenceFilter
                  value={prefs.presence || "all"}
                  onChange={(v) => updatePrefs({ presence: v })}
                />
                <SearchBox
                  value={prefs.search}
                  onChange={(v) => updatePrefs({ search: v })}
                />
                <PeopleFilter
                  visibleUsers={prefs.visibleUsers}
                  onChange={(next) => updatePrefs({ visibleUsers: next })}
                  signals={signals}
                />
                <DensityToggle
                  value={prefs.density}
                  onChange={(v) => updatePrefs({ density: v })}
                />
              </div>
            </div>

            <TeamRangeView
              prefs={prefs}
              onPrefsChange={updatePrefs}
              dataVersion={dataVersion}
              onOpenUserDay={openUserDay}
              signals={signals}
            />
          </TabsContent>

          <TabsContent value="leaves"><LeavesPanel/></TabsContent>
          <TabsContent value="nfc"><NfcEnrollPanel/></TabsContent>
          <TabsContent value="settings"><TimeSettingsPanel/></TabsContent>
        </Tabs>

        {userDay && (
          <UserDayModal
            userId={userDay.userId}
            initialDate={userDay.date}
            onClose={() => setUserDay(null)}
            onDirty={bumpData}
          />
        )}
      </div>
    </TooltipProvider>
  );
}

// ---------------------------------------------------------------------------
// Sub-components: search, density toggle
// ---------------------------------------------------------------------------

function SearchBox({ value, onChange }) {
  return (
    <InputGroup
      type="search"
      className="tka-search sm:w-[230px]"
      aria-label="Search people by name"
      placeholder="Search names"
      value={value || ""}
      onChange={e => onChange(e.target.value)}
      leading={<Icon name="search" size={14}/>}
      trailing={value ? (
        <button
          type="button"
          className="tka-search-clear"
          onClick={() => onChange("")}
          aria-label="Clear search"
        >
          <Icon name="x" size={12}/>
        </button>
      ) : null}
    />
  );
}

// Presence filter — All / In / Out.
//
// A segmented control rather than a dropdown because there are three mutually
// exclusive options and the current one has to be readable at a glance: an
// admin filtered to "In" and then confused about a short roster is the failure
// this shape prevents.
//
// "In" and "Out" are about RIGHT NOW, not about the range on screen — the same
// fact the In chip and the "Currently in" tile report. That is why each option
// carries a tooltip saying so; on a past week the distinction matters.
// "Out" is people whose LAST punch was an OUT — at lunch, on a site visit, or
// done for the day. It is NOT "everyone who isn't in": somebody who has not
// punched at all today never went out, they simply are not here, and folding
// them in makes the count answer a question nobody asked. Those people show
// under All only, which is what the third hint says out loud.
const PRESENCE_OPTIONS = [
  { key: "all", label: "All", hint: "Everyone on the roster" },
  { key: "in",  label: "In",  hint: "Punched in right now" },
  { key: "out", label: "Out", hint: "Punched out right now — at lunch, out on site, or done for the day. People who have not punched at all today are under All." },
];

function PresenceFilter({ value, onChange }) {
  return (
    <Tabs value={value} onValueChange={onChange} className="min-w-0">
      <TabsList variant="segmented" aria-label="Filter by who is in">
        {PRESENCE_OPTIONS.map(o => (
          <Tooltip key={o.key} label={o.hint}>
            <TabsTrigger value={o.key}>
              {o.key === "in" && (
                <span className="tka-livedot" aria-hidden="true"/>
              )}
              {o.label}
            </TabsTrigger>
          </Tooltip>
        ))}
      </TabsList>
    </Tabs>
  );
}

function DensityToggle({ value, onChange }) {
  const next = value === "compact" ? "comfortable" : "compact";
  const label = `Switch to ${next} density`;
  return (
    <Tooltip label={label}>
      <Button
        variant="default"
        size="icon"
        aria-label={label}
        aria-pressed={value === "compact"}
        onClick={() => onChange(next)}
      >
        <Icon name={value === "compact" ? "columns" : "more"} size={15}/>
      </Button>
    </Tooltip>
  );
}
