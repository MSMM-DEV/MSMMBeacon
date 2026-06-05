// TimeAdminTab — admin-only shell for the timekeeping system.
//
// View picker: Team · Approvals · NFC enrollment · Settings
//
// Within Team, the user chooses a range mode (Day / Week / Month / Custom)
// and which people are visible. All of this is persisted per-admin via
// localStorage (useAdminTimePrefs) so refreshing the page returns the admin
// to exactly the same view they left.
//
// A small "Reclassify now" button kicks the timeclock-classify Edge Function
// against the current admin so the impact of a settings change is visible.

import React, { useState, useEffect, useMemo, useCallback } from "react";
import { Icon } from "../icons";
import {
  todayInCT, tkRunClassifier, getCurrentBeaconUser, loadTeamDay,
} from "../data";
import { useAdminTimePrefs } from "./useAdminTimePrefs";
import { TeamRangeView }     from "./TeamRangeView";
import { PeopleFilter }      from "./PeopleFilter";
import { NfcEnrollPanel }    from "./NfcEnrollPanel";
import { TimeSettingsPanel } from "./TimeSettingsPanel";
import { UserDayModal }      from "./UserDayModal";

// Approval was retired (everyone edits their own time directly), so there's no
// Approvals view anymore. Admins can still open & edit anyone's day from Team.
const VIEWS = [
  { key: "team",      label: "Team",            icon: "users" },
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
    <div className="tk-admin-page">
      {/* Top nav — tabs + global tools */}
      <header className="tk-admin-head">
        <nav className="tk-admin-nav" aria-label="Admin sections">
          {VIEWS.map(v => (
            <button key={v.key} type="button"
              className={`tk-admin-tab ${view === v.key ? "is-active" : ""}`}
              onClick={() => setView(v.key)}
              aria-current={view === v.key ? "page" : undefined}>
              <Icon name={v.icon} size={13}/> {v.label}
            </button>
          ))}
        </nav>
        <div className="tk-admin-tools">
          {reMsg && <span className="tk-admin-msg">{reMsg}</span>}
          <button type="button" className="btn btn-ghost btn-sm" onClick={runReclassify} disabled={reBusy}>
            <Icon name="sparkles" size={13}/> {reBusy ? "Running…" : "Reclassify now"}
          </button>
        </div>
      </header>

      {/* Team-specific control bar — range selector, search, people filter */}
      {view === "team" && (
        <div className="tk-admin-controls">
          <div className="tk-admin-controls-left">
            <SegmentedRange value={prefs.range} onChange={setRange}/>
          </div>
          <div className="tk-admin-controls-right">
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
      )}

      {/* Body */}
      <div className="tk-admin-body">
        {view === "team" && (
          <TeamRangeView
            prefs={prefs}
            onPrefsChange={updatePrefs}
            dataVersion={dataVersion}
            onOpenUserDay={openUserDay}
          />
        )}
        {view === "nfc"       && <NfcEnrollPanel/>}
        {view === "settings"  && <TimeSettingsPanel/>}
      </div>

      {userDay && (
        <UserDayModal
          userId={userDay.userId}
          initialDate={userDay.date}
          onClose={() => setUserDay(null)}
          onDirty={bumpData}
        />
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Sub-components: segmented range picker, search, density toggle
// ---------------------------------------------------------------------------

function SegmentedRange({ value, onChange }) {
  return (
    <div className="tk-segmented" role="tablist" aria-label="Range">
      {RANGES.map(r => (
        <button key={r.key} type="button" role="tab"
          aria-selected={value === r.key}
          className={`tk-segmented-btn ${value === r.key ? "is-active" : ""}`}
          onClick={() => onChange(r.key)}>
          {r.label}
        </button>
      ))}
    </div>
  );
}

function SearchBox({ value, onChange }) {
  return (
    <label className="tk-search-box">
      <Icon name="search" size={13}/>
      <input
        type="search"
        className="tk-search-input"
        placeholder="Search names…"
        value={value || ""}
        onChange={e => onChange(e.target.value)}
      />
      {value && (
        <button type="button" className="tk-search-clear"
          onClick={() => onChange("")} aria-label="Clear search">
          <Icon name="x" size={11}/>
        </button>
      )}
    </label>
  );
}

function DensityToggle({ value, onChange }) {
  const next = value === "compact" ? "comfortable" : "compact";
  return (
    <button
      type="button"
      className={`tk-density-btn ${value === "compact" ? "is-compact" : ""}`}
      onClick={() => onChange(next)}
      title={`Switch to ${next} density`}
      aria-label={`Switch to ${next} density`}
    >
      <Icon name={value === "compact" ? "columns" : "more"} size={13}/>
    </button>
  );
}
