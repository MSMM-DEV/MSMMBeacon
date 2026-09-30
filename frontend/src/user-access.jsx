import React, { useEffect, useMemo, useState } from "react";
import { Icon } from "./icons.jsx";
import { listAllUsersFull, loadAllUserAccess, saveUserAccess } from "./data.js";
import {
  ACCESS_TREE, ACCESS_KIND_LABEL, accessNode, createAccess, effectiveGrants,
  nodeCheckState, setNodeGranted, buildCustomConfig, fullGrantSet,
  normalizeAccessConfig, summarizeAccess, GRANTABLE_KEYS,
} from "./access.js";
import {
  Alert,
  AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent,
  AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle,
  Avatar, AvatarFallback, Badge, Button, Checkbox, EmptyState, InputGroup,
  RadioGroup, RadioGroupItem, Skeleton,
} from "@/ui";

// ============================================================================
// UserAccessPage — Admin → User Management.
//
// Pick a person on the left; choose Full access or Custom on the right and
// tick exactly which workflows / pages / tabs / sub-tabs they see. Everything
// about WHAT the nodes are and HOW they resolve lives in access.js — this file
// is only the editor. Saving upserts beacon_v2.user_access; the person picks
// the change up the next time Beacon regains focus (or on reload).
// ============================================================================

const displayName = (u) =>
  u?.display_name || [u?.first_name, u?.last_name].filter(Boolean).join(" ").trim() || u?.email || "Unnamed";
const initialsOf = (u) =>
  ((u?.first_name?.[0] || "") + (u?.last_name?.[0] || "") || displayName(u).slice(0, 2)).toUpperCase();

const sameSet = (a, b) => a.size === b.size && [...a].every(k => b.has(k));

const PeopleEmptyIcon = (props) => <Icon name="users" {...props} />;

