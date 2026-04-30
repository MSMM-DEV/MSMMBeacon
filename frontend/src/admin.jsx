import React, { useEffect, useMemo, useRef, useState } from "react";
import { Icon } from "./icons.jsx";
import { TweaksPanel } from "./tweaks.jsx";
import { AlertsAdmin } from "./admin-alerts.jsx";
import { listAllUsersFull, adminAction, getUsers, updateMonthlyBenchmark, fmtMoney } from "./data.js";

// ============================================================================
// AdminPanel — gear-icon entry point for Admin users only.
//
// Renders as a right-side drawer (same surface as DetailDrawer). Two tabs:
//   · Users       — roster management (add / change password / ban / role / delete)
//   · Appearance  — embedded TweaksPanel so admins keep their tweaks in one place
//
// All privileged actions go through the admin-users Edge Function. The panel
// re-fetches the full roster after every successful action and calls the
// caller-supplied onRosterChange() so the rest of the app (PM pickers, Quad
// Sheet, etc.) re-renders with the updated roster.
// ============================================================================

export const AdminPanel = ({
  tweaks, setTweak,
  currentUser,
  onClose,
  onRosterChange,
  appSettings,
  onAppSettingsChange,
  alertSubjectLookup = {},
}) => {
  const [tab, setTab] = useState("users");
  const [rows, setRows] = useState([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState("");
  const [q, setQ] = useState("");
  const [toast, setToast] = useState(null);
  const [modal, setModal] = useState(null);   // { kind: "add" | "password" | "delete", row? }

  const refresh = async () => {
    setLoading(true);
    try {
      const data = await listAllUsersFull();
      setRows(data);
      setLoadError("");
      onRosterChange?.();
    } catch (e) {
      setLoadError(String(e.message || e));
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => { refresh(); /* eslint-disable-next-line react-hooks/exhaustive-deps */ }, []);

  const flash = (msg, icon = "check") => {
    setToast({ msg, icon });
    setTimeout(() => setToast(null), 2800);
  };

  const runAction = async (action, payload, successMsg) => {
    try {
      await adminAction(action, payload);
      await refresh();
      flash(successMsg || "Done");
      return true;
    } catch (e) {
      flash(String(e.message || e), "x");
      return false;
    }
  };

  const filtered = useMemo(() => {
    if (!q) return rows;
    const needle = q.toLowerCase();
    return rows.filter(r =>
      (r.email || "").toLowerCase().includes(needle) ||
      (r.display_name || "").toLowerCase().includes(needle) ||
      (r.first_name || "").toLowerCase().includes(needle) ||
      (r.last_name || "").toLowerCase().includes(needle)
    );
  }, [rows, q]);

  const adminCount = rows.filter(r => r.role === "Admin").length;

  return (
    <>
      <div className="overlay" onClick={onClose}/>
      <div className={"drawer admin-drawer" + (tab === "alerts" ? " admin-drawer-wide" : "")}>
        <div className="drawer-head">
          <div>
            <div className="drawer-eyebrow">
              <Icon name="shield" size={12}/>Admin
            </div>
            <h3 className="drawer-title">Workspace settings</h3>
          </div>
          <button className="drawer-close" onClick={onClose}><Icon name="x" size={16}/></button>
        </div>

        <div className="admin-tabs">
          <button className={"admin-tab" + (tab === "users" ? " active" : "")}
                  onClick={() => setTab("users")}>
            <Icon name="users" size={13}/>Users
            <span className="admin-tab-count">{rows.length}</span>
          </button>
          <button className={"admin-tab" + (tab === "alerts" ? " active" : "")}
                  onClick={() => setTab("alerts")}>
            <Icon name="bell" size={13}/>Alerts
          </button>
          <button className={"admin-tab" + (tab === "targets" ? " active" : "")}
                  onClick={() => setTab("targets")}>
            <Icon name="flag" size={13}/>Targets
          </button>
          <button className={"admin-tab" + (tab === "tweaks" ? " active" : "")}
                  onClick={() => setTab("tweaks")}>
            <Icon name="settings" size={13}/>Appearance
          </button>
        </div>

        <div className="drawer-body admin-body">
          {tab === "users" && (
            <>
              <div className="admin-toolbar">
                <div className="admin-search">
                  <Icon name="search" size={13}/>
                  <input
                    placeholder="Search by name or email…"
                    value={q}
                    onChange={e => setQ(e.target.value)}
                  />
                </div>
                <button className="btn primary sm"
                        onClick={() => setModal({ kind: "add" })}>
                  <Icon name="plus" size={13}/>Add user
                </button>
              </div>

              {loadError && (
                <div className="admin-error">
                  <Icon name="x" size={12}/>
                  <span>{loadError}</span>
                </div>
              )}

              {loading && !rows.length && (
                <div className="admin-empty">Loading roster…</div>
              )}

              {!loading && filtered.length === 0 && (
                <div className="admin-empty">No users match your search.</div>
              )}

              <ul className="admin-list">
                {filtered.map(r => (
                  <UserRow
                    key={r.id}
                    row={r}
                    isSelf={r.id === currentUser?.id}
                    isLastAdmin={r.role === "Admin" && adminCount <= 1}
                    onChangePassword={() => setModal({ kind: "password", row: r })}
                    onDelete={() => setModal({ kind: "delete", row: r })}
                    onToggleBan={() =>
                      runAction("set_ban", { beacon_user_id: r.id, banned: r.is_enabled },
                                r.is_enabled ? `${displayName(r)} banned` : `${displayName(r)} unbanned`)
                    }
                    onToggleRole={() =>
                      runAction("set_role",
                                { beacon_user_id: r.id, role: r.role === "Admin" ? "User" : "Admin" },
                                r.role === "Admin" ? `${displayName(r)} demoted to User` : `${displayName(r)} promoted to Admin`)
                    }
                  />
                ))}
              </ul>
            </>
          )}

          {tab === "alerts" && (
            <AlertsAdmin
              subjectLookup={alertSubjectLookup}
              users={getUsers()}
            />
          )}

          {tab === "targets" && (
            <TargetsPanel
              appSettings={appSettings}
              onSaved={(next) => {
                onAppSettingsChange?.(next);
                flash("Benchmark updated");
              }}
              onError={(msg) => flash(msg, "x")}
            />
          )}

          {tab === "tweaks" && (
            <div className="admin-tweaks-wrap">
              <TweaksPanel tweaks={tweaks} setTweak={setTweak} onClose={() => {}}/>
            </div>
          )}
        </div>

      </div>

      {/* Toast lives OUTSIDE the drawer so the sub-modal overlay can't hide
          it — the user needs clear success/failure feedback after every
          admin action, especially since the sub-modal closes on success. */}
      {toast && (
        <div className="admin-toast">
          <span className="toast-icon"><Icon name={toast.icon} size={11} stroke={2.2}/></span>
          {toast.msg}
        </div>
      )}

      {modal?.kind === "add" && (
        <AddUserModal
          onClose={() => setModal(null)}
          onSubmit={async (payload) => {
            const ok = await runAction("create_user", payload, `${payload.first_name} created`);
            if (ok) setModal(null);
          }}
        />
      )}
      {modal?.kind === "password" && (
        <ChangePasswordModal
          row={modal.row}
          onClose={() => setModal(null)}
          onSubmit={async (new_password) => {
            const ok = await runAction("change_password",
              { beacon_user_id: modal.row.id, new_password },
              `Password updated for ${displayName(modal.row)}`);
            if (ok) setModal(null);
          }}
        />
      )}
      {modal?.kind === "delete" && (
        <DeleteUserModal
          row={modal.row}
          onClose={() => setModal(null)}
          onConfirm={async (confirm_email) => {
            const ok = await runAction("delete_user",
              { beacon_user_id: modal.row.id, confirm_email },
              `${displayName(modal.row)} deleted`);
            if (ok) setModal(null);
          }}
        />
      )}
    </>
  );
};

// ----------------------------------------------------------------------------
// User row
// ----------------------------------------------------------------------------
const UserRow = ({ row, isSelf, isLastAdmin, onChangePassword, onDelete, onToggleBan, onToggleRole }) => {
  const [menuOpen, setMenuOpen] = useState(false);
  const menuRef = useRef(null);
  useEffect(() => {
    if (!menuOpen) return;
    const close = (e) => {
      if (menuRef.current && !menuRef.current.contains(e.target)) setMenuOpen(false);
    };
    document.addEventListener("mousedown", close);
    return () => document.removeEventListener("mousedown", close);
  }, [menuOpen]);

  const banned = !row.is_enabled;
  const initials =
    (row.first_name?.[0] || "") + (row.last_name?.[0] || "")
    || (row.display_name || row.email || "??").slice(0, 2);

  return (
    <li className={"admin-row" + (banned ? " banned" : "")}>
      <div className="admin-avatar">{initials.toUpperCase()}</div>
      <div className="admin-ident">
        <div className="admin-name">
          {displayName(row)}
          {isSelf && <span className="admin-self-chip">you</span>}
        </div>
        <div className="admin-email">{row.email}</div>
      </div>
      <div className="admin-badges">
        <span className={"role-badge" + (row.role === "Admin" ? " admin" : "")}>
          {row.role === "Admin" ? <Icon name="shield" size={10}/> : <Icon name="user" size={10}/>}
          {row.role}
        </span>
        {banned && (
          <span className="ban-badge">
            <Icon name="ban" size={10}/>Banned
          </span>
        )}
      </div>
      <div className="admin-row-actions" ref={menuRef}>
        <button className="row-btn" title="More" onClick={() => setMenuOpen(v => !v)}>
          <Icon name="more" size={14}/>
        </button>
        {menuOpen && (
          <div className="menu admin-menu">
            <button className="menu-item" onClick={() => { setMenuOpen(false); onChangePassword(); }}>
              <Icon name="lock" size={13}/><span>Change password</span>
            </button>
            <button className="menu-item"
                    onClick={() => { setMenuOpen(false); onToggleRole(); }}
                    disabled={row.role === "Admin" && isLastAdmin}
                    title={row.role === "Admin" && isLastAdmin ? "Last Admin — cannot demote" : undefined}>
              <Icon name="shield" size={13}/>
              <span>{row.role === "Admin" ? "Demote to User" : "Promote to Admin"}</span>
            </button>
            <button className="menu-item"
                    onClick={() => { setMenuOpen(false); onToggleBan(); }}
                    disabled={isSelf && !banned}
                    title={isSelf && !banned ? "You can't ban yourself" : undefined}>
              <Icon name="ban" size={13}/>
              <span>{banned ? "Unban user" : "Ban user"}</span>
            </button>
            <div className="menu-sep"/>
            <button className="menu-item danger"
                    onClick={() => { setMenuOpen(false); onDelete(); }}
                    disabled={isSelf || (row.role === "Admin" && isLastAdmin)}
                    title={isSelf ? "You can't delete yourself"
                         : (row.role === "Admin" && isLastAdmin) ? "Last Admin — cannot delete"
                         : undefined}>
              <Icon name="trash" size={13}/><span>Delete user…</span>
            </button>
          </div>
        )}
      </div>
    </li>
  );
};

// ----------------------------------------------------------------------------
// Add user modal
// ----------------------------------------------------------------------------
const AddUserModal = ({ onClose, onSubmit }) => {
  const [first, setFirst]   = useState("");
  const [last, setLast]     = useState("");
  const [email, setEmail]   = useState("");
  const [role, setRole]     = useState("User");
  const [pw, setPw]         = useState("");
  const [pending, setPending] = useState(false);

  const defaultPw = first ? `${first}123$` : "";
  const canSubmit = first.trim() && email.trim().includes("@");

  const submit = async (e) => {
    e.preventDefault();
    if (!canSubmit || pending) return;
    setPending(true);
    await onSubmit({
      first_name: first.trim(),
      last_name: last.trim() || null,
      email: email.trim().toLowerCase(),
      role,
      password: pw || defaultPw,
    });
    setPending(false);
  };

  return (
    <>
      <div className="overlay admin-overlay" onClick={onClose}/>
      <form className="modal admin-modal" onSubmit={submit}>
        <div className="modal-head">
          <div className="icon-badge"><Icon name="users" size={16}/></div>
          <div style={{ flex: 1 }}>
            <div className="drawer-eyebrow">Admin</div>
            <h3 className="drawer-title" style={{ fontSize: 16 }}>Add user</h3>
          </div>
          <button type="button" className="drawer-close" onClick={onClose}><Icon name="x" size={16}/></button>
        </div>
        <div className="modal-body">
          <div className="field">
            <div className="field-label">First name *</div>
            <div className="field-value">
              <input className="input" value={first} autoFocus
                     onChange={e => setFirst(e.target.value)}/>
            </div>
          </div>
          <div className="field">
            <div className="field-label">Last name</div>
            <div className="field-value">
              <input className="input" value={last} onChange={e => setLast(e.target.value)}/>
            </div>
          </div>
          <div className="field">
            <div className="field-label">Email *</div>
            <div className="field-value">
              <input className="input" type="email" value={email} autoComplete="off"
                     onChange={e => setEmail(e.target.value)}
                     placeholder="person@msmmeng.com"/>
            </div>
          </div>
          <div className="field">
            <div className="field-label">Role</div>
            <div className="field-value">
              <div className="seg" style={{ maxWidth: 220 }}>
                <button type="button"
                        className={"seg-btn" + (role === "User" ? " active" : "")}
                        onClick={() => setRole("User")}>
                  <Icon name="user" size={12}/>User
                </button>
                <button type="button"
                        className={"seg-btn" + (role === "Admin" ? " active" : "")}
                        onClick={() => setRole("Admin")}>
                  <Icon name="shield" size={12}/>Admin
                </button>
              </div>
            </div>
          </div>
          <div className="field">
            <div className="field-label">Initial password</div>
            <div className="field-value">
              <input className="input"
                     value={pw}
                     onChange={e => setPw(e.target.value)}
                     placeholder={defaultPw || "e.g. Firstname123$"}
                     style={{ fontFamily: "var(--font-mono)" }}/>
              <div style={{ fontSize: 11.5, color: "var(--text-soft)", marginTop: 4 }}>
                Leave blank to use the default pattern <span className="mono">{'{first_name}123$'}</span>.
              </div>
            </div>
          </div>
        </div>
        <div className="modal-foot">
          <div style={{ fontSize: 12, color: "var(--text-soft)" }}>* required</div>
          <div style={{ display: "flex", gap: 8 }}>
            <button type="button" className="btn sm" onClick={onClose} disabled={pending}>Cancel</button>
            <button className="btn primary sm" disabled={!canSubmit || pending}>
              <Icon name="check" size={13}/>
              {pending ? "Creating…" : "Create user"}
            </button>
          </div>
        </div>
      </form>
    </>
  );
};

// ----------------------------------------------------------------------------
// Change password modal
// ----------------------------------------------------------------------------
const ChangePasswordModal = ({ row, onClose, onSubmit }) => {
  const suggested = row.first_name ? `${row.first_name}123$` : "";
  const [pw, setPw] = useState(suggested);
  const [show, setShow] = useState(false);
  const [pending, setPending] = useState(false);

  const ok = pw.length >= 6;
  const submit = async (e) => {
    e.preventDefault();
    if (!ok || pending) return;
    setPending(true);
    await onSubmit(pw);
    setPending(false);
  };

  return (
    <>
      <div className="overlay admin-overlay" onClick={onClose}/>
      <form className="modal admin-modal" onSubmit={submit}>
        <div className="modal-head">
          <div className="icon-badge"><Icon name="lock" size={16}/></div>
          <div style={{ flex: 1 }}>
            <div className="drawer-eyebrow">Admin</div>
            <h3 className="drawer-title" style={{ fontSize: 16 }}>Change password</h3>
            <div style={{ fontSize: 12, color: "var(--text-soft)", marginTop: 3 }}>
              {displayName(row)} · <span className="mono">{row.email}</span>
            </div>
          </div>
          <button type="button" className="drawer-close" onClick={onClose}><Icon name="x" size={16}/></button>
        </div>
        <div className="modal-body">
          <div className="field">
            <div className="field-label">New password *</div>
            <div className="field-value" style={{ display: "flex", gap: 8, alignItems: "center" }}>
              <input
                className="input"
                type={show ? "text" : "password"}
                value={pw}
                autoFocus
                onChange={e => setPw(e.target.value)}
                style={{ fontFamily: "var(--font-mono)", flex: 1 }}
              />
              <button type="button" className="btn sm" onClick={() => setShow(v => !v)}>
                <Icon name={show ? "eyeOff" : "eye"} size={13}/>
                {show ? "Hide" : "Show"}
              </button>
            </div>
            <div style={{ fontSize: 11.5, color: "var(--text-soft)", marginTop: 4 }}>
              Minimum 6 characters. Default pattern: <span className="mono">{'{first_name}123$'}</span>.
            </div>
          </div>
        </div>
        <div className="modal-foot">
          <div style={{ fontSize: 12, color: "var(--text-soft)" }}>The user stays signed in on other sessions until next refresh.</div>
          <div style={{ display: "flex", gap: 8 }}>
            <button type="button" className="btn sm" onClick={onClose} disabled={pending}>Cancel</button>
            <button className="btn primary sm" disabled={!ok || pending}>
              <Icon name="check" size={13}/>
              {pending ? "Updating…" : "Set password"}
            </button>
          </div>
        </div>
      </form>
    </>
  );
};

// ----------------------------------------------------------------------------
// Delete user modal — requires typing the email to confirm
// ----------------------------------------------------------------------------
const DeleteUserModal = ({ row, onClose, onConfirm }) => {
  const [confirm, setConfirm] = useState("");
  const [pending, setPending] = useState(false);
  const match = confirm.trim().toLowerCase() === String(row.email).toLowerCase();

  const submit = async (e) => {
    e.preventDefault();
    if (!match || pending) return;
    setPending(true);
    await onConfirm(confirm.trim().toLowerCase());
    setPending(false);
  };

  return (
    <>
      <div className="overlay admin-overlay" onClick={onClose}/>
      <form className="modal admin-modal" onSubmit={submit}>
        <div className="modal-head">
          <div className="icon-badge danger"><Icon name="trash" size={16}/></div>
          <div style={{ flex: 1 }}>
            <div className="drawer-eyebrow" style={{ color: "var(--rose)" }}>Danger zone</div>
            <h3 className="drawer-title" style={{ fontSize: 16 }}>Delete user</h3>
          </div>
          <button type="button" className="drawer-close" onClick={onClose}><Icon name="x" size={16}/></button>
        </div>
        <div className="modal-body">
          <p style={{ fontSize: 13, lineHeight: 1.55, color: "var(--text)" }}>
            This removes <strong>{displayName(row)}</strong> from <span className="mono">beacon_v2.users</span> and their Supabase auth record. All PM / attendee links they held are unlinked. This cannot be undone.
          </p>
          <div className="field" style={{ marginTop: 14 }}>
            <div className="field-label">Type the email to confirm</div>
            <div className="field-value">
              <input
                className="input"
                value={confirm}
                onChange={e => setConfirm(e.target.value)}
                placeholder={row.email}
                autoComplete="off"
                autoFocus
                style={{ fontFamily: "var(--font-mono)" }}
              />
            </div>
          </div>
        </div>
        <div className="modal-foot">
          <div style={{ fontSize: 12, color: "var(--text-soft)" }}>
            {match ? <span style={{ color: "var(--rose)" }}>Confirmation matches.</span> : "Email must match exactly."}
          </div>
          <div style={{ display: "flex", gap: 8 }}>
            <button type="button" className="btn sm" onClick={onClose} disabled={pending}>Cancel</button>
            <button className="btn sm danger" disabled={!match || pending}>
              <Icon name="trash" size={13}/>
              {pending ? "Deleting…" : "Delete user"}
            </button>
          </div>
        </div>
      </form>
    </>
  );
};

// ----------------------------------------------------------------------------
// Targets — workspace-wide numeric thresholds that steer derived UI for
// every signed-in user. Today this panel only manages the monthly invoice
// benchmark used by the Quad Sheet's bar chart, but the layout is built so
// new targets can stack into the same card grid without redesign.
// ----------------------------------------------------------------------------
const TargetsPanel = ({ appSettings, onSaved, onError }) => {
  // Local draft (string) so the input is fully controllable while typing.
  // null/empty in the saved state surfaces as "" in the input — saving a
  // blank value clears the benchmark and reverts the chart to neutral.
  const saved = appSettings?.monthlyInvoiceBenchmark;
  const initial = saved == null || saved === "" ? "" : String(saved);
  const [draft, setDraft]   = useState(initial);
  const [pending, setPending] = useState(false);

  // Re-sync draft if the parent's appSettings prop changes from elsewhere
  // (e.g. another admin saved while this drawer is open and the parent
  // pushed in a refreshed value).
  useEffect(() => { setDraft(initial); /* eslint-disable-next-line */ }, [saved]);

  const draftNum = draft.trim() === "" ? null : Number(draft);
  const draftValid = draft.trim() === "" || (Number.isFinite(draftNum) && draftNum >= 0);
  const dirty = (draft.trim() === "" ? null : draftNum) !== (saved ?? null);

  const onSubmit = async (e) => {
    e.preventDefault();
    if (!draftValid || !dirty || pending) return;
    setPending(true);
    try {
      const next = await updateMonthlyBenchmark(draftNum);
      onSaved?.(next);
    } catch (err) {
      onError?.(String(err.message || err));
    } finally {
      setPending(false);
    }
  };

  const onClear = async () => {
    if (pending) return;
    setPending(true);
    try {
      const next = await updateMonthlyBenchmark(null);
      setDraft("");
      onSaved?.(next);
    } catch (err) {
      onError?.(String(err.message || err));
    } finally {
      setPending(false);
    }
  };

  const annualEquivalent = Number.isFinite(draftNum) && draftNum > 0
    ? draftNum * 12
    : null;

  return (
    <div className="targets-panel">
      <form className="target-card" onSubmit={onSubmit}>
        <div className="target-card-head">
          <div className="target-card-eyebrow">Quad Sheet · Cash Flow</div>
          <h4 className="target-card-title">Monthly invoice benchmark</h4>
          <p className="target-card-desc">
            Bars on the executive dashboard turn green when the month's
            total invoicing meets or beats this number, red when it falls
            short. Leave blank to disable color verdicts and render every
            bar in neutral cadmium.
          </p>
        </div>

        <div className="target-input-row">
          <div className="target-input-wrap">
            <span className="target-currency">$</span>
            <input
              type="text"
              inputMode="decimal"
              className="target-input"
              value={draft}
              autoFocus
              onChange={e => {
                // Allow digits, commas (we strip them on parse), and a
                // single dot. Reject anything else so users can paste
                // "$185,000" and get a clean number.
                const cleaned = e.target.value
                  .replace(/[$\s]/g, "")
                  .replace(/,/g, "");
                setDraft(cleaned);
              }}
              placeholder="e.g. 185000"
            />
            <span className="target-suffix">/ month</span>
          </div>
          <div className="target-actions">
            {saved != null && (
              <button
                type="button"
                className="btn sm ghost"
                onClick={onClear}
                disabled={pending}
              >
                Clear
              </button>
            )}
            <button
              type="submit"
              className="btn primary sm"
              disabled={!draftValid || !dirty || pending}
            >
              <Icon name="check" size={13}/>
              {pending ? "Saving…" : "Save target"}
            </button>
          </div>
        </div>

        <div className="target-readout">
          <div className="target-readout-cell">
            <div className="target-readout-label">Current target</div>
            <div className="target-readout-val">
              {saved != null ? fmtMoney(saved, false) + "/mo" : "—"}
            </div>
          </div>
          <div className="target-readout-divider"/>
          <div className="target-readout-cell">
            <div className="target-readout-label">Annual equivalent</div>
            <div className="target-readout-val">
              {annualEquivalent != null ? fmtMoney(annualEquivalent, false) : "—"}
            </div>
          </div>
        </div>

        {!draftValid && (
          <div className="target-error">
            Enter a positive number (or leave blank to clear).
          </div>
        )}
      </form>
    </div>
  );
};

// ----------------------------------------------------------------------------
// Helpers
// ----------------------------------------------------------------------------
function displayName(row) {
  return (
    row?.display_name
    || [row?.first_name, row?.last_name].filter(Boolean).join(" ").trim()
    || row?.email
    || "—"
  );
}
