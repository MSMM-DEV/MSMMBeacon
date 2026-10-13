// Shared Egnyte connector UI.
//
// One browsing hook (useEgnyteBrowser) drives two surfaces:
//   • EgnyteFolderModal / EgnyteLinkedFolderModal — the Invoice table's
//     folder-only picker + "open linked folder" chooser (moved verbatim out of
//     tables.jsx; behaviour unchanged).
//   • EgnytePickerDialog — the file-AND-folder picker used by Sales
//     opportunities. Built on the @/ui Radix Dialog so it can stack above the
//     opportunity sheet (itself a Radix Dialog, which makes everything
//     outside it inert — a plain portal modal would be unclickable there).
//
// Everything goes through /api/egnyte/folders (sign-in gated, server-side
// OAuth). No Egnyte credential ever reaches this module.
import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import {
  Badge, Button, Dialog, DialogBody, DialogContent, DialogDescription,
  DialogFooter, DialogHeader, DialogTitle, InputGroup,
} from "@/ui";
import { Icon } from "./icons.jsx";
import { browseEgnyteFolders } from "./data.js";
import {
  canAttemptLocalFileOpen,
  defaultEgnyteLocalRoot,
  DEFAULT_SALES_EGNYTE_PATH,
  EGNYTE_LOCAL_ROOT_STORAGE_KEY,
  EGNYTE_SHARED_ROOT,
  egnyteBreadcrumbs,
  egnyteFolderOpenTarget,
  egnyteParentPath,
  filterEgnyteFolders,
  formatEgnyteSize,
  openLocalFolderWithHelper,
} from "./egnyte-links.js";

const EGNYTE_LOGO_LINKED = "/egnyte/Egnyte-Logo-Linked.svg";
const EGNYTE_LOGO_NOT_LINKED = "/egnyte/Egnyte-Logo--Streamline-Logos-Block.svg";

export function EgnyteLogoMark({ size = 14, linked = false }) {
  return (
    <span className="egnyte-logo-mark" style={{ "--egnyte-logo-size": `${size}px` }} aria-hidden="true">
      <span className="egnyte-logo-fallback">E</span>
      <img
        src={linked ? EGNYTE_LOGO_LINKED : EGNYTE_LOGO_NOT_LINKED}
        alt=""
        loading="lazy"
        decoding="async"
        onError={(e) => { e.currentTarget.remove(); }}
      />
    </span>
  );
}

// ---------------------------------------------------------------------------
// Browsing state. A request counter drops stale responses, so a fast
// double-click into two folders can't paint the slower listing last.
// ---------------------------------------------------------------------------
export function useEgnyteBrowser({ includeFiles = false, initialPath, fallbackPath } = {}) {
  const [currentPath, setCurrentPath] = useState(null);
  const [folders, setFolders] = useState([]);
  const [files, setFiles] = useState([]);
  const [webBase, setWebBase] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const requestRef = useRef(0);

  const load = useCallback(async (path, { fallback } = {}) => {
    const request = ++requestRef.current;
    setLoading(true);
    setError("");
    try {
      const result = await browseEgnyteFolders(path, { includeFiles });
      if (request !== requestRef.current) return;
      setCurrentPath(result.path);
      setFolders(result.folders || []);
      setFiles(includeFiles ? (result.files || []) : []);
      if (result.webBase) setWebBase(result.webBase);
    } catch (e) {
      if (request !== requestRef.current) return;
      // A missing/forbidden start folder must not strand the picker with no
      // breadcrumbs: fall back once to the browsable root.
      if (fallback && fallback !== path) { load(fallback); return; }
      setError(e?.message || "Egnyte folders could not be loaded.");
      setFolders([]);
      setFiles([]);
    } finally {
      if (request === requestRef.current) setLoading(false);
    }
  }, [includeFiles]);

  // Load once on mount; callers remount to reset.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => { load(initialPath, { fallback: fallbackPath }); }, []);

  return { currentPath, folders, files, webBase, loading, error, load };
}

