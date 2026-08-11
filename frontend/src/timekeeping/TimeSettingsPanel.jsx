// TimeSettingsPanel — admin-only knobs for the timekeeping system. Writes
// land on the singleton beacon_v2.app_settings row.

import React, { useEffect, useId, useState } from "react";
import { Icon } from "@/icons";
import {
  Alert, Button, Field, Input, Separator, Skeleton, Switch, Textarea,
} from "@/ui";
import { loadTimekeepingSettings, updateTimekeepingSettings } from "../data";

export function TimeSettingsPanel() {
  const [s, setS] = useState(null);
  const [busy, setBusy] = useState(false);
  const [msg,  setMsg]  = useState(null);
  const [err,  setErr]  = useState(null);
  const id = useId();

  useEffect(() => {
    let live = true;
    loadTimekeepingSettings().then(d => { if (live) setS(d); });
    return () => { live = false; };
  }, []);

  if (!s) {
    return (
      <div className="tka-settings" aria-busy="true">
        <Skeleton className="h-5 w-40"/>
        <Skeleton className="h-14 w-full"/>
        <Skeleton className="h-14 w-full"/>
        <Skeleton className="h-44 w-full"/>
        <span className="sr-only">Loading settings</span>
      </div>
    );
  }

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
    <div className="tka-settings">
      <header className="tka-sectionhead">
        <div className="tka-sectionhead-titles">
          <h3 className="tka-sectionhead-title">Timekeeping settings</h3>
          <p className="tka-sectionhead-sub">
            These values drive the punch endpoint, the rule classifier, and the alerts admins receive.
          </p>
        </div>
      </header>

      {/* ---- switches ---- */}
      <section className="tka-settings-block">
        <div className="tka-toggle">
          <Switch
            id={`${id}-enabled`}
            checked={!!s.tk_enabled}
            onCheckedChange={(v) => set("tk_enabled", v)}
          />
          <label className="tka-toggle-text" htmlFor={`${id}-enabled`}>
            <span className="tka-toggle-title">Timekeeping enabled</span>
            <span className="tka-toggle-sub">
              Turning this off pauses the punch endpoint and hides the personal Timesheet tab.
            </span>
          </label>
        </div>

        <div className="tka-toggle">
          <Switch
            id={`${id}-autoout`}
            checked={s.tk_auto_punchout_enabled !== false}
            onCheckedChange={(v) => set("tk_auto_punchout_enabled", v)}
          />
          <label className="tka-toggle-text" htmlFor={`${id}-autoout`}>
            <span className="tka-toggle-title">Auto punch-out at end of day</span>
            <span className="tka-toggle-sub">
              Anyone still clocked in when the EOD window ends (below) is punched out
              automatically and marked done for the day.
            </span>
          </label>
        </div>
      </section>

      <Separator/>

      {/* ---- day shape ---- */}
      <section className="tka-settings-block">
        <h4 className="tka-settings-legend">Business day</h4>
        <div className="tka-settings-grid">
          <Field label="Business timezone" htmlFor={`${id}-tz`}>
            <Input
              id={`${id}-tz`}
              value={s.tk_business_tz || ""}
              onChange={e => set("tk_business_tz", e.target.value)}
            />
          </Field>
          <Field label="Workday (hours)" htmlFor={`${id}-workday`}>
            <Input
              id={`${id}-workday`}
              type="number" min={1} max={24} step={0.25}
              className="num"
              value={s.tk_workday_hours ?? 8}
              onChange={e => set("tk_workday_hours", e.target.value)}
            />
          </Field>
          <Field label="Overtime threshold (min/day)" htmlFor={`${id}-ot`}>
            <Input
              id={`${id}-ot`}
              type="number" min={120} max={960} step={15}
              className="num"
              value={s.tk_overtime_threshold_min ?? 480}
              onChange={e => set("tk_overtime_threshold_min", e.target.value)}
            />
          </Field>
        </div>
      </section>

      <Separator/>

      {/* ---- classifier windows ---- */}
      <section className="tka-settings-block">
        <h4 className="tka-settings-legend">Classifier windows</h4>
        <div className="tka-settings-grid">
          <Field
            label="EOD window start (CT)"
            htmlFor={`${id}-eods`}
            hint="Closed gaps starting at or after this hour are tagged as eod."
          >
            <Input
              id={`${id}-eods`}
              type="time" className="num"
              value={s.tk_eod_window_start || "16:00"}
              onChange={e => set("tk_eod_window_start", e.target.value)}
            />
          </Field>
          <Field label="EOD window end (CT)" htmlFor={`${id}-eode`}>
            <Input
              id={`${id}-eode`}
              type="time" className="num"
              value={s.tk_eod_window_end || "19:00"}
              onChange={e => set("tk_eod_window_end", e.target.value)}
            />
          </Field>
          <Field label="Lunch window start (CT)" htmlFor={`${id}-lunchs`}>
            <Input
              id={`${id}-lunchs`}
              type="time" className="num"
              value={s.tk_lunch_window_start || "11:30"}
              onChange={e => set("tk_lunch_window_start", e.target.value)}
            />
          </Field>
          <Field label="Lunch window end (CT)" htmlFor={`${id}-lunche`}>
            <Input
              id={`${id}-lunche`}
              type="time" className="num"
              value={s.tk_lunch_window_end || "13:30"}
              onChange={e => set("tk_lunch_window_end", e.target.value)}
            />
          </Field>
        </div>
      </section>

      <Separator/>

      {/* ---- alerts + buffers ---- */}
      <section className="tka-settings-block">
        <h4 className="tka-settings-legend">Alerts and buffers</h4>
        <div className="tka-settings-grid">
          <Field label="Untagged-meeting alert delay (min)" htmlFor={`${id}-untagged`}>
            <Input
              id={`${id}-untagged`}
              type="number" min={5} max={240} step={5}
              className="num"
              value={s.tk_untagged_alert_after_min ?? 30}
              onChange={e => set("tk_untagged_alert_after_min", e.target.value)}
            />
          </Field>
          <Field label="Default travel buffer per meeting (min)" htmlFor={`${id}-travel`}>
            <Input
              id={`${id}-travel`}
              type="number" min={0} max={120} step={5}
              className="num"
              value={s.tk_default_travel_buffer_min ?? 30}
              onChange={e => set("tk_default_travel_buffer_min", e.target.value)}
            />
          </Field>
        </div>

        <Field
          label="Company holidays"
          htmlFor={`${id}-holidays`}
          hint="One per line, formatted YYYY-MM-DD. Anything that is not a valid date is dropped on save."
          className="tka-settings-wide"
        >
          <Textarea
            id={`${id}-holidays`}
            rows={3}
            className="num"
            value={(s.tk_holidays || []).join("\n")}
            onChange={e => set("tk_holidays", e.target.value.split(/\s+/).filter(Boolean))}
          />
        </Field>
      </section>

      <div className="tka-settings-foot">
        <Button variant="primary" onClick={save} disabled={busy} loading={busy}>
          {busy ? "Saving" : "Save settings"}
        </Button>
        {msg && (
          <span className="tka-savedok" role="status">
            <Icon name="checkCircle" size={14}/> {msg}
          </span>
        )}
      </div>

      {err && <Alert tone="danger" title="Could not save">{err}</Alert>}

      <Alert tone="info" title="Timezone changes stop at the trigger layer">
        The DB trigger functions (fn_classify_interval, fn_recompute_day) still hardcode
        "America/Chicago". Changing the business timezone here updates the UI and the Edge
        Function classifier only. Open a migration when a different timezone has to apply
        at the trigger layer.
      </Alert>
    </div>
  );
}

function normalizeHolidays(arr) {
  return (arr || [])
    .map(s => String(s || "").trim())
    .filter(s => /^\d{4}-\d{2}-\d{2}$/.test(s));
}
