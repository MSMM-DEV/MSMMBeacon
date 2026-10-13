// Lazily-loaded Egnyte folder tree.
//
// Only the root level is fetched up front; every subfolder is fetched the
// first time it is expanded and cached for the life of the component. The
// Egnyte service account shares one API quota across the whole company, so
// the tree never crawls ahead of the user. "Refresh" drops the cache.
//
// Accessibility: nested lists of disclosure buttons (`aria-expanded` +
// `aria-controls`) rather than an ARIA tree, because every row also carries
// its own action buttons — interactive children inside a `treeitem` are not
// reachable by screen-reader tree navigation. ArrowRight / ArrowLeft expand
// and collapse a focused folder, matching tree muscle memory.
import React, { useCallback, useEffect, useId, useRef, useState } from "react";
import { Button } from "@/ui";
import { Icon } from "./icons.jsx";
import { browseEgnyteFolders } from "./data.js";
import { egnyteWebUrl, formatEgnyteSize } from "./egnyte-links.js";
import { formatEgnyteDate } from "./egnyte-picker.jsx";

// Every tree listing — across all folder links on the page — goes through one
// FIFO so expanding several folders quickly can't burst past Egnyte's
// per-second cap (the server also retries a single 429 once).
let browseQueue = Promise.resolve();
function queuedBrowse(path) {
  const run = browseQueue.then(() => browseEgnyteFolders(path, { includeFiles: true }));
  browseQueue = run.catch(() => {});
  return run;
}

function entryMeta(entry) {
  if (entry.kind === "folder") return "";
  const bits = [formatEgnyteSize(entry.size)];
  const date = formatEgnyteDate(entry.modified);
  if (date) bits.push(date);
  return bits.filter(Boolean).join(" · ");
}

export function EgnyteItemActions({ entry, webBase, onOpenLocal, compact = false }) {
  const webUrl = entry.webUrl || egnyteWebUrl(webBase, entry.path);
  const noun = entry.kind === "folder" ? "folder" : "file";
  return (
    <span className="egx-item-actions">
      <Button
        size={compact ? "icon-sm" : "xs"}
        variant="ghost"
        onClick={() => onOpenLocal?.(entry)}
        aria-label={`Open ${noun} ${entry.name} on this computer`}
        title="Open from the synced Egnyte drive">
        <Icon name="export" size={13}/>{compact ? null : "Open"}
      </Button>
      {webUrl ? (
        <a
          className={"egx-web-link" + (compact ? " is-compact" : "")}
          href={webUrl}
          target="_blank"
          rel="noopener noreferrer"
          aria-label={`Open ${noun} ${entry.name} in Egnyte (new tab)`}
          title="Open in Egnyte">
          <Icon name="external" size={13}/>{compact ? null : <span>Open in Egnyte</span>}
        </a>
      ) : null}
    </span>
  );
}