// ---------------------------------------------------------------------------
// Local open (Finder / File Explorer) — the same strategy the Invoice table
// uses: localhost opener daemon first, then a file:// attempt for folders.
// Files fall back to "path copied" (a file:// URL would download or render
// the file inside the browser tab, which is not what "Open" means).
// ---------------------------------------------------------------------------
export function readEgnyteLocalRoot() {
  const platform = typeof navigator !== "undefined" ? navigator.platform || "" : "";
  const fallback = defaultEgnyteLocalRoot(platform);
  if (typeof window === "undefined") return fallback;
  try {
    return window.localStorage.getItem(EGNYTE_LOCAL_ROOT_STORAGE_KEY) || fallback;
  } catch {
    return fallback;
  }
}

// Returns { ok, message } — the message is user-facing.
export async function openEgnyteItemLocally({ path, kind = "folder" }) {
  const platform = typeof navigator !== "undefined" ? navigator.platform || "" : "";
  const userAgent = typeof navigator !== "undefined" ? navigator.userAgent || "" : "";
  const target = egnyteFolderOpenTarget({ path, platform, userAgent, localRoot: readEgnyteLocalRoot() });
  if (target.mobile) return { ok: false, message: "Opening the synced Egnyte drive isn't available on mobile. Use Open in Egnyte instead." };
  try {
    if (typeof navigator !== "undefined") await navigator.clipboard?.writeText(target.localPath);
  } catch {
    // Best-effort convenience only; browser clipboard permission varies.
  }
  if (await openLocalFolderWithHelper({ localPath: target.localPath })) {
    return { ok: true, message: `Opened ${target.localPath}` };
  }
  const pageProtocol = typeof window !== "undefined" ? window.location.protocol : "";
  if (kind !== "folder" || !canAttemptLocalFileOpen(pageProtocol)) {
    return { ok: false, message: `Local path copied: ${target.localPath}` };
  }
  const opened = window.open(target.url, "_blank", "noopener,noreferrer");
  if (!opened) window.location.href = target.url;
  return { ok: true, message: `Opening ${target.localPath}` };
}

export function formatEgnyteDate(value) {
  if (!value) return "";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "";
  return date.toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" });
}

