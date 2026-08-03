import React, { useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { Icon } from "./icons.jsx";
import { AppearanceSettings } from "./tweaks.jsx";
import { AlertsAdmin } from "./admin-alerts.jsx";
import { listAllUsersFull, adminAction, getUsers, updateMonthlyBenchmark,
         updateInvoiceActualCutover, invoiceRunReminders, actualThruMonth, MONTHS, fmtMoney } from "./data.js";
import {
  Alert,
  AlertDialog, AlertDialogCancel, AlertDialogContent, AlertDialogDescription,
  AlertDialogFooter, AlertDialogHeader, AlertDialogTitle,
  Avatar, AvatarFallback,
  Badge, Button,
  Dialog, DialogBody, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle,
  DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuLabel,
  DropdownMenuSeparator, DropdownMenuTrigger,
  EmptyState, Field, Input, InputGroup,
  RadioGroup, RadioGroupItem,
  Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle,
  Skeleton,
  Tabs, TabsContent, TabsList, TabsTrigger, TabCount,
  Tooltip, TooltipProvider,
} from "@/ui";

// ============================================================================
// AdminPanel — gear-icon entry point for Admin users only.
//
// Renders as a right-side Sheet (Radix, so focus trapping / Escape / aria
// wiring are handled). Four tabs:
//   · Users       — roster management (add / change password / ban / role / delete)
//   · Alerts      — the alert dispatch desk
//   · Targets     — workspace-wide numeric thresholds
//   · Appearance  — embedded appearance settings so admins keep their tweaks
//                   in one place
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
    <TooltipProvider delayDuration={300}>
      <Sheet open onOpenChange={(open) => { if (!open) onClose(); }}>
        <SheetContent
          side="right"
          className={
            "adm-sheet " +
            (tab === "alerts" ? "w-[min(96vw,1060px)]" : "w-[min(96vw,760px)]")
          }
        >
          <SheetHeader>
            <span className="adm-eyebrow">
              <Icon name="shield" size={12} />Admin
            </span>
            <SheetTitle>Workspace settings</SheetTitle>
            <SheetDescription>
              Roster, alert dispatch, shared targets and your own appearance settings.
            </SheetDescription>
          </SheetHeader>

          <Tabs value={tab} onValueChange={setTab} className="flex min-h-0 flex-1 flex-col">
            <div className="shrink-0 px-5 pt-3">
              <TabsList>
                <TabsTrigger value="users">
                  <Icon name="users" size={14} />Users
                  <TabCount>{rows.length}</TabCount>
                </TabsTrigger>
                <TabsTrigger value="alerts">
                  <Icon name="bell" size={14} />Alerts
                </TabsTrigger>
                <TabsTrigger value="targets">
                  <Icon name="flag" size={14} />Targets
                </TabsTrigger>
                <TabsTrigger value="tweaks">
                  <Icon name="settings" size={14} />Appearance
                </TabsTrigger>
              </TabsList>
            </div>

            <div className="adm-body">
              <TabsContent value="users" className="adm-stack">
                <div className="adm-toolbar">
                  <InputGroup
                    className="adm-search"
                    leading={<Icon name="search" size={14} />}
                    placeholder="Search by name or email"
                    aria-label="Search the roster by name or email"
                    value={q}
                    onChange={e => setQ(e.target.value)}
                  />
                  <Button variant="primary" onClick={() => setModal({ kind: "add" })}>
                    <Icon name="plus" size={14} />Add user
                  </Button>
                </div>

                {loadError && (
                  <Alert tone="danger" title="The roster could not be loaded">
                    {loadError}
                  </Alert>
                )}

                {loading && !rows.length && (
                  <div className="adm-loading" role="status" aria-live="polite">
                    <span className="sr-only">Loading roster</span>
                    {[0, 1, 2, 3, 4].map(i => (
                      <div key={i} className="adm-loading-row" style={{ opacity: 1 - i * 0.14 }}>
                        <Skeleton className="size-8 shrink-0 rounded-full" />
                        <div className="min-w-0 flex-1">
                          <Skeleton className="h-3 w-[42%]" />
                          <Skeleton className="mt-1.5 h-2.5 w-[62%]" />
                        </div>
                        <Skeleton className="h-4 w-16 shrink-0 rounded-full" />
                      </div>
                    ))}
                  </div>
                )}

                {!loading && filtered.length === 0 && (
                  <EmptyState
                    icon={RosterEmptyIcon}
                    title={q ? "No matching people" : "The roster is empty"}
                    description={
                      q
                        ? "Nobody in the roster matches this search. Clear it to see everyone."
                        : "Add the first teammate to give them access to Beacon."
                    }
                    action={
                      q
                        ? <Button variant="default" onClick={() => setQ("")}>Clear search</Button>
                        : <Button variant="default" onClick={() => setModal({ kind: "add" })}>
                            <Icon name="plus" size={14} />Add user
                          </Button>
                    }
                  />
                )}

                {filtered.length > 0 && (
                  <div className="bx-scroll-x">
                    <table className="adm-table" role="table">
                      <thead role="rowgroup">
                        <tr role="row">
                          <th role="columnheader" scope="col">Person</th>
                          <th role="columnheader" scope="col" className="adm-col-role">Role</th>
                          <th role="columnheader" scope="col" className="adm-col-access">Access</th>
                          <th role="columnheader" scope="col" className="adm-col-actions">
                            <span className="sr-only">Row actions</span>
                          </th>
                        </tr>
                      </thead>
                      <tbody role="rowgroup">
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
                      </tbody>
                    </table>
                  </div>
                )}
              </TabsContent>

              <TabsContent value="alerts">
                <AlertsAdmin
                  subjectLookup={alertSubjectLookup}
                  users={getUsers()}
                />
              </TabsContent>

              <TabsContent value="targets">
                <TargetsPanel
                  appSettings={appSettings}
                  onSaved={(next, msg) => {
                    // `next` is a fresh appSettings object from a save; a card that
                    // only wants a toast (e.g. "Run reminders now") passes null —
                    // never push that into appSettings or downstream reads crash.
                    if (next) onAppSettingsChange?.(next);
                    flash(msg || "Targets updated");
                  }}
                  onError={(msg) => flash(msg, "x")}
                />
              </TabsContent>

              <TabsContent value="tweaks">
                <AppearanceSettings tweaks={tweaks} setTweak={setTweak} />
              </TabsContent>
            </div>
          </Tabs>
        </SheetContent>
      </Sheet>

      {/* Toast is portaled to <body> so neither the sheet's own stacking
          context nor a sub-dialog overlay can hide it — the user needs clear
          success/failure feedback after every admin action, especially since
          the sub-dialog closes on success. */}
      {toast && createPortal(
        <div className="adm-toast" role="status" aria-live="polite">
          <span className="adm-toast-icon" data-tone={toast.icon === "x" ? "danger" : "ok"}>
            <Icon name={toast.icon} size={12} stroke={2.2} />
          </span>
          <span className="adm-toast-msg">{toast.msg}</span>
        </div>,
        document.body
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
    </TooltipProvider>
  );
};

// ----------------------------------------------------------------------------
// User row
//
// A real <table> row on tablet and up; the scoped CSS re-flows the same markup
// into a stacked block below 720px, which is why every element carries an
// explicit ARIA role — `display: grid` on a <tr> drops the implicit table
// semantics in Chromium and WebKit.
//
// The action menu is Radix DropdownMenu, which portals to <body>. Rendered
// in-row it kept ending up inaccessible: a banned row's dimmed identity
// creates a stacking context that trapped the old menu under every later row,
// and rows near the sheet's bottom edge were clipped by its scroll container.
// ----------------------------------------------------------------------------
const UserRow = ({ row, isSelf, isLastAdmin, onChangePassword, onDelete, onToggleBan, onToggleRole }) => {
  const banned = !row.is_enabled;
  const initials =
    (row.first_name?.[0] || "") + (row.last_name?.[0] || "")
    || (row.display_name || row.email || "??").slice(0, 2);

  const roleLocked = row.role === "Admin" && isLastAdmin;
  const banLocked  = isSelf && !banned;
  const deleteLocked = isSelf || (row.role === "Admin" && isLastAdmin);
  const name = displayName(row);

  return (
    <tr className="adm-row" role="row" data-banned={banned || undefined}>
      <td role="cell" className="adm-cell-person">
        <div className="adm-person">
          <Avatar size="md" className="adm-avatar">
            <AvatarFallback>{initials.toUpperCase()}</AvatarFallback>
          </Avatar>
          <span className="adm-ident">
            <span className="adm-name">
              <span className="bx-truncate">{name}</span>
              {isSelf && <Badge tone="outline" size="sm">you</Badge>}
            </span>
            <span className="adm-email bx-truncate">{row.email}</span>
          </span>
        </div>
      </td>

      <td role="cell" className="adm-cell-role" data-label="Role">
        <Badge tone={row.role === "Admin" ? "brand" : "neutral"}>
          <Icon name={row.role === "Admin" ? "shield" : "user"} size={11} />
          {row.role}
        </Badge>
      </td>

      <td role="cell" className="adm-cell-access" data-label="Access">
        {banned ? (
          <Badge tone="danger"><Icon name="ban" size={11} />Banned</Badge>
        ) : (
          <Badge tone="success"><Icon name="check" size={11} />Active</Badge>
        )}
      </td>

      <td role="cell" className="adm-cell-actions">
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button variant="ghost" size="icon-sm" aria-label={`Actions for ${name}`}>
              <Icon name="more" size={16} />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" className="w-60">
            <DropdownMenuLabel className="adm-menu-head normal-case tracking-[var(--tracking-snug)] text-[length:var(--fs-xs)] text-[var(--text-muted)]">
              {name}
            </DropdownMenuLabel>
            <DropdownMenuItem onSelect={onChangePassword}>
              <Icon name="lock" size={14} /><span>Change password</span>
            </DropdownMenuItem>

            <DropdownMenuItem onSelect={onToggleRole} disabled={roleLocked}>
              <Icon name="shield" size={14} />
              <span>{row.role === "Admin" ? "Demote to User" : "Promote to Admin"}</span>
            </DropdownMenuItem>
            {roleLocked && <p className="adm-menu-note">Last remaining Admin, cannot be demoted.</p>}

            <DropdownMenuItem onSelect={onToggleBan} disabled={banLocked}>
              <Icon name="ban" size={14} />
              <span>{banned ? "Unban user" : "Ban user"}</span>
            </DropdownMenuItem>
            {banLocked && <p className="adm-menu-note">You cannot ban your own account.</p>}

            <DropdownMenuSeparator />
            <DropdownMenuItem destructive onSelect={onDelete} disabled={deleteLocked}>
              <Icon name="trash" size={14} /><span>Delete user…</span>
            </DropdownMenuItem>
            {deleteLocked && (
              <p className="adm-menu-note">
                {isSelf ? "You cannot delete your own account." : "Last remaining Admin, cannot be deleted."}
              </p>
            )}
          </DropdownMenuContent>
        </DropdownMenu>
      </td>
    </tr>
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
    <Dialog open onOpenChange={(open) => { if (!open) onClose(); }}>
      <DialogContent size="md">
        <form onSubmit={submit} className="adm-form">
          <DialogHeader>
            <DialogTitle>Add user</DialogTitle>
            <DialogDescription>
              Creates the Beacon roster row and the sign-in record together.
            </DialogDescription>
          </DialogHeader>

          <DialogBody className="adm-stack">
            <div className="adm-grid-2">
              <Field label="First name" required htmlFor="adm-first">
                <Input id="adm-first" value={first} autoFocus autoComplete="off"
                       onChange={e => setFirst(e.target.value)} />
              </Field>
              <Field label="Last name" htmlFor="adm-last">
                <Input id="adm-last" value={last} autoComplete="off"
                       onChange={e => setLast(e.target.value)} />
              </Field>
            </div>

            <Field label="Email" required htmlFor="adm-email">
              <Input id="adm-email" type="email" value={email} autoComplete="off"
                     onChange={e => setEmail(e.target.value)}
                     placeholder="person@msmmeng.com" />
            </Field>

            <Field label="Role">
              <RadioGroup
                value={role}
                onValueChange={setRole}
                aria-label="Role"
                className="adm-grid-2 gap-3"
              >
                <RoleOption
                  value="User"
                  current={role}
                  icon="user"
                  title="User"
                  hint="Standard access to the workspace."
                />
                <RoleOption
                  value="Admin"
                  current={role}
                  icon="shield"
                  title="Admin"
                  hint="Also manages the roster, alerts and targets."
                />
              </RadioGroup>
            </Field>

            <Field
              label="Initial password"
              htmlFor="adm-pw"
              hint={
                <>
                  Leave blank to use the default pattern{" "}
                  <span className="adm-mono">{"{first_name}123$"}</span>.
                </>
              }
            >
              <Input
                id="adm-pw"
                className="adm-mono"
                value={pw}
                autoComplete="new-password"
                onChange={e => setPw(e.target.value)}
                placeholder={defaultPw || "e.g. Firstname123$"}
              />
            </Field>
          </DialogBody>

          <DialogFooter className="adm-footer sm:justify-between">
            <p className="adm-footnote">Fields marked * are required.</p>
            <div className="adm-footer-actions">
              <Button type="button" variant="default" onClick={onClose} disabled={pending}>
                Cancel
              </Button>
              <Button type="submit" variant="primary" loading={pending} disabled={!canSubmit || pending}>
                {pending ? "Creating…" : "Create user"}
              </Button>
            </div>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
};

// Selectable role tile. The radio itself stays in the accessibility tree; the
// surrounding label is what the pointer hits.
const RoleOption = ({ value, current, icon, title, hint }) => {
  const id = `adm-role-${value}`;
  return (
    <label htmlFor={id} className={"adm-choice" + (current === value ? " is-on" : "")}>
      <RadioGroupItem id={id} value={value} className="adm-choice-radio" />
      <span className="adm-choice-body">
        <span className="adm-choice-title">
          <Icon name={icon} size={13} />{title}
        </span>
        <span className="adm-choice-hint">{hint}</span>
      </span>
    </label>
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
    <Dialog open onOpenChange={(open) => { if (!open) onClose(); }}>
      <DialogContent size="sm">
        <form onSubmit={submit} className="adm-form">
          <DialogHeader>
            <DialogTitle>Change password</DialogTitle>
            <DialogDescription>
              {displayName(row)} · <span className="adm-mono">{row.email}</span>
            </DialogDescription>
          </DialogHeader>

          <DialogBody>
            <Field
              label="New password"
              required
              htmlFor="adm-newpw"
              hint={
                <>
                  Minimum 6 characters. Default pattern:{" "}
                  <span className="adm-mono">{"{first_name}123$"}</span>.
                </>
              }
            >
              <InputGroup
                id="adm-newpw"
                type={show ? "text" : "password"}
                value={pw}
                autoFocus
                autoComplete="new-password"
                inputClassName="adm-mono pr-10"
                onChange={e => setPw(e.target.value)}
                trailing={
                  <Tooltip label={show ? "Hide password" : "Show password"}>
                    <button
                      type="button"
                      className="adm-reveal"
                      aria-label={show ? "Hide password" : "Show password"}
                      aria-pressed={show}
                      onClick={() => setShow(v => !v)}
                    >
                      <Icon name={show ? "eyeOff" : "eye"} size={15} />
                    </button>
                  </Tooltip>
                }
              />
            </Field>
          </DialogBody>

          <DialogFooter className="adm-footer sm:justify-between">
            <p className="adm-footnote">
              The user stays signed in on other sessions until next refresh.
            </p>
            <div className="adm-footer-actions">
              <Button type="button" variant="default" onClick={onClose} disabled={pending}>
                Cancel
              </Button>
              <Button type="submit" variant="primary" loading={pending} disabled={!ok || pending}>
                {pending ? "Updating…" : "Set password"}
              </Button>
            </div>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
};

// ----------------------------------------------------------------------------
// Delete user confirm — requires typing the email to confirm
// ----------------------------------------------------------------------------
const DeleteUserModal = ({ row, onClose, onConfirm }) => {
  const [confirm, setConfirm] = useState("");
  const [pending, setPending] = useState(false);
  const inputRef = useRef(null);
  const match = confirm.trim().toLowerCase() === String(row.email).toLowerCase();

  const submit = async (e) => {
    e.preventDefault();
    if (!match || pending) return;
    setPending(true);
    await onConfirm(confirm.trim().toLowerCase());
    setPending(false);
  };

  return (
    <AlertDialog open onOpenChange={(open) => { if (!open) onClose(); }}>
      <AlertDialogContent
        // Radix focuses the content container after this handler runs, so the
        // input has to be focused on the next frame to win.
        onOpenAutoFocus={(e) => { e.preventDefault(); setTimeout(() => inputRef.current?.focus(), 0); }}
      >
        <form onSubmit={submit}>
          <AlertDialogHeader>
            <span className="adm-danger-mark" aria-hidden="true">
              <Icon name="trash" size={16} />
            </span>
            <AlertDialogTitle>Delete {displayName(row)}?</AlertDialogTitle>
            <AlertDialogDescription>
              This removes them from the Beacon roster and deletes their sign-in
              record. Every PM and attendee link they held is unlinked. This
              cannot be undone.
            </AlertDialogDescription>
          </AlertDialogHeader>

          <div className="adm-confirm-field">
            <Field
              label="Type the email to confirm"
              htmlFor="adm-confirm-email"
              error={confirm && !match ? "The email must match exactly." : undefined}
              hint={match ? "Confirmation matches." : undefined}
            >
              <Input
                id="adm-confirm-email"
                ref={inputRef}
                className="adm-mono"
                value={confirm}
                onChange={e => setConfirm(e.target.value)}
                placeholder={row.email}
                autoComplete="off"
                aria-invalid={confirm && !match ? true : undefined}
              />
            </Field>
          </div>

          <AlertDialogFooter>
            <AlertDialogCancel disabled={pending}>Cancel</AlertDialogCancel>
            <Button type="submit" variant="destructive" loading={pending} disabled={!match || pending}>
              {pending ? "Deleting…" : "Delete user"}
            </Button>
          </AlertDialogFooter>
        </form>
      </AlertDialogContent>
    </AlertDialog>
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
      onSaved?.(next, "Benchmark updated");
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
      onSaved?.(next, "Benchmark cleared");
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
    <div className="adm-stack">
      <CutoverCard appSettings={appSettings} onSaved={onSaved} onError={onError} />
      <BillingRemindersCard onSaved={onSaved} onError={onError} />

      <form className="adm-card" onSubmit={onSubmit}>
        <div className="adm-card-head">
          <p className="adm-card-eyebrow">Quad Sheet · Cash Flow</p>
          <h4 className="adm-card-title">Monthly invoice benchmark</h4>
          <p className="adm-card-desc">
            On the executive dashboard, each month's bar is marked as met when
            total invoicing reaches this number and as short when it does not.
            Leave it blank to disable the verdict and render every bar neutral.
          </p>
        </div>

        <div className="adm-card-body">
          <Field label="Target" htmlFor="adm-benchmark" className="adm-field-grow">
            <InputGroup
              id="adm-benchmark"
              type="text"
              inputMode="decimal"
              inputClassName="pl-6 pr-[74px] num"
              leading={<span className="adm-adorn">$</span>}
              trailing={<span className="adm-adorn adm-adorn-suffix">/ month</span>}
              value={draft}
              autoFocus
              aria-invalid={!draftValid || undefined}
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
          </Field>

          <div className="adm-card-actions">
            {saved != null && (
              <Button type="button" variant="ghost" onClick={onClear} disabled={pending}>
                Clear
              </Button>
            )}
            <Button type="submit" variant="primary" loading={pending}
                    disabled={!draftValid || !dirty || pending}>
              {pending ? "Saving…" : "Save target"}
            </Button>
          </div>
        </div>

        <dl className="adm-readout">
          <div className="adm-readout-cell">
            <dt>Current target</dt>
            <dd className="num">{saved != null ? fmtMoney(saved, false) + "/mo" : EMPTY}</dd>
          </div>
          <div className="adm-readout-cell">
            <dt>Annual equivalent</dt>
            <dd className="num">{annualEquivalent != null ? fmtMoney(annualEquivalent, false) : EMPTY}</dd>
          </div>
        </dl>

        {!draftValid && (
          <Alert tone="danger" className="adm-card-alert">
            Enter a positive number, or leave it blank to clear the target.
          </Alert>
        )}
      </form>
    </div>
  );
};

// ----------------------------------------------------------------------------
// CutoverCard — when the Invoice tab flips a month from Projection to Actual:
// a day-of-month (1–31) landing in the SAME month (Day 1 = the classic "flips
// on the 1st") or the NEXT month (e.g. June → Actual on July 1, holding each
// month as a Projection until it ends). Same card chrome as the benchmark
// card; saves through updateInvoiceActualCutover and reports via shared onSaved.
// ----------------------------------------------------------------------------
const CutoverCard = ({ appSettings, onSaved, onError }) => {
  const savedDay  = appSettings?.invoiceActualCutoverDay ?? 1;
  const savedNext = !!appSettings?.invoiceActualCutoverNextMonth;
  const [draft, setDraft] = useState(String(savedDay));
  const [nextMonth, setNextMonth] = useState(savedNext);
  const [pending, setPending] = useState(false);
  // Re-sync from the parent if another admin saves while this is open.
  useEffect(() => { setDraft(String(savedDay)); setNextMonth(savedNext); /* eslint-disable-next-line */ }, [savedDay, savedNext]);

  const draftNum = parseInt(draft, 10);
  const draftValid = Number.isFinite(draftNum) && draftNum >= 1 && draftNum <= 31;
  const dirty = draftValid && (draftNum !== savedDay || nextMonth !== savedNext);

  const whenPhrase = (d, nm) => `the ${ordinal(d)}${nm ? " of the following month" : ""}`;

  const onSubmit = async (e) => {
    e.preventDefault();
    if (!draftValid || !dirty || pending) return;
    setPending(true);
    try {
      const next = await updateInvoiceActualCutover(draftNum, nextMonth);
      onSaved?.(next, `Actuals now flip on ${whenPhrase(draftNum, nextMonth)}`);
    } catch (err) {
      onError?.(String(err.message || err));
    } finally {
      setPending(false);
    }
  };

  // Live preview of the resulting split for "today".
  const previewThru = actualThruMonth(draftValid ? draftNum : savedDay, nextMonth);
  const previewText = previewThru >= 0 ? `Jan–${MONTHS[previewThru]} Actual` : "All Projection";
  // A concrete example so the next-month meaning is unambiguous: month N closes
  // on `day` of month N+1.
  const exMonth = MONTHS[new Date().getMonth()];
  const exNext  = MONTHS[(new Date().getMonth() + 1) % 12];

  return (
    <form className="adm-card" onSubmit={onSubmit}>
      <div className="adm-card-head">
        <p className="adm-card-eyebrow">Invoice · Actual vs Projection</p>
        <h4 className="adm-card-title">Move to Actual on</h4>
        <p className="adm-card-desc">
          Each year's month columns switch from <strong>Projection</strong> to{" "}
          <strong>Actual</strong> as the year progresses. Choose <strong>this month</strong>{" "}
          to flip the current month on a given day (Day 1 = the classic "flips on
          the 1st"), or <strong>next month</strong> to hold each month as a Projection
          until it ends. For example, <strong>{exMonth}</strong> becomes Actual on the{" "}
          {ordinal(draftValid ? draftNum : savedDay)} of <strong>{exNext}</strong>.
        </p>
      </div>

      <div className="adm-card-body">
        <Field label="Day of month" htmlFor="adm-cutover-day" className="adm-field-day">
          <Input
            id="adm-cutover-day"
            type="number"
            min="1"
            max="31"
            step="1"
            inputMode="numeric"
            className="num"
            value={draft}
            aria-invalid={!draftValid || undefined}
            onChange={e => setDraft(e.target.value.replace(/[^\d]/g, ""))}
            placeholder="1"
          />
        </Field>

        <Field label="Of which month" className="adm-field-grow">
          <RadioGroup
            value={nextMonth ? "next" : "this"}
            onValueChange={(v) => setNextMonth(v === "next")}
            aria-label="Which month"
            className="adm-segment flex gap-0.5"
          >
            <SegmentOption name="cutover" value="this" current={nextMonth ? "next" : "this"} label="This month" />
            <SegmentOption name="cutover" value="next" current={nextMonth ? "next" : "this"} label="Next month" />
          </RadioGroup>
        </Field>

        <div className="adm-card-actions">
          <Button type="submit" variant="primary" loading={pending}
                  disabled={!draftValid || !dirty || pending}>
            {pending ? "Saving…" : "Save"}
          </Button>
        </div>
      </div>

      <dl className="adm-readout">
        <div className="adm-readout-cell">
          <dt>Flips on</dt>
          <dd>{whenPhrase(savedDay, savedNext)}</dd>
        </div>
        <div className="adm-readout-cell">
          <dt>{dirty ? "Would show today" : "Showing today"}</dt>
          <dd>{previewText}</dd>
        </div>
      </dl>

      {!draftValid && (
        <Alert tone="danger" className="adm-card-alert">
          Enter a day from 1 to 31.
        </Alert>
      )}
    </form>
  );
};

const SegmentOption = ({ name, value, current, label }) => {
  const id = `adm-seg-${name}-${value}`;
  return (
    <label htmlFor={id} className={"adm-segment-opt" + (current === value ? " is-on" : "")}>
      <RadioGroupItem id={id} value={value} className="sr-only" />
      <span>{label}</span>
    </label>
  );
};

// ----------------------------------------------------------------------------
// BillingRemindersCard — manual trigger for the invoice-billing-reminders Edge
// Function. The daily cron runs it automatically; this button lets an admin
// fire it on demand (e.g. to test, or to re-send the day's reminders). The
// destructive cutover-day clear is gated by the function's own
// INVOICE_AUTOCLEAR_ENABLED secret (default off), so "Run now" is safe.
// ----------------------------------------------------------------------------
const BillingRemindersCard = ({ onSaved, onError }) => {
  const [pending, setPending] = useState(false);
  const [result, setResult] = useState(null);

  const onRun = async () => {
    if (pending) return;
    setPending(true);
    setResult(null);
    try {
      const { data, error } = await invoiceRunReminders();
      if (error) throw error;
      setResult(data || {});
      const r3 = data?.reminders3 ?? 0, r4 = data?.reminders4 ?? 0, cl = data?.cleared ?? 0;
      onSaved?.(null, `Billing reminders: ${r3 + r4} sent${cl ? `, ${cl} cleared` : ""}`);
    } catch (err) {
      onError?.(String(err.message || err));
    } finally {
      setPending(false);
    }
  };

  return (
    <div className="adm-card">
      <div className="adm-card-head">
        <p className="adm-card-eyebrow">Invoice · Billing reminders</p>
        <h4 className="adm-card-title">End-of-month billing reminders</h4>
        <p className="adm-card-desc">
          For the month closing on the cutover date, emails Randy Pausina, Joe
          Lavenia, Dominique Smith and each project's PM when a total value is
          entered but not billed, or a sub invoice is attached while the total is
          missing. Runs automatically each day; the cutover-day auto-clear only
          fires when its server switch is on.
        </p>
      </div>

      <div className="adm-card-body">
        <Button type="button" variant="default" loading={pending} disabled={pending} onClick={onRun}>
          <Icon name="mail" size={14} />
          {pending ? "Running…" : "Run reminders now"}
        </Button>
      </div>

      {result && (
        <dl className="adm-readout">
          <div className="adm-readout-cell">
            <dt>Closing month</dt>
            <dd>{result.targetMonth || result.note || EMPTY}</dd>
          </div>
          <div className="adm-readout-cell">
            <dt>Sent / cleared</dt>
            <dd className="num">
              {(result.reminders3 ?? 0) + (result.reminders4 ?? 0)} sent · {result.cleared ?? 0} cleared
            </dd>
          </div>
        </dl>
      )}
    </div>
  );
};

// ----------------------------------------------------------------------------
// Helpers
// ----------------------------------------------------------------------------
// The house placeholder for "nothing here yet" (en dash, never an em dash).
const EMPTY = "–";

// EmptyState takes a component; adapt the Beacon icon registry to that shape
// rather than importing lucide directly into a page.
const RosterEmptyIcon = (props) => <Icon name="users" {...props} />;

// 1 → "1st", 5 → "5th", 22 → "22nd".
function ordinal(n) {
  const s = ["th", "st", "nd", "rd"], v = n % 100;
  return `${n}${s[(v - 20) % 10] || s[v] || s[0]}`;
}

function displayName(row) {
  return (
    row?.display_name
    || [row?.first_name, row?.last_name].filter(Boolean).join(" ").trim()
    || row?.email
    || EMPTY
  );
}
