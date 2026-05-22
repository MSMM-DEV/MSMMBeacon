// TimeAdminTab — admin-only shell for the timekeeping system.
// View picker:  Team day · Approvals · NFC enrollment · Settings.
//
// A "Reclassify now" button kicks the timeclock-classify Edge Function
// against the current view so the admin can see the impact of a settings
// change immediately.

import React, { useState } from "react";
import { Icon } from "../icons";
import { todayInCT, tkRunClassifier } from "../data";
import { TeamDayView }      from "./TeamDayView";
import { ApprovalsQueue }   from "./ApprovalsQueue";
import { NfcEnrollPanel }   from "./NfcEnrollPanel";
import { TimeSettingsPanel} from "./TimeSettingsPanel";

const VIEWS = [
  { key: "day",       label: "Team day",        icon: "users" },
  { key: "approvals", label: "Approvals",       icon: "check" },
  { key: "nfc",       label: "NFC enrollment",  icon: "link" },
  { key: "settings",  label: "Settings",        icon: "settings" },
];

export function TimeAdminTab({ onOpenUserDay }) {
  const [view, setView] = useState("day");
  const [date, setDate] = useState(todayInCT());
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

  return (
    <div className="tk-admin-page">
      <header className="tk-admin-head">
        <nav className="tk-admin-nav">
          {VIEWS.map(v => (
            <button key={v.key}
              className={`tk-admin-tab ${view === v.key ? "is-active" : ""}`}
              onClick={() => setView(v.key)}>
              <Icon name={v.icon} size={13}/> {v.label}
            </button>
          ))}
        </nav>
        <div className="tk-admin-tools">
          {reMsg && <span className="tk-admin-msg">{reMsg}</span>}
          <button className="btn btn-ghost btn-sm" onClick={runReclassify} disabled={reBusy}>
            <Icon name="sparkles" size={13}/> {reBusy ? "Running…" : "Reclassify now"}
          </button>
        </div>
      </header>

      <div className="tk-admin-body">
        {view === "day"       && <TeamDayView date={date} onDate={setDate} onUserDay={onOpenUserDay}/>}
        {view === "approvals" && <ApprovalsQueue/>}
        {view === "nfc"       && <NfcEnrollPanel/>}
        {view === "settings"  && <TimeSettingsPanel/>}
      </div>
    </div>
  );
}