// ---------------------------------------------------------------------------
// Invoice table: folder-only picker (unchanged behaviour).
// ---------------------------------------------------------------------------
export function EgnyteFolderModal({ row, onClose, onSave }) {
  const dialogRef = useRef(null);
  const { currentPath, folders, loading, error: loadError, load } = useEgnyteBrowser();
  const [selected, setSelected] = useState(row?.egnyteFolderPath || "");
  const [viewMode, setViewMode] = useState("list");
  const [search, setSearch] = useState("");
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState("");
  const error = saveError || loadError;

  useEffect(() => {
    const previousFocus = document.activeElement;
    const dialog = dialogRef.current;
    dialog?.querySelector("button")?.focus();
    const onKey = (event) => {
      if (event.key === "Escape") { event.preventDefault(); onClose(); return; }
      if (event.key !== "Tab") return;
      const controls = [...(dialog?.querySelectorAll('button:not([disabled]), input:not([disabled]), [tabindex="0"]') || [])].filter(el => el.getClientRects().length);
      const first = controls[0], last = controls[controls.length - 1];
      if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus(); }
      else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus(); }
    };
    dialog?.addEventListener("keydown", onKey);
    return () => { dialog?.removeEventListener("keydown", onKey); previousFocus?.focus?.(); };
  }, [onClose]);

  const navigate = (path) => { setSaveError(""); load(path); };

  const parts = (currentPath || "").split("/").filter(Boolean);
  const crumbs = parts.map((part, i) => ({
    label: part,
    path: `/${parts.slice(0, i + 1).join("/")}`,
  }));
  const parentPath = parts.length > 1 ? `/${parts.slice(0, -1).join("/")}` : null;
  const selectedIsCurrent = !!currentPath && selected === currentPath;
  const searchText = search.trim();
  const visibleFolders = useMemo(() => filterEgnyteFolders(folders, search), [folders, search]);

  const save = async (path = selected) => {
    setSaving(true);
    setSaveError("");
    try {
      await onSave(path);
    } catch (e) {
      setSaveError(e?.message || "Egnyte folder could not be saved.");
      setSaving(false);
    }
  };

  const renderFolder = (folder) => {
    const active = selected === folder.path;
    return (
      <div className={"egnyte-folder-card" + (active ? " selected" : "")} role="listitem" key={folder.path}>
        <button className="egnyte-folder-open" type="button" onClick={() => navigate(folder.path)}>
          <span className="egnyte-folder-glyph"><Icon name="chevronRight" size={13}/></span>
          <span className="egnyte-folder-main">
            <strong>{folder.name}</strong>
            <span className="mono">{folder.path}</span>
          </span>
        </button>
        <button className="btn sm egnyte-select-btn" type="button" onClick={() => setSelected(folder.path)}>
          {active ? <><Icon name="check" size={12}/>Selected</> : "Select"}
        </button>
      </div>
    );
  };

  return createPortal(
    <>
      <div className="overlay" onClick={onClose}/>
      <div ref={dialogRef} className="modal modal-wide egnyte-modal" role="dialog" aria-modal="true" aria-labelledby="egnyte-title">
        <div className="modal-head">
          <div className="icon-badge egnyte-badge"><EgnyteLogoMark size={20} linked={!!row?.egnyteFolderPath}/></div>
          <div>
            <div className="modal-eyebrow">Egnyte folder</div>
            <h2 className="modal-title" id="egnyte-title">{row?.name || "Project"}</h2>
          </div>
          <button className="modal-close" type="button" onClick={onClose} aria-label="Close">
            <Icon name="x" size={16}/>
          </button>
        </div>
        <div className="modal-body egnyte-body">
          <div className="egnyte-current-panel">
            <div>
              <span>Current link</span>
              <strong className="mono">{row?.egnyteFolderPath || "No folder linked"}</strong>
            </div>
            {currentPath && (
              <button
                className={"btn sm" + (selectedIsCurrent ? " primary" : "")}
                type="button"
                onClick={() => setSelected(currentPath)}
                disabled={loading}>
                {selectedIsCurrent ? <><Icon name="check" size={12}/>Current selected</> : "Select current folder"}
              </button>
            )}
          </div>
          <div className="egnyte-browser">
            <div className="egnyte-toolbar">
              <div className="egnyte-nav-actions">
                <button className="btn sm" type="button" disabled={!parentPath || loading} onClick={() => navigate(parentPath)}>
                  <Icon name="back" size={12}/>Up
                </button>
                <button className="btn sm" type="button" disabled={loading} onClick={() => navigate(currentPath)}>
                  <Icon name="refresh" size={12}/>Refresh
                </button>
              </div>
              <div className="egnyte-crumbs" aria-label="Current Egnyte path">
                {crumbs.length === 0 ? (
                  <span className="mono subtle">Loading PData…</span>
                ) : crumbs.map((c, i) => (
                  <React.Fragment key={c.path}>
                    {i > 0 && <span className="egnyte-sep">/</span>}
                    <button type="button" onClick={() => navigate(c.path)} disabled={loading}>{c.label}</button>
                  </React.Fragment>
                ))}
              </div>
              <div className="egnyte-view-toggle" role="group" aria-label="Egnyte folder view">
                <button
                  type="button"
                  className={viewMode === "list" ? "active" : ""}
                  onClick={() => setViewMode("list")}
                  aria-pressed={viewMode === "list"}
                  aria-label="List view"
                  title="List view">
                  <Icon name="alignLeft" size={14}/>
                </button>
                <button
                  type="button"
                  className={viewMode === "grid" ? "active" : ""}
                  onClick={() => setViewMode("grid")}
                  aria-pressed={viewMode === "grid"}
                  aria-label="Grid view"
                  title="Grid view">
                  <Icon name="columns" size={14}/>
                </button>
              </div>
            </div>
            <label className={"egnyte-search" + (searchText ? " active" : "")}>
              <Icon name="search" size={14}/>
              <input
                type="search"
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                placeholder="Search folders"
                aria-label="Search Egnyte folders"
              />
              {searchText && (
                <button type="button" onClick={() => setSearch("")} aria-label="Clear folder search">
                  <Icon name="x" size={12}/>
                </button>
              )}
            </label>
            {error && (
              <div className="egnyte-error">
                <Icon name="warn" size={14}/>
                <span>{error}</span>
                <button className="link-btn" type="button" onClick={() => navigate(currentPath || undefined)}>Retry</button>
              </div>
            )}
            {loading ? (
              <div className="egnyte-state">
                <span className="egnyte-spinner" aria-hidden="true"/>
                <span>Loading folders…</span>
              </div>
            ) : folders.length === 0 && !error ? (
              <div className="egnyte-state">No subfolders found.</div>
            ) : visibleFolders.length === 0 && !error ? (
              <div className="egnyte-state">No folders match <span className="mono">"{searchText}"</span>.</div>
            ) : (
              <div className={`egnyte-folder-results ${viewMode}`} role="list">
                {visibleFolders.map(renderFolder)}
              </div>
            )}
          </div>
          <div className={"egnyte-selected-panel" + (selected ? " has-selection" : "")}>
            <div>
              <span>Selected folder</span>
              <strong className="mono">{selected || "Choose a folder from the browser"}</strong>
            </div>
          </div>
        </div>
        <div className="modal-foot">
          <button className="btn" type="button" onClick={onClose} disabled={saving}>Cancel</button>
          <div className="egnyte-foot-actions">
            {row?.egnyteFolderPath && (
              <button className="btn" type="button" onClick={() => save("")} disabled={saving}>
                Remove link
              </button>
            )}
            <button className="btn primary" type="button" onClick={() => save()} disabled={!selected || saving}>
              {saving ? "Saving…" : "Save folder"}
            </button>
          </div>
        </div>
      </div>
    </>,
    document.body
  );
}

