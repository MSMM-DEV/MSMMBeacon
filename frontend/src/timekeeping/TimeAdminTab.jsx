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

  // Lightweight signals fetch: who's currently in / active today. Used by
  // the PeopleFilter for "Currently in" + "Active today" quick-picks.
  // Cheap query (today's snapshot only) so it can run on every tab open.
  const [signals, setSignals] = useState({ activeToday: new Set(), currentlyIn: new Set() });
  useEffect(() => {
    if (view !== "team") return;
    let cancelled = false;
    (async () => {
      try {
        const rows = await loadTeamDay(todayInCT());
        if (cancelled) return;
        const at = new Set(), ci = new Set();
        for (const r of rows) {
          if (r.intervals.length > 0) at.add(r.user.id);
          if (r.intervals.some(i => !i.endAt && !i.isOut)) ci.add(r.user.id);
        }
        setSignals({ activeToday: at, currentlyIn: ci });
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