function TreeLevel({ path, depth, state, expanded, toggle, retry, webBase, onOpenLocal, idBase }) {
  const node = state[path];
  if (!node || node.status === "loading") {
    return (
      <div className="egx-tree-status" style={{ "--egx-depth": depth }} role="status">
        <span className="egx-spinner" aria-hidden="true"/>Loading…
      </div>
    );
  }
  if (node.status === "error") {
    return (
      <div className="egx-tree-status is-error" style={{ "--egx-depth": depth }} role="alert">
        <Icon name="warn" size={13}/>
        <span>{node.error}</span>
        <Button size="xs" variant="ghost" onClick={() => retry(path)}>Retry</Button>
      </div>
    );
  }
  const entries = [...(node.folders || []), ...(node.files || [])];
  if (!entries.length) {
    return <div className="egx-tree-status" style={{ "--egx-depth": depth }}>Empty folder</div>;
  }
  return (
    <ul className="egx-tree-list" role="list">
      {entries.map((entry) => {
        const folder = entry.kind === "folder";
        const open = folder && expanded.has(entry.path);
        const groupId = `${idBase}-${encodeURIComponent(entry.path)}`;
        return (
          <li key={`${entry.kind}:${entry.path}`} className="egx-tree-item">
            <div className="egx-tree-row" style={{ "--egx-depth": depth }}>
              {folder ? (
                <button
                  type="button"
                  className="egx-tree-toggle"
                  aria-expanded={open}
                  aria-controls={open ? groupId : undefined}
                  onClick={() => toggle(entry.path)}
                  onKeyDown={(event) => {
                    if (event.key === "ArrowRight" && !open) { event.preventDefault(); toggle(entry.path); }
                    if (event.key === "ArrowLeft" && open) { event.preventDefault(); toggle(entry.path); }
                  }}
                  title={entry.path}>
                  <span className={"egx-chevron" + (open ? " is-open" : "")} aria-hidden="true"><Icon name="chevronRight" size={13}/></span>
                  <span className="egx-entry-icon is-folder" aria-hidden="true"><Icon name="folder" size={15}/></span>
                  <span className="egx-tree-name">{entry.name}</span>
                </button>
              ) : (
                <span className="egx-tree-file" title={entry.path}>
                  <span className="egx-chevron is-spacer" aria-hidden="true"/>
                  <span className="egx-entry-icon" aria-hidden="true"><Icon name="file" size={15}/></span>
                  <span className="egx-tree-name">{entry.name}</span>
                  {entryMeta(entry) && <span className="egx-tree-meta">{entryMeta(entry)}</span>}
                </span>
              )}
              <EgnyteItemActions entry={entry} webBase={webBase} onOpenLocal={onOpenLocal} compact/>
            </div>
            {open && (
              <div id={groupId}>
                <TreeLevel
                  path={entry.path}
                  depth={depth + 1}
                  state={state}
                  expanded={expanded}
                  toggle={toggle}
                  retry={retry}
                  webBase={webBase}
                  onOpenLocal={onOpenLocal}
                  idBase={idBase}
                />
              </div>
            )}
          </li>
        );
      })}
    </ul>
  );
}

export function EgnyteFolderTree({ rootPath, webBase: webBaseProp = "", onOpenLocal, refreshKey = 0 }) {
  const idBase = useId().replace(/:/g, "");
  const [state, setState] = useState({});
  const [expanded, setExpanded] = useState(() => new Set());
  const [webBase, setWebBase] = useState(webBaseProp);
  const stateRef = useRef(state);
  stateRef.current = state;
  const generationRef = useRef(0);

  useEffect(() => { if (webBaseProp) setWebBase(webBaseProp); }, [webBaseProp]);

  const fetchLevel = useCallback(async (path) => {
    const generation = generationRef.current;
    setState((prev) => ({ ...prev, [path]: { status: "loading" } }));
    try {
      const result = await queuedBrowse(path);
      if (generation !== generationRef.current) return;
      if (result.webBase) setWebBase(result.webBase);
      setState((prev) => ({ ...prev, [path]: { status: "ready", folders: result.folders || [], files: result.files || [] } }));
    } catch (error) {
      if (generation !== generationRef.current) return;
      setState((prev) => ({ ...prev, [path]: { status: "error", error: error?.message || "This folder could not be loaded." } }));
    }
  }, []);

  // Root level on mount and on every refresh; a refresh also drops every
  // cached subfolder and collapses the tree so nothing stale stays on screen.
  useEffect(() => {
    if (!rootPath) return;
    generationRef.current += 1;
    setState({});
    setExpanded(new Set());
    fetchLevel(rootPath);
  }, [rootPath, refreshKey, fetchLevel]);

  const expandedRef = useRef(expanded);
  expandedRef.current = expanded;
  const toggle = useCallback((path) => {
    const wasOpen = expandedRef.current.has(path);
    setExpanded((prev) => {
      const next = new Set(prev);
      if (wasOpen) next.delete(path); else next.add(path);
      return next;
    });
    if (!wasOpen) {
      const cached = stateRef.current[path];
      if (!cached || cached.status === "error") fetchLevel(path);
    }
  }, [fetchLevel]);

  return (
    <div className="egx-tree" role="group" aria-label="Linked folder contents">
      <TreeLevel
        path={rootPath}
        depth={0}
        state={state}
        expanded={expanded}
        toggle={toggle}
        retry={fetchLevel}
        webBase={webBase}
        onOpenLocal={onOpenLocal}
        idBase={idBase}
      />
    </div>
  );
}