// ---------------------------------------------------------------------------
// Invoice table: "open linked folder" chooser (unchanged behaviour).
// ---------------------------------------------------------------------------
export function EgnyteLinkedFolderModal({ row, onClose, onChangePath }) {
  const dialogRef = useRef(null);
  const platform = typeof navigator !== "undefined" ? navigator.platform || "" : "";
  const userAgent = typeof navigator !== "undefined" ? navigator.userAgent || "" : "";
  const defaultLocalRoot = defaultEgnyteLocalRoot(platform);
  const [localRoot, setLocalRoot] = useState(() => {
    if (typeof window === "undefined") return defaultLocalRoot;
    try {
      return window.localStorage.getItem(EGNYTE_LOCAL_ROOT_STORAGE_KEY) || defaultLocalRoot;
    } catch {
      return defaultLocalRoot;
    }
  });
  const [message, setMessage] = useState("");

  useEffect(() => {
    const previousFocus = document.activeElement;
    const dialog = dialogRef.current;
    dialog?.querySelector("button")?.focus();
    const onKey = (event) => {
      if (event.key === "Escape") { event.preventDefault(); onClose(); return; }
      if (event.key !== "Tab") return;
      const controls = [...(dialog?.querySelectorAll('button:not([disabled]), input:not([disabled])') || [])].filter(el => el.getClientRects().length);
      const first = controls[0], last = controls[controls.length - 1];
      if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus(); }
      else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus(); }
    };
    dialog?.addEventListener("keydown", onKey);
    return () => { dialog?.removeEventListener("keydown", onKey); previousFocus?.focus?.(); };
  }, [onClose]);

  const target = useMemo(() => egnyteFolderOpenTarget({
    path: row?.egnyteFolderPath || "",
    platform,
    userAgent,
    localRoot,
  }), [row?.egnyteFolderPath, platform, userAgent, localRoot]);

  const persistLocalRoot = (value) => {
    if (typeof window === "undefined") return;
    try {
      window.localStorage.setItem(EGNYTE_LOCAL_ROOT_STORAGE_KEY, value);
    } catch {
      // Local storage can be disabled; opening still works from current state.
    }
  };

  const resetLocalRoot = () => {
    setLocalRoot(defaultLocalRoot);
    persistLocalRoot(defaultLocalRoot);
  };

  const openLinkedFolder = async () => {
    const nextRoot = localRoot.trim() || defaultLocalRoot;
    const nextTarget = egnyteFolderOpenTarget({
      path: row?.egnyteFolderPath || "",
      platform,
      userAgent,
      localRoot: nextRoot,
    });
    if (nextTarget.mobile) {
      setMessage("Egnyte is not available on mobile.");
      return;
    }
    setLocalRoot(nextRoot);
    persistLocalRoot(nextRoot);
    try {
      if (typeof navigator !== "undefined") {
        await navigator.clipboard?.writeText(nextTarget.localPath);
      }
    } catch {
      // Best-effort convenience only; browser clipboard permission varies.
    }
    const helperOpened = await openLocalFolderWithHelper({ localPath: nextTarget.localPath });
    if (helperOpened) {
      setMessage(`Opened ${nextTarget.localPath}`);
      return;
    }
    const pageProtocol = typeof window !== "undefined" ? window.location.protocol : "";
    if (!canAttemptLocalFileOpen(pageProtocol)) {
      setMessage(`Local path copied: ${nextTarget.localPath}`);
      return;
    }
    setMessage(`Opening ${nextTarget.localPath}`);
    const opened = window.open(nextTarget.url, "_blank", "noopener,noreferrer");
    if (!opened) {
      window.location.href = nextTarget.url;
    }
  };

  return createPortal(
    <>
      <div className="overlay" onClick={onClose}/>
      <div ref={dialogRef} className="modal egnyte-action-modal" role="dialog" aria-modal="true" aria-labelledby="egnyte-action-title">
        <div className="modal-head">
          <div className="icon-badge egnyte-badge"><EgnyteLogoMark size={20} linked/></div>
          <div>
            <div className="modal-eyebrow">Linked Egnyte folder</div>
            <h2 className="modal-title" id="egnyte-action-title">{row?.name || "Project"}</h2>
          </div>
          <button className="modal-close" type="button" onClick={onClose} aria-label="Close">
            <Icon name="x" size={16}/>
          </button>
        </div>
        <div className="modal-body egnyte-action-body">
          <div className="egnyte-linked-path">
            <span>Linked path</span>
            <strong className="mono">{row?.egnyteFolderPath}</strong>
          </div>
          <div className="egnyte-local-root">
            <label htmlFor="egnyte-local-root">Local Egnyte root</label>
            <div className="egnyte-local-root-control">
              <input
                id="egnyte-local-root"
                value={localRoot}
                onChange={(e) => setLocalRoot(e.target.value)}
                onBlur={() => persistLocalRoot(localRoot.trim() || defaultLocalRoot)}
              />
              <button className="btn sm" type="button" onClick={resetLocalRoot}>Reset</button>
            </div>
            <span className="mono">{target.mobile ? "Unavailable on mobile" : target.localPath}</span>
          </div>
          <div className="egnyte-action-grid">
            <button type="button" className="egnyte-action-card primary" onClick={openLinkedFolder}>
              <span className="egnyte-action-icon"><Icon name="export" size={18}/></span>
              <strong>Open Egnyte Folder</strong>
              <span>Open the local synced folder path in Finder or File Explorer.</span>
            </button>
            <button type="button" className="egnyte-action-card" onClick={onChangePath}>
              <span className="egnyte-action-icon"><Icon name="edit" size={18}/></span>
              <strong>Change Egnyte Path</strong>
              <span>Choose another folder from PData.</span>
            </button>
          </div>
          {message && (
            <div className="egnyte-action-message">
              <Icon name="warn" size={14}/>
              <span>{message}</span>
            </div>
          )}
        </div>
      </div>
    </>,
    document.body
  );
}

