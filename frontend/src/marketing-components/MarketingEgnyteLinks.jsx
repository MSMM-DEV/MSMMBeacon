// Sales opportunity → Egnyte links ("Files & History" section).
//
// A FILE link renders as a single row; a FOLDER link renders as a card with a
// lazily-loaded tree of its contents. Links are pointers only: "Unlink"
// deletes the beacon_v2.marketing_egnyte_links row and nothing in Egnyte.
import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Alert, Badge, Button, EmptyState } from "@/ui";
import { Icon } from "../icons.jsx";
import {
  addMarketingEgnyteLink,
  loadEgnyteInfo,
  loadMarketingEgnyteLinks,
  MARKETING_EGNYTE_UNAVAILABLE,
  removeMarketingEgnyteLink,
} from "../data.js";
import { DEFAULT_SALES_EGNYTE_PATH, egnyteParentPath, egnyteShortPath, formatEgnyteSize } from "../egnyte-links.js";
import {
  EgnyteLogoMark,
  EgnytePickerDialog,
  formatEgnyteDate,
  openEgnyteItemLocally,
} from "../egnyte-picker.jsx";
import { EgnyteFolderTree, EgnyteItemActions } from "../egnyte-tree.jsx";

const FolderIcon = (props) => <Icon name="folder" {...props}/>;

function linkMeta(link) {
  if (link.kind === "folder") return "Folder";
  const bits = [formatEgnyteSize(link.sizeBytes)];
  const date = formatEgnyteDate(link.modifiedAt);
  if (date) bits.push(`Modified ${date}`);
  return bits.filter(Boolean).join(" · ") || "File";
}

function UnlinkButton({ link, onUnlink }) {
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  const timer = useRef(null);
  useEffect(() => () => clearTimeout(timer.current), []);
  const click = async () => {
    if (!confirming) {
      setConfirming(true);
      clearTimeout(timer.current);
      timer.current = setTimeout(() => setConfirming(false), 4000);
      return;
    }
    clearTimeout(timer.current);
    setBusy(true);
    try { await onUnlink(link); } finally { setBusy(false); setConfirming(false); }
  };
  return (
    <Button
      size="xs"
      variant={confirming ? "destructive-soft" : "ghost"}
      loading={busy}
      onClick={click}
      onBlur={() => { if (!busy) setConfirming(false); }}
      aria-label={confirming ? `Confirm unlinking ${link.name}. Nothing in Egnyte is deleted.` : `Unlink ${link.name}`}
      title="Removes the link only — nothing in Egnyte is deleted">
      <Icon name="x" size={12}/>{confirming ? "Confirm unlink" : "Unlink"}
    </Button>
  );
}

function LinkLocation({ link }) {
  const parent = egnyteParentPath(link.path, "/") || "/";
  return <span className="egx-link-path" title={link.path}>{egnyteShortPath(parent)}</span>;
}

function FileLink({ link, webBase, onOpenLocal, onUnlink }) {
  return (
    <li className="egx-link is-file">
      <div className="egx-link-head">
        <span className="egx-entry-icon" aria-hidden="true"><Icon name="file" size={16}/></span>
        <span className="egx-link-text">
          <strong title={link.path}>{link.name}</strong>
          <span className="egx-link-sub"><span>{linkMeta(link)}</span><LinkLocation link={link}/></span>
        </span>
        <span className="egx-link-actions">
          <EgnyteItemActions entry={{ ...link, kind: "file" }} webBase={webBase} onOpenLocal={onOpenLocal}/>
          <UnlinkButton link={link} onUnlink={onUnlink}/>
        </span>
      </div>
    </li>
  );
}

function FolderLink({ link, webBase, onOpenLocal, onUnlink }) {
  const [open, setOpen] = useState(true);
  const [refreshKey, setRefreshKey] = useState(0);
  const bodyId = `egx-folder-${link.id}`;
  return (
    <li className="egx-link is-folder">
      <div className="egx-link-head">
        <button
          type="button"
          className="egx-link-toggle"
          aria-expanded={open}
          aria-controls={bodyId}
          onClick={() => setOpen((v) => !v)}
          title={link.path}>
          <span className={"egx-chevron" + (open ? " is-open" : "")} aria-hidden="true"><Icon name="chevronRight" size={13}/></span>
          <span className="egx-entry-icon is-folder" aria-hidden="true"><Icon name="folder" size={16}/></span>
          <span className="egx-link-text">
            <strong>{link.name}</strong>
            <span className="egx-link-sub"><span>Folder</span><LinkLocation link={link}/></span>
          </span>
        </button>
        <span className="egx-link-actions">
          {open && (
            <Button size="icon-sm" variant="ghost" onClick={() => setRefreshKey((k) => k + 1)} aria-label={`Refresh ${link.name}`} title="Refresh folder contents">
              <Icon name="refresh" size={13}/>
            </Button>
          )}
          <EgnyteItemActions entry={{ ...link, kind: "folder" }} webBase={webBase} onOpenLocal={onOpenLocal}/>
          <UnlinkButton link={link} onUnlink={onUnlink}/>
        </span>
      </div>
      <div id={bodyId} hidden={!open} className="egx-link-body">
        {open && <EgnyteFolderTree rootPath={link.path} webBase={webBase} onOpenLocal={onOpenLocal} refreshKey={refreshKey}/>}
      </div>
    </li>
  );
}