export function UserAccessPage({ currentUser, initialUserId = null, onToast }) {
  const [users, setUsers] = useState([]);
  const [byUser, setByUser] = useState({});
  const [available, setAvailable] = useState(true);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState("");
  const [q, setQ] = useState("");
  const [selectedId, setSelectedId] = useState(initialUserId);
  // { next: userId | null } while a "discard unsaved changes?" confirm is open.
  const [confirmSwitch, setConfirmSwitch] = useState(null);

  // Draft for the selected person.
  const [mode, setMode] = useState("full");
  const [grants, setGrants] = useState(() => fullGrantSet());
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const [roster, access] = await Promise.all([listAllUsersFull(), loadAllUserAccess()]);
        if (cancelled) return;
        setUsers(roster);
        setByUser(access.byUser);
        setAvailable(access.available);
        setLoadError("");
      } catch (e) {
        if (!cancelled) setLoadError(String(e.message || e));
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => { cancelled = true; };
  }, []);

  // Deep-open from the People drawer ("Manage page access").
  useEffect(() => { if (initialUserId) setSelectedId(initialUserId); }, [initialUserId]);

  const selected = users.find(u => u.id === selectedId) || null;
  const storedRow = selected ? byUser[selected.id] || null : null;
  const stored = normalizeAccessConfig(storedRow);
  const storedMode = stored?.mode === "custom" ? "custom" : "full";
  const storedGrants = useMemo(() => effectiveGrants(storedRow), [storedRow]);

  // Reset the draft whenever the person (or their saved row) changes.
  useEffect(() => {
    setMode(storedMode);
    setGrants(storedGrants);
  }, [selectedId, storedMode, storedGrants]);

  const dirty = !!selected && (mode !== storedMode || (mode === "custom" && !sameSet(grants, storedGrants)));

  const filtered = useMemo(() => {
    const needle = q.trim().toLowerCase();
    const list = [...users].sort((a, b) => displayName(a).localeCompare(displayName(b)));
    if (!needle) return list;
    return list.filter(u =>
      [u.email, u.display_name, u.first_name, u.last_name].some(v => (v || "").toLowerCase().includes(needle)));
  }, [users, q]);

  const pick = (id) => {
    if (id === selectedId) return;
    if (dirty) { setConfirmSwitch({ next: id }); return; }
    setSelectedId(id);
  };

  const save = async () => {
    if (!selected || saving) return;
    setSaving(true);
    try {
      const config = mode === "custom" ? buildCustomConfig(grants) : { mode: "full" };
      const row = await saveUserAccess(selected.id, config);
      setByUser(prev => ({ ...prev, [selected.id]: row }));
      onToast?.(`Access saved for ${displayName(selected)}`, "check");
    } catch (e) {
      onToast?.(`Couldn't save access: ${e.message || e}`, "x");
    } finally {
      setSaving(false);
    }
  };

  const discard = () => { setMode(storedMode); setGrants(storedGrants); };

  return (
    <div className="uac" data-has-selection={selected ? "true" : "false"}>
      {!available && (
        <Alert tone="warning" title="User access isn't set up in the database yet" className="uac-banner">
          Apply the migration <code>20260930120000_user_access.sql</code> in Supabase Studio. Until then
          everyone keeps full access and nothing can be saved here.
        </Alert>
      )}
      {loadError && (
        <Alert tone="danger" title="People could not be loaded" className="uac-banner">{loadError}</Alert>
      )}

      <section className="uac-people" aria-label="People">
        <InputGroup
          className="uac-search"
          type="search"
          leading={<Icon name="search" size={14}/>}
          placeholder="Search people"
          aria-label="Search people by name or email"
          value={q}
          onChange={e => setQ(e.target.value)}
        />
        {loading && !users.length ? (
          <div className="uac-people-list" role="status" aria-live="polite">
            <span className="sr-only">Loading people</span>
            {[0, 1, 2, 3, 4].map(i => (
              <div key={i} className="uac-person" aria-hidden="true">
                <Skeleton className="size-8 shrink-0 rounded-full"/>
                <div className="min-w-0 flex-1">
                  <Skeleton className="h-3 w-[55%]"/>
                  <Skeleton className="mt-1.5 h-2.5 w-[75%]"/>
                </div>
              </div>
            ))}
          </div>
        ) : filtered.length === 0 ? (
          <EmptyState icon={PeopleEmptyIcon} title="No matching people"
            description="Nobody matches this search." />
        ) : (
          <ul className="uac-people-list">
            {filtered.map(u => {
              const summary = summarizeAccess({ isAdmin: u.role === "Admin", configRow: byUser[u.id] });
              return (
                <li key={u.id}>
                  <button
                    type="button"
                    className="uac-person"
                    aria-current={u.id === selectedId ? "true" : undefined}
                    data-disabled={u.is_enabled === false ? "true" : undefined}
                    onClick={() => pick(u.id)}
                  >
                    <Avatar size="md"><AvatarFallback>{initialsOf(u)}</AvatarFallback></Avatar>
                    <span className="uac-person-ident">
                      <span className="uac-person-name">
                        {displayName(u)}
                        {u.id === currentUser?.id && <Badge tone="outline" size="sm">you</Badge>}
                      </span>
                      <span className="uac-person-email">{u.email}</span>
                    </span>
                    <Badge tone={summary.tone} size="sm" className="uac-person-badge">{summary.label}</Badge>
                  </button>
                </li>
              );
            })}
          </ul>
        )}
      </section>

      <section className="uac-editor" aria-label="Access editor">
        {!selected ? (
          <EmptyState
            icon={(props) => <Icon name="shield" {...props}/>}
            title="Choose a person"
            description="Pick someone on the left to review or change what they can see in Beacon."
          />
        ) : (
          <AccessEditor
            user={selected}
            mode={mode}
            setMode={setMode}
            grants={grants}
            setGrants={setGrants}
            dirty={dirty}
            saving={saving}
            canSave={available}
            onSave={save}
            onDiscard={discard}
            onBack={() => (dirty ? setConfirmSwitch({ next: null }) : setSelectedId(null))}
            updatedAt={storedRow?.updated_at}
            updatedBy={users.find(u => u.id === storedRow?.updated_by)}
          />
        )}
      </section>

      <AlertDialog open={!!confirmSwitch} onOpenChange={(open) => { if (!open) setConfirmSwitch(null); }}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Discard unsaved changes?</AlertDialogTitle>
            <AlertDialogDescription>
              Your changes to {displayName(selected)}'s access haven't been saved.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Keep editing</AlertDialogCancel>
            <AlertDialogAction onClick={() => { const next = confirmSwitch?.next ?? null; setConfirmSwitch(null); discard(); setSelectedId(next); }}>
              Discard changes
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}

