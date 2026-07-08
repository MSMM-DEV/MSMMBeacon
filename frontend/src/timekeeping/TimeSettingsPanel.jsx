// TimeSettingsPanel — admin-only knobs for the timekeeping system. Writes
// land on the singleton beacon_v2.app_settings row.

import React, { useEffect, useState } from "react";
import { Icon } from "../icons";
import { loadTimekeepingSettings, updateTimekeepingSettings } from "../data";

export function TimeSettingsPanel() {
  const [s, setS] = useState(null);
  const [busy, setBusy] = useState(false);
  const [msg,  setMsg]  = useState(null);
  const [err,  setErr]  = useState(null);

  useEffect(() => {
    let live = true;
    loadTimekeepingSettings().then(d => { if (live) setS(d); });
    return () => { live = false; };
  }, []);

  if (!s) return <div className="page-empty">Loading settings…</div>;

  const set = (k, v) => setS(prev => ({ ...prev, [k]: v }));

  const save = async () => {
    setBusy(true); setErr(null); setMsg(null);
    try {
      await updateTimekeepingSettings({
        tk_enabled:                  !!s.tk_enabled,
        tk_auto_punchout_enabled:    !!s.tk_auto_punchout_enabled,
        tk_business_tz:              String(s.tk_business_tz || "America/Chicago"),
        tk_workday_hours:            Number(s.tk_workday_hours) || 8,
        tk_overtime_threshold_min:   parseInt(s.tk_overtime_threshold_min, 10) || 480,
        tk_eod_window_start:         s.tk_eod_window_start,
        tk_eod_window_end:           s.tk_eod_window_end,
        tk_lunch_window_start:       s.tk_lunch_window_start,
        tk_lunch_window_end:         s.tk_lunch_window_end,
        tk_untagged_alert_after_min: parseInt(s.tk_untagged_alert_after_min, 10) || 30,
        tk_default_travel_buffer_min:parseInt(s.tk_default_travel_buffer_min, 10) || 30,
        tk_holidays:                 normalizeHolidays(s.tk_holidays),
      });
      setMsg("Saved.");
    } catch (e) {
      setErr(e.message || "save failed");
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="tk-settings">
      <header className="tk-section-head">
        <h3>Settings</h3>
      </header>

      <label className="tk-settings-toggle">
        <input type="checkbox" checked={!!s.tk_enabled}
          onChange={e => set("tk_enabled", e.target.checked)}/>
        <span><strong>Timekeeping enabled</strong> — turning off pauses the punch endpoint and hides the personal tab.</span>
      </label>

      <label className="tk-settings-toggle">
        <input type="checkbox" checked={s.tk_auto_punchout_enabled !== false}
          onChange={e => set("tk_auto_punchout_enabled", e.target.checked)}/>
        <span><strong>Auto punch-out at end of day</strong> — anyone still clocked in when the EOD window ends (below) is automatically punched out and marked <em>done for the day</em>.</span>
      </label>

      <div className="tk-settings-grid">
        <div className="form-row">
          <label className="form-label">Business timezone</label>
          <input className="form-input" value={s.tk_business_tz || ""}
            onChange={e => set("tk_business_tz", e.target.value)}/>
        </div>
        <div className="form-row">
          <label className="form-label">Workday (hours)</label>
          <input type="number" min={1} max={24} step={0.25} className="form-input"
            value={s.tk_workday_hours ?? 8}
            onChange={e => set("tk_workday_hours", e.target.value)}/>
        </div>
        <div className="form-row">
          <label className="form-label">Overtime threshold (min/day)</label>
          <input type="number" min={120} max={960} step={15} className="form-input"
            value={s.tk_overtime_threshold_min ?? 480}
            onChange={e => set("tk_overtime_threshold_min", e.target.value)}/>
        </div>
        <div className="form-row">
          <label className="form-label">EOD window start (CT)</label>
          <input type="time" className="form-input"
            value={s.tk_eod_window_start || "16:00"}
            onChange={e => set("tk_eod_window_start", e.target.value)}/>
          <p className="form-help">Closed gaps starting at or after this hour are tagged as <em>eod</em> by the rule classifier.</p>
        </div>
        <div className="form-row">
          <label className="form-label">EOD window end (CT)</label>
          <input type="time" className="form-input"
            value={s.tk_eod_window_end || "19:00"}
            onChange={e => set("tk_eod_window_end", e.target.value)}/>
        </div>
        <div className="form-row">
          <label className="form-label">Lunch window start (CT)</label>
          <input type="time" className="form-input"
            value={s.tk_lunch_window_start || "11:30"}
            onChange={e => set("tk_lunch_window_start", e.target.value)}/>
        </div>
        <div className="form-row">
          <label className="form-label">Lunch window end (CT)</label>
          <input type="time" className="form-input"
            value={s.tk_lunch_window_end || "13:30"}
            onChange={e => set("tk_lunch_window_end", e.target.value)}/>
        </div>
        <div className="form-row">
          <label className="form-label">Untagged-meeting alert delay (min)</label>
          <input type="number" min={5} max={240} step={5} className="form-input"
            value={s.tk_untagged_alert_after_min ?? 30}
            onChange={e => set("tk_untagged_alert_after_min", e.target.value)}/>
        </div>
        <div className="form-row">
          <label className="form-label">Default travel buffer per meeting (min)</label>
          <input type="number" min={0} max={120} step={5} className="form-input"
            value={s.tk_default_travel_buffer_min ?? 30}
            onChange={e => set("tk_default_travel_buffer_min", e.target.value)}/>
        </div>
        <div className="form-row" style={{ gridColumn: "1 / -1" }}>
          <label className="form-label">Company holidays (one per line, YYYY-MM-DD)</label>
          <textarea className="form-input" rows={3}
            value={(s.tk_holidays || []).join("\n")}
            onChange={e => set("tk_holidays", e.target.value.split(/\s+/).filter(Boolean))}/>
        </div>
      </div>

      <div className="tk-settings-foot">
        <button className="btn btn-primary" onClick={save} disabled={busy}>
          {busy ? "Saving…" : "Save settings"}
        </button>
        {msg && <span className="form-ok"><Icon name="check" size={13}/> {msg}</span>}
        {err && <div className="form-error">{err}</div>}
      </div>

      <aside className="tk-settings-note">
        <strong>Note:</strong> The DB trigger functions (fn_classify_interval,
        fn_recompute_day) currently hardcode "America/Chicago". Changing the
        business timezone here updates the UI and the Edge Function classifier
        but not the trigger functions — open a migration when you need a
        different tz applied at the trigger layer.
      </aside>
    </div>
  );
}

function normalizeHolidays(arr) {
  return (arr || [])
    .map(s => String(s || "").trim())
    .filter(s => /^\d{4}-\d{2}-\d{2}$/.test(s));
}
