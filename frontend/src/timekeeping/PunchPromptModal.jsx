// PunchPromptModal — opens immediately after a PUNCH IN or PUNCH OUT so the
// user can attach a category + note while the context is fresh.
//
// Both variants tag the NEWLY-OPENED interval (every punch opens one):
//   kind="in"  → "What are you starting?"  — tags the new IN (at-desk) interval
//   kind="out" → "Where are you headed?"   — tags the new OUT (away) interval,
//                so the label describes the away period you just started, never
//                the at-desk session you just closed.
//
// Skip is always allowed; the interval keeps its rule-classified default.
// Save writes via setIntervalCategory (always sets category_source='user' so
// the classifier won't overwrite it).
//
// Visual: bottom-sheet on phones (inherits the .modal-narrow phone treatment
// added in the mobile-responsive pass), centered card on desktop. Hero
// category chip-grid replaces the dropdown so picks are one-tap on touch.

import React, { useEffect, useState } from "react";
import { Icon } from "../icons";
import {
  fmtClock, setIntervalCategory,
  TK_CATEGORY_LABEL, TK_CATEGORY_TONE,
} from "../data";

// Ordered to match the punch-context. A punch-in starts an IN interval; a
// punch-out starts an OUT interval. Meeting is available in both contexts.
const IN_CATEGORY_CHOICES = [
  { key: "work",             label: "Working"          },
  { key: "meeting",          label: "Meeting"          },
];

const OUT_CATEGORY_CHOICES = [
  { key: "meeting",          label: "Meeting"          },
  { key: "travel",           label: "Site visit"       },
  { key: "lunch",            label: "Lunch"            },
  { key: "break",            label: "Break"            },
  { key: "vacation",         label: "Vacation"         },
  { key: "eod",              label: "Done for the day" },   // stops the red overlay
];

const CATEGORY_ICON = {
  work: "briefcase",
  meeting: "users",
  travel: "pin",
  lunch: "utensils",
  break: "pause",
  vacation: "sun",
  eod: "logout",
};

function choicesForKind(kind) {
  return kind === "in" ? IN_CATEGORY_CHOICES : OUT_CATEGORY_CHOICES;
}

// Preselect a sensible chip. A freshly-opened OUT interval arrives tagged
// 'meeting_untagged' (a placeholder, not a real choice) — default it to
// "Meeting"; a fresh IN interval defaults to "Working". When re-opening an
// already-tagged interval, keep its real category.
function defaultCategory(kind, interval) {
  const c = interval?.category;
  const keys = new Set(choicesForKind(kind).map(choice => choice.key));
  if (c && keys.has(c)) return c;
  return kind === "in" ? "work" : "meeting";
}

export function PunchPromptModal({
  kind,             // 'in' | 'out'
  interval,         // adapted interval (the one to update)
  userName = "there",
  onClose,          // () => void
  onSaved,          // () => void — parent re-fetches after success
}) {
  const [category, setCategory] = useState(defaultCategory(kind, interval));
  const [notes,    setNotes]    = useState(interval?.notes || "");
  const [busy,     setBusy]     = useState(false);
  const [err,      setErr]      = useState(null);

  // Re-sync when the interval prop changes (e.g. parent re-opens for a new punch).
  useEffect(() => {
    setCategory(defaultCategory(kind, interval));
    setNotes(interval?.notes || "");
    setErr(null);
  }, [interval?.id]);

  // Close on Escape.
  useEffect(() => {
    const onKey = (e) => { if (e.key === "Escape") onClose?.(); };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [onClose]);

  if (!interval) return null;

  const displayName = String(userName || "").trim() || "there";

  const headline = kind === "in"
    ? "What are you starting?"
    : "Where are you headed?";

  const eyebrow = kind === "in"
    ? `You are now clocked in, ${displayName} · ${fmtClock(interval.startAt)}`
    : `You are now clocked out, ${displayName} · ${fmtClock(interval.startAt)}`;

  const save = async () => {
    setBusy(true); setErr(null);
    try {
      await setIntervalCategory(interval.id, {
        category,
        notes: notes.trim() || null,
        outlookEventId: interval.outlookEventId || null,
        interval,
      });
      onSaved?.();
      onClose?.();
    } catch (e) {
      setErr(e?.message || "could not save");
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal modal-narrow tk-punch-prompt" onClick={e => e.stopPropagation()}
        role="dialog" aria-modal="true" aria-labelledby="tk-punch-prompt-title">
        <div className="modal-head">
          <div style={{ flex: 1, minWidth: 0 }}>
            <div className="modal-eyebrow">{eyebrow}</div>
            <h3 className="modal-title" id="tk-punch-prompt-title">{headline}</h3>
          </div>
          <button className="modal-close" onClick={onClose} aria-label="Close">
            <Icon name="x" size={16}/>
          </button>
        </div>
        <div className="modal-body">
          {/* Hero chip grid — one-tap category pick on touch */}
          <div className="tk-prompt-grid" role="radiogroup" aria-label="Category">
            {choicesForKind(kind).map(c => (
              <button
                key={c.key}
                type="button"
                role="radio"
                aria-checked={category === c.key}
                className={`tk-prompt-chip tone-${TK_CATEGORY_TONE[c.key] || "muted"} ${category === c.key ? "is-active" : ""}`}
                onClick={() => setCategory(c.key)}
              >
                <span className="tk-prompt-chip-icon" aria-hidden="true">
                  <Icon name={CATEGORY_ICON[c.key] || "note"} size={16} />
                </span>
                {c.label}
              </button>
            ))}
          </div>
          <div className={`tk-prompt-presence ${kind === "in" ? "is-in" : "is-out"}`}>
            <span className="tk-prompt-presence-dot" />
            {kind === "in"
              ? "Saved as in-time unless you later mark this meeting as away."
              : "This starts an away-time block. You can edit the category later if plans change."}
          </div>

          <div className="form-row">
            <label className="form-label" htmlFor="tk-prompt-notes">
              Add a note <span className="form-label-soft">(optional)</span>
            </label>
            <textarea
              id="tk-prompt-notes"
              className="form-input"
              rows={3}
              maxLength={400}
              placeholder={kind === "in"
                ? "What are you working on? (you can edit this later)"
                : "Any context worth keeping for the record?"}
              value={notes}
              onChange={e => setNotes(e.target.value)}
            />
          </div>

          {err && <div className="form-error" role="alert">{err}</div>}
        </div>
        <div className="modal-foot">
          <button type="button" className="btn btn-ghost" onClick={onClose} disabled={busy}>
            Skip
          </button>
          <button type="button" className="btn btn-primary" onClick={save} disabled={busy}>
            {busy ? "Saving…" : (kind === "in" ? "Save & start" : "Save")}
          </button>
        </div>
      </div>
    </div>
  );
}