export function MarketingEgnyteLinks({ opportunityId, api = {} }) {
  const loadApi = api.load || loadMarketingEgnyteLinks;
  const addApi = api.add || addMarketingEgnyteLink;
  const removeApi = api.remove || removeMarketingEgnyteLink;
  const [links, setLinks] = useState([]);
  const [available, setAvailable] = useState(true);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [pickerOpen, setPickerOpen] = useState(false);
  const [webBase, setWebBase] = useState("");

  const refresh = useCallback(async () => {
    if (!opportunityId) return;
    setLoading(true);
    setError("");
    try {
      const result = await loadApi(opportunityId);
      setLinks(result.links || []);
      setAvailable(result.available !== false);
    } catch (loadError) {
      setError(loadError?.message || "Egnyte links could not be loaded.");
    } finally {
      setLoading(false);
    }
  }, [opportunityId, loadApi]);

  useEffect(() => { refresh(); }, [refresh]);

  // The web domain only matters once there is something to open; fetching it
  // costs no Egnyte API call (the server answers from its own config).
  useEffect(() => {
    if (!links.length || webBase) return;
    let alive = true;
    loadEgnyteInfo().then((info) => { if (alive && info?.webBase) setWebBase(info.webBase); }).catch(() => {});
    return () => { alive = false; };
  }, [links.length, webBase]);

  const linkedPaths = useMemo(() => new Set(links.map((link) => link.path)), [links]);

  const onOpenLocal = useCallback(async (entry) => {
    setNotice("");
    const result = await openEgnyteItemLocally({ path: entry.path, kind: entry.kind });
    setNotice(result.message);
  }, []);

  const onConfirm = async (entry) => {
    const { link, existed } = await addApi({
      opportunityId,
      path: entry.path,
      kind: entry.kind,
      name: entry.name,
      sizeBytes: entry.kind === "file" ? entry.size : null,
      modifiedAt: entry.kind === "file" ? entry.modified : null,
    });
    setLinks((prev) => (existed || prev.some((row) => row.id === link.id) ? prev : [...prev, link]));
    setNotice(existed ? `${link.name} was already linked.` : `Linked ${link.name}.`);
    setPickerOpen(false);
  };

  const onUnlink = async (link) => {
    setError("");
    try {
      await removeApi(link.id);
      setLinks((prev) => prev.filter((row) => row.id !== link.id));
      setNotice(`Unlinked ${link.name}. Nothing in Egnyte was changed.`);
    } catch (removeError) {
      if (removeError?.code === MARKETING_EGNYTE_UNAVAILABLE) setAvailable(false);
      setError(removeError?.message || "The Egnyte link could not be removed.");
    }
  };

  const files = links.filter((link) => link.kind === "file");
  const folders = links.filter((link) => link.kind === "folder");

  return (
    <section className="egx-links" aria-labelledby={`egx-links-title-${opportunityId}`}>
      <header className="egx-group-head">
        <div className="egx-group-title">
          <EgnyteLogoMark size={16} linked={links.length > 0}/>
          <h3 id={`egx-links-title-${opportunityId}`}>Egnyte</h3>
          {links.length > 0 && <Badge tone="neutral" size="sm">{links.length}</Badge>}
        </div>
        {available && (
          <Button size="sm" variant="default" onClick={() => setPickerOpen(true)} disabled={loading}>
            <Icon name="link" size={14}/>Link from Egnyte
          </Button>
        )}
      </header>

      {!available ? (
        <Alert tone="neutral" title="Egnyte linking needs a database update">
          An administrator needs to apply the Sales Egnyte links migration before files and folders can be linked here.
        </Alert>
      ) : (
        <>
          {error && (
            <Alert tone="danger" title="Egnyte action failed">
              {error} <Button size="xs" variant="ghost" onClick={refresh}>Reload links</Button>
            </Alert>
          )}
          {loading ? (
            <div className="egx-state" role="status"><span className="egx-spinner" aria-hidden="true"/>Loading Egnyte links…</div>
          ) : links.length === 0 ? (
            <EmptyState
              compact
              icon={FolderIcon}
              title="No Egnyte links yet"
              description="Link proposal files or the opportunity's working folder from Egnyte. Nothing is copied — links open the live file."
            />
          ) : (
            <ul className="egx-link-list" aria-label="Linked Egnyte items">
              {folders.map((link) => <FolderLink key={link.id} link={link} webBase={webBase} onOpenLocal={onOpenLocal} onUnlink={onUnlink}/>)}
              {files.map((link) => <FileLink key={link.id} link={link} webBase={webBase} onOpenLocal={onOpenLocal} onUnlink={onUnlink}/>)}
            </ul>
          )}
          <p className="egx-notice" aria-live="polite">{notice}</p>
        </>
      )}

      <EgnytePickerDialog
        open={pickerOpen}
        onOpenChange={setPickerOpen}
        initialPath={DEFAULT_SALES_EGNYTE_PATH}
        linkedPaths={linkedPaths}
        onConfirm={onConfirm}
      />
    </section>
  );
}

export default MarketingEgnyteLinks;
