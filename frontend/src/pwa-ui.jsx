// pwa-ui.jsx — visual pieces that consume the pwa.js store.
//
//   <PwaInstallChip/>   topbar button: "Install Beacon" → native install prompt
//   <PwaOfflineChip/>   topbar pill:   "Offline" when navigator.onLine===false
//   <PwaUpdateToast/>   floating toast at bottom: "Update available · Refresh"
//   <PwaOfflineBanner/> optional inline banner — currently unused, kept for
//                       feature parity with existing toast patterns.
//
// All three are entirely self-contained — they subscribe to the pwa store
// via usePwa() and render nothing when their state is inert. App.jsx mounts
// <PwaInstallChip/> + <PwaOfflineChip/> in the topbar and <PwaUpdateToast/>
// at the root.

import React from "react";
import { Icon } from "./icons";
import { usePwa, promptInstall, applyUpdate, dismissUpdate } from "./pwa";

// ---------------------------------------------------------------------
// Install chip — visible only when:
//   • browser fired beforeinstallprompt (Chrome/Edge/Android Chrome)
//   • app isn't already installed
// ---------------------------------------------------------------------
export function PwaInstallChip() {
  const { canInstall, installed } = usePwa();
  if (installed || !canInstall) return null;

  const onClick = async () => {
    await promptInstall();
  };

  return (
    <button
      type="button"
      className="pwa-install-chip"
      onClick={onClick}
      title="Install Beacon as an app"
    >
      <Icon name="plus" size={12}/>
      <span className="pwa-install-chip-label">Install</span>
    </button>
  );
}

// ---------------------------------------------------------------------
// Offline pill — shows when the browser thinks we're offline.
// ---------------------------------------------------------------------
export function PwaOfflineChip() {
  const { online } = usePwa();
  if (online) return null;
  return (
    <span className="pwa-offline-chip" role="status" aria-live="polite">
      <span className="pwa-offline-dot"/>
      <span>Offline</span>
    </span>
  );
}

// ---------------------------------------------------------------------
// Update toast — bottom-right corner, "New version available · Refresh".
// "Later" dismisses (the SW keeps waiting; next reload picks it up).
// ---------------------------------------------------------------------
export function PwaUpdateToast() {
  const { needRefresh } = usePwa();
  if (!needRefresh) return null;
  return (
    <div className="pwa-toast" role="alertdialog" aria-labelledby="pwa-toast-title">
      <div className="pwa-toast-body">
        <div className="pwa-toast-icon" aria-hidden="true">
          <Icon name="sparkles" size={14}/>
        </div>
        <div className="pwa-toast-text">
          <div id="pwa-toast-title" className="pwa-toast-title">New version available</div>
          <div className="pwa-toast-sub">Refresh to load the latest Beacon.</div>
        </div>
      </div>
      <div className="pwa-toast-actions">
        <button type="button" className="pwa-toast-btn pwa-toast-btn-ghost" onClick={dismissUpdate}>
          Later
        </button>
        <button type="button" className="pwa-toast-btn pwa-toast-btn-primary" onClick={applyUpdate}>
          Refresh
        </button>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------
// Banner version of offline — useful if the topbar chip is invisible
// because the user has scrolled. Mounts inline above the page. (Unused
// by default; export kept for App.jsx to opt in if desired.)
// ---------------------------------------------------------------------
export function PwaOfflineBanner() {
  const { online } = usePwa();
  if (online) return null;
  return (
    <div className="pwa-offline-banner" role="status">
      <Icon name="ban" size={12}/>
      You're offline. Existing data is visible but saves will fail until you reconnect.
    </div>
  );
}