// ---------------------------------------------------------------------------
// File-and-folder picker (Sales opportunities).
// ---------------------------------------------------------------------------
function entryMeta(entry) {
  const bits = [entry.kind === "folder" ? "Folder" : formatEgnyteSize(entry.size)];
  const date = formatEgnyteDate(entry.modified);
  if (date) bits.push(`Modified ${date}`);
  return bits.filter(Boolean).join(" · ");
}

function PickerBody({ initialPath, root, linkedPaths, onCancel, onConfirm }) {
  const { currentPath, folders, files, loading, error, load } = useEgnyteBrowser({ includeFiles: true, initialPath, fallbackPath: root });
  const [selected, setSelected] = useState(null);
  const [search, setSearch] = useState("");
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState("");
  const listRef = useRef(null);

  const navigate = (path) => { setSearch(""); setSaveError(""); load(path); };
  const crumbs = useMemo(() => egnyteBreadcrumbs(currentPath, root), [currentPath, root]);
  const parentPath = currentPath ? egnyteParentPath(currentPath, root) : null;
  const entries = useMemo(() => [...folders, ...files], [folders, files]);
  const visible = useMemo(() => filterEgnyteFolders(entries, search), [entries, search]);
  const searchText = search.trim();
  const currentFolderEntry = currentPath ? {
    kind: "folder",
    path: currentPath,
    name: crumbs[crumbs.length - 1]?.label || currentPath,
  } : null;
  const isLinked = (path) => !!linkedPaths?.has?.(path);

  // Navigating swaps the list out from under the focused row; put focus on
  // the first row of the new listing so keyboard users stay in the list
  // instead of falling back to <body>.
  const refocusRef = useRef(false);
  const navigateFromList = (path) => { refocusRef.current = true; navigate(path); };
  useEffect(() => {
    if (loading || !refocusRef.current) return;
    refocusRef.current = false;
    listRef.current?.querySelector("button")?.focus();
  }, [loading]);

  const confirm = async () => {
    if (!selected) return;
    setSaving(true);
    setSaveError("");
    try {
      await onConfirm(selected);
    } catch (e) {
      setSaveError(e?.message || "The Egnyte item could not be linked.");
      setSaving(false);
    }
  };

  const shownError = saveError || error;

  return (
    <>
      <DialogHeader>
        <DialogTitle className="egx-title"><EgnyteLogoMark size={18} linked/>Link from Egnyte</DialogTitle>
        <DialogDescription>Pick a file or a whole folder. Linking only saves a pointer — nothing in Egnyte is moved or changed.</DialogDescription>
      </DialogHeader>
      <div className="egx-picker-bar">
        <div className="egx-picker-nav">
          <Button size="sm" variant="default" disabled={!parentPath || loading} onClick={() => navigate(parentPath)} aria-label="Up one folder" title="Up one folder">
            <Icon name="back" size={14}/>Up
          </Button>
          <nav className="egx-crumbs" aria-label="Current Egnyte folder">
            {crumbs.length === 0 ? (
              <span className="egx-crumb-placeholder">{loading ? "Loading…" : "Egnyte"}</span>
            ) : (
              <ol>
                {crumbs.map((crumb, i) => (
                  <li key={crumb.path}>
                    {i > 0 && <Icon name="chevronRight" size={12}/>}
                    {i === crumbs.length - 1 ? (
                      <span aria-current="location" title={crumb.path}>{crumb.label}</span>
                    ) : (
                      <button type="button" onClick={() => navigate(crumb.path)} disabled={loading} title={crumb.path}>{crumb.label}</button>
                    )}
                  </li>
                ))}
              </ol>
            )}
          </nav>
          <Button size="icon-sm" variant="ghost" disabled={loading} onClick={() => navigate(currentPath || initialPath)} aria-label="Refresh this folder" title="Refresh">
            <Icon name="refresh" size={14}/>
          </Button>
        </div>
        <InputGroup
          type="search"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder="Filter this folder"
          aria-label="Filter files and folders in this folder"
          leading={<Icon name="search" size={14}/>}
        />
      </div>
      <DialogBody className="egx-picker-body">
        {currentFolderEntry && (
          <div className={"egx-current" + (selected?.path === currentFolderEntry.path ? " is-selected" : "")}>
            <Icon name="folder" size={16}/>
            <span className="egx-current-text">
              <strong title={currentFolderEntry.path}>{currentFolderEntry.name}</strong>
              <span>This folder</span>
            </span>
            {isLinked(currentFolderEntry.path) ? (
              <Badge tone="success" size="sm">Linked</Badge>
            ) : currentFolderEntry.path === root ? null : (
              <Button
                size="xs"
                variant={selected?.path === currentFolderEntry.path ? "primary" : "default"}
                aria-pressed={selected?.path === currentFolderEntry.path}
                onClick={() => setSelected(currentFolderEntry)}
                disabled={loading}>
                {selected?.path === currentFolderEntry.path ? <><Icon name="check" size={12}/>Selected</> : "Select folder"}
              </Button>
            )}
          </div>
        )}
        {shownError && (
          <div className="egx-inline-error" role="alert">
            <Icon name="warn" size={14}/>
            <span>{shownError}</span>
            {error && <Button size="xs" variant="ghost" onClick={() => navigate(currentPath || initialPath)}>Retry</Button>}
          </div>
        )}
        {loading ? (
          <div className="egx-state" role="status">
            <span className="egx-spinner" aria-hidden="true"/>
            <span>Loading Egnyte…</span>
          </div>
        ) : error ? null : entries.length === 0 ? (
          <div className="egx-state">This folder is empty.</div>
        ) : visible.length === 0 ? (
          <div className="egx-state">Nothing here matches “{searchText}”.</div>
        ) : (
          <ul ref={listRef} className="egx-entry-list" aria-label="Files and folders">
            {visible.map((entry) => {
              const active = selected?.path === entry.path;
              const linked = isLinked(entry.path);
              const folder = entry.kind === "folder";
              return (
                <li key={`${entry.kind}:${entry.path}`} className={"egx-entry" + (active ? " is-selected" : "")}>
                  <button
                    type="button"
                    className="egx-entry-main"
                    onClick={() => (folder ? navigateFromList(entry.path) : setSelected(entry))}
                    aria-pressed={folder ? undefined : active}
                    aria-label={folder ? `Open folder ${entry.name}` : `${active ? "Selected" : "Select"} file ${entry.name}`}
                    title={entry.path}>
                    <span className={"egx-entry-icon" + (folder ? " is-folder" : "")}><Icon name={folder ? "folder" : "file"} size={16}/></span>
                    <span className="egx-entry-text">
                      <strong>{entry.name}</strong>
                      <span>{entryMeta(entry)}</span>
                    </span>
                    {folder && <Icon name="chevronRight" size={14}/>}
                  </button>
                  {linked ? (
                    <Badge tone="success" size="sm">Linked</Badge>
                  ) : folder ? (
                    <Button size="xs" variant={active ? "primary" : "default"} aria-pressed={active} onClick={() => setSelected(entry)} aria-label={`Select folder ${entry.name}`}>
                      {active ? <><Icon name="check" size={12}/>Selected</> : "Select"}
                    </Button>
                  ) : active ? (
                    <span className="egx-entry-check" aria-hidden="true"><Icon name="check" size={14}/></span>
                  ) : null}
                </li>
              );
            })}
          </ul>
        )}
      </DialogBody>
      <DialogFooter className="egx-picker-foot">
        <div className="egx-selection" aria-live="polite">
          {selected ? (
            <>
              <Icon name={selected.kind === "folder" ? "folder" : "file"} size={14}/>
              <span title={selected.path}>{selected.path}</span>
            </>
          ) : (
            <span className="egx-selection-empty">Nothing selected</span>
          )}
        </div>
        <Button variant="default" onClick={onCancel} disabled={saving}>Cancel</Button>
        <Button variant="primary" onClick={confirm} disabled={!selected || saving} loading={saving}>
          <Icon name="link" size={14}/>{selected?.kind === "folder" ? "Link folder" : "Link file"}
        </Button>
      </DialogFooter>
    </>
  );
}

export function EgnytePickerDialog({
  open,
  onOpenChange,
  initialPath = DEFAULT_SALES_EGNYTE_PATH,
  root = EGNYTE_SHARED_ROOT,
  linkedPaths,
  onConfirm,
}) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent size="lg" className="egx-picker">
        {open && (
          <PickerBody
            initialPath={initialPath}
            root={root}
            linkedPaths={linkedPaths}
            onCancel={() => onOpenChange?.(false)}
            onConfirm={onConfirm}
          />
        )}
      </DialogContent>
    </Dialog>
  );
}