// ----------------------------------------------------------------------------
// Editor for one person.
// ----------------------------------------------------------------------------
function AccessEditor({
  user, mode, setMode, grants, setGrants, dirty, saving, canSave,
  onSave, onDiscard, onBack, updatedAt, updatedBy,
}) {
  const isAdminUser = user.role === "Admin";
  const toggle = (key, on) => setGrants(g => setNodeGranted(g, key, on));
  const preview = useMemo(
    () => createAccess({ isAdmin: isAdminUser, config: mode === "custom" ? buildCustomConfig(grants) : null }),
    [isAdminUser, mode, grants]
  );

  return (
    <div className="uac-editor-inner">
      <header className="uac-editor-head">
        <Button variant="ghost" size="sm" className="uac-back hidden max-[900px]:inline-flex" onClick={onBack}>
          <Icon name="back" size={15}/>People
        </Button>
        <div className="uac-editor-ident">
          <Avatar size="lg"><AvatarFallback>{initialsOf(user)}</AvatarFallback></Avatar>
          <div className="min-w-0">
            <h2 className="uac-editor-name">{displayName(user)}</h2>
            <p className="uac-editor-email">{user.email}</p>
          </div>
          <Badge tone={isAdminUser ? "brand" : "neutral"} className="uac-role">
            <Icon name={isAdminUser ? "shield" : "user"} size={11}/>{user.role}
          </Badge>
        </div>
        {updatedAt && (
          <p className="uac-editor-meta">
            Last changed {new Date(updatedAt).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" })}
            {updatedBy ? ` by ${displayName(updatedBy)}` : ""}
          </p>
        )}
      </header>

      {isAdminUser ? (
        <Alert tone="info" title="Admins always see everything">
          Access settings only apply to people with the User role. To limit what {displayName(user)} sees,
          demote them to User from the People panel first.
        </Alert>
      ) : (
        <>
          <RadioGroup value={mode} onValueChange={setMode} aria-label="Access level" className="uac-modes">
            <ModeOption value="full" current={mode} icon="checkAll" title="Full access"
              hint="Everything a User can see today, including pages added to Beacon later."/>
            <ModeOption value="custom" current={mode} icon="sliders" title="Custom access"
              hint="Only the workflows, pages and tabs you tick below."/>
          </RadioGroup>

          {mode === "custom" && (
            <>
              <div className="uac-tree-tools">
                <p className="uac-tree-hint">
                  Unticked items disappear from {user.first_name || "their"}{user.first_name ? "'s" : ""} Beacon. Time &amp; Leave is always available.
                </p>
                <div className="uac-tree-actions">
                  <Button variant="ghost" size="sm" onClick={() => setGrants(fullGrantSet())}>Select all</Button>
                  <Button variant="ghost" size="sm" onClick={() => setGrants(new Set())}>Clear all</Button>
                </div>
              </div>
              <div className="uac-tree">
                {ACCESS_TREE.map(w => (
                  <WorkflowCard key={w.key} node={w} grants={grants} onToggle={toggle}/>
                ))}
              </div>
            </>
          )}

          <AccessPreview access={preview}/>
        </>
      )}

      {!isAdminUser && (
        <footer className="uac-editor-foot" data-dirty={dirty ? "true" : "false"}>
          <span className="uac-foot-status" aria-live="polite">
            {dirty ? "Unsaved changes" : "All changes saved"}
          </span>
          <Button variant="ghost" onClick={onDiscard} disabled={!dirty || saving}>Discard</Button>
          <Button variant="primary" onClick={onSave} disabled={!dirty || saving || !canSave}>
            {saving ? "Saving…" : "Save access"}
          </Button>
        </footer>
      )}
    </div>
  );
}

const ModeOption = ({ value, current, icon, title, hint }) => {
  const id = `uac-mode-${value}`;
  return (
    <label htmlFor={id} className={"adm-choice" + (current === value ? " is-on" : "")}>
      <RadioGroupItem id={id} value={value} className="adm-choice-radio"/>
      <span className="adm-choice-body">
        <span className="adm-choice-title"><Icon name={icon} size={13}/>{title}</span>
        <span className="adm-choice-hint">{hint}</span>
      </span>
    </label>
  );
};

function WorkflowCard({ node, grants, onToggle }) {
  return (
    <section className="uac-wf" data-always={node.always ? "true" : undefined}>
      <NodeRow node={node} grants={grants} onToggle={onToggle} depth={0}/>
      {node.description && <p className="uac-wf-desc">{node.description}</p>}
      {node.children?.length > 0 && (
        <ul className="uac-children">
          {node.children.map(c => <NodeBranch key={c.key} node={c} grants={grants} onToggle={onToggle} depth={1}/>)}
        </ul>
      )}
    </section>
  );
}

function NodeBranch({ node, grants, onToggle, depth }) {
  return (
    <li>
      <NodeRow node={node} grants={grants} onToggle={onToggle} depth={depth}/>
      {node.children?.length > 0 && (
        <ul className="uac-children">
          {node.children.map(c => <NodeBranch key={c.key} node={c} grants={grants} onToggle={onToggle} depth={depth + 1}/>)}
        </ul>
      )}
    </li>
  );
}

function NodeRow({ node, grants, onToggle, depth }) {
  const meta = accessNode(node.key);
  const locked = meta.always || meta.adminOnly;
  const state = nodeCheckState(grants, node.key);
  const id = `uac-node-${node.key.replace(/[^a-z0-9]+/gi, "-")}`;
  return (
    <div className="uac-node" data-depth={depth} data-locked={locked ? "true" : undefined}>
      <Checkbox
        id={id}
        checked={state}
        disabled={locked}
        onCheckedChange={(v) => onToggle(node.key, v === true)}
        aria-label={`${ACCESS_KIND_LABEL[node.kind] || "Item"}: ${node.label}`}
      />
      <label htmlFor={id} className="uac-node-label">
        <span className="uac-node-name">{node.label}</span>
        <span className="uac-node-kind">{ACCESS_KIND_LABEL[node.kind]}</span>
      </label>
      {meta.always && <Badge tone="success" size="sm"><Icon name="lock" size={10}/>Always available</Badge>}
      {meta.adminOnly && !meta.always && <Badge tone="outline" size="sm"><Icon name="shield" size={10}/>Admin role only</Badge>}
      {meta.hiddenFromNav && <Badge tone="outline" size="sm" title="Not shown in the sidebar; opened from alert-email links and in-app jumps.">Links only</Badge>}
    </div>
  );
}

// What the person will actually see with the current draft — the same
// resolver App.jsx enforces with, so the preview can't disagree with reality.
function AccessPreview({ access }) {
  const rows = [];
  for (const w of ACCESS_TREE) {
    if (!access.can(w.key)) continue;
    const pages = (w.children || []).filter(p => access.can(p.key) && !p.adminOnly);
    if (!pages.length) continue;
    rows.push({ w, pages });
  }
  const hiddenPages = GRANTABLE_KEYS.filter(k => accessNode(k).kind === "page" && !access.can(k)).length;
  return (
    <section className="uac-preview" aria-label="Preview">
      <h3 className="uac-preview-title"><Icon name="eye" size={14}/>What they'll see</h3>
      <dl className="uac-preview-list">
        {rows.map(({ w, pages }) => (
          <div key={w.key} className="uac-preview-row">
            <dt>{w.label}</dt>
            <dd>
              {pages.map(p => {
                const tabs = access.visibleChildren(p.key);
                const all = (p.children || []).length;
                return (
                  <span key={p.key} className="uac-chip">
                    {p.label}
                    {all > 0 && tabs.length < all && (
                      <span className="uac-chip-sub"> · {tabs.map(t => t.label).join(", ")}</span>
                    )}
                  </span>
                );
              })}
            </dd>
          </div>
        ))}
      </dl>
      {hiddenPages > 0 && <p className="uac-preview-foot">{hiddenPages} page{hiddenPages === 1 ? "" : "s"} hidden.</p>}
    </section>
  );
}
